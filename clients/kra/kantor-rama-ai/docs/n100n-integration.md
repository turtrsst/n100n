# Integrasi n100n ke KRA

n100n adalah engine automasi lokal (mirip n8n) tanpa dependency. KRA tidak
mengikat diri ke satu alur: Anda merakit alur di n100n (cabang, loop, tunggu,
HTTP, sheet), lalu KRA memicunya. Dua arah yang tersedia:

- **KRA → n100n**: jalankan workflow lewat API key atau webhook.
- **n100n → KRA**: workflow menitipkan tugas ke antrean KRA (`KraFlowBridge`).

## 0. Memasang ke repo KRA

Dari folder paket `clients/kra/kantor-rama-ai`:

```bash
node pasang.js "C:\xampp\htdocs\kantor-rama-ai" --check   # periksa dulu
node pasang.js "C:\xampp\htdocs\kantor-rama-ai"           # terapkan
```

Skrip ini menyalin 4 berkas dan menyisipkan 2 `require_once` + 8 action ke
`api/index.php` (idempoten, membuat `api/index.php.bak-n100n`). Alternatif:
`git apply patches/0001-flow-bridge-kra-049ded0b.patch` (branch 049ded0b) atau
`patches/0001-n100n-flow-bridge.patch` (main).

## 1. Konfigurasi

Tambahkan ke environment KRA (XAMPP: wrapper Apache/`setprop`, atau `.env` bila ada):

```env
# alamat n100n + token (APP_API_TOKEN dari .env n100n)
KRA_N100N_URL=http://127.0.0.1:5679
KRA_N100N_TOKEN=<APP_API_TOKEN n100n>

# kunci yang dikirim n100n ke endpoint KRA (samakan dengan KRA_API_KEY di .env n100n)
KRA_FLOW_API_KEY=<kunci acak>

# cara KRA mengerjakan tugas: template | agent | manual
KRA_FLOW_MODE=template

# khusus mode agent
KRA_FLOW_AGENT=rama

# opsional: file JSON kategori (format: [{"id":1,"nama":"Riset","deskripsi":"..."}])
KRA_FLOW_KATEGORI_FILE=
```

Mode `template` mengisi hasil secara deterministik supaya alur bisa diuji tanpa
model AI. Setelah model siap, pindah ke `agent` (memakai `KraAgentChat`) atau
`manual` (hasil diisi lewat `POST ?action=flow-selesai`). Generator kustom:

```php
KraFlowBridge::setGenerator(fn(array $tugas): string => KraModelDispatcher::...);
```

## 2. Endpoint antrean tugas (dipanggil workflow n100n)

| Method | Endpoint | Balasan |
|---|---|---|
| POST | `api/index.php?action=flow-tugas` | `{"ok":true,"task_id":"T1001","status":"selesai"}` |
| GET | `api/index.php?action=flow-tugas&status=selesai&agen=agen-1` | `{"items":[{"task_id":"T1001","status":"selesai","hasil":"..."}]}` |
| POST | `api/index.php?action=flow-selesai` | `{"ok":true,"tugas":{...}}` |
| GET | `api/index.php?action=flow-kategori` | `{"kategori":[...]}` |
| GET | `api/index.php?action=flow-status` | ringkasan (total, diproses, selesai, mode) |

Payload POST bebas; yang wajib hanya `prompt`. Field yang dikenali: `judul`,
`agen`, `kategori`, `gaya`, `maks_kata`, `meta` (objek apa pun, disimpan apa
adanya). Semua POST wajib header `x-api-key: <KRA_FLOW_API_KEY>` bila variabel
itu diisi. Data disimpan di `.temp/flow.json` dengan `flock` — tidak butuh
MySQL, mengikuti pola `KraTaskEngine`.

```bash
curl -H "x-api-key: KUNCI" "http://127.0.0.1:8080/api/index.php?action=flow-kategori"

curl -X POST -H "x-api-key: KUNCI" -H "Content-Type: application/json" \
  -d '{"agen":"agen-1","kategori":"Riset","judul":"Riset #9","prompt":"Ringkas 3 poin","meta":{"asal":"n100n"}}' \
  "http://127.0.0.1:8080/api/index.php?action=flow-tugas"

curl -H "x-api-key: KUNCI" "http://127.0.0.1:8080/api/index.php?action=flow-tugas&status=selesai"
```

### Menyambungkan URL

`workflows/contoh-alur-polling.json` memanggil `{{ $env.KRA_TUGAS_URL }}` dan
`{{ $env.KRA_TUGAS_LIST_URL }}`. Pilih salah satu:

**a. Rewrite Apache** (`.htaccess` di root proyek KRA):

```apache
RewriteEngine On
RewriteRule ^api/tugas/([A-Za-z0-9_-]+)/selesai$ api/index.php?action=flow-selesai&task_id=$1 [L,QSA]
RewriteRule ^api/tugas$ api/index.php?action=flow-tugas [L,QSA]
RewriteRule ^api/kategori$ api/index.php?action=flow-kategori [L,QSA]
```

lalu `.env` n100n cukup sebaris:

```env
KRA_TUGAS_URL=http://127.0.0.1:8080/api/tugas
KRA_TUGAS_LIST_URL=http://127.0.0.1:8080/api/tugas
```

**b. Tanpa rewrite** — isi URL penuh, workflow tidak perlu diubah:

```env
KRA_TUGAS_URL=http://127.0.0.1:8080/api/index.php?action=flow-tugas
KRA_TUGAS_LIST_URL=http://127.0.0.1:8080/api/index.php?action=flow-tugas
```

Catatan penting untuk endpoint POST: **baca `php://input` sebelum membalas
error**. Kalau balasan error dikirim tanpa membaca body, koneksi keep-alive bisa
membuat request berikutnya rusak (n100n mengulang kirim dengan koneksi yang sama).

## 3. KRA memicu n100n

| Endpoint | Kegunaan |
|---|---|
| `GET ?action=n100n-status` | status n100n + ringkasan antrean (tidak pernah 500) |
| `GET ?action=n100n-workflows` | daftar workflow n100n (id, nama, aktif, trigger) |
| `POST ?action=n100n-run` | jalankan workflow: `{"workflow_id":1,"mode":"async","wait":true}` |
| `GET ?action=n100n-execution&id=12` | detail eksekusi (log + runs per node) |

`mode=sync` menunggu langsung (cocok untuk workflow pendek). Untuk workflow yang
punya node `wait`, pakai `async` + `wait=true` (default) supaya request PHP tidak
menggantung tanpa batas.

```php
require_once __DIR__ . '/api/lib/KraN100nClient.php';

$mulai  = KraN100nClient::runAsync(1, [['schedule' => gmdate('c')]]);
$detail = KraN100nClient::waitExecution((int) $mulai['execution_id'], 600);
```

## 4. Uji

```bat
php tools/flow-bridge-test.php          :: uji KraFlowBridge tanpa web server
php -l api/lib/KraN100nClient.php       :: cek sintaks
```

Hasil yang diharapkan: `N/N pemeriksaan lolos`.

Uji ujung-ke-ujung dari sisi n100n (memakai mock KRA):

```bat
cd C:\xampp\htdocs\n100n
node examples/mock-kra.js
npm run smoke
```
