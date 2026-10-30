# Integrasi n100n (Workflow WOWO)

n100n adalah engine automasi lokal (mirip n8n) yang menjalankan alur "WOWO":
ambil pilar konten → baca topik yang sudah ada → susun prompt → titip tugas ke
Wowo → tunggu → cek hasil → simpan ide.

KRA menyediakan endpoint yang dipanggil n100n, dan sebaliknya KRA bisa memicu
workflow n100n.

## 1. Konfigurasi

Tambahkan ke environment (XAMPP: `setprop` / wrapper Apache, atau `.env` bila ada):

```env
# alamat n100n + token (APP_API_TOKEN dari .env n100n)
KRA_N100N_URL=http://127.0.0.1:5679
KRA_N100N_TOKEN=<APP_API_TOKEN n100n>

# kunci yang dikirim n100n ke endpoint Wowo (harus sama dengan KRA_API_KEY di .env n100n)
KRA_WOWO_API_KEY=<kunci acak>

# cara Wowo menghasilkan ide: template | agent | manual
KRA_WOWO_MODE=template

# khusus mode agent
KRA_WOWO_AGENT=rama

# opsional: file JSON pilar konten (format: [{"id":1,"nama":"Edukasi",...}])
KRA_WOWO_PILAR_FILE=
```

Mode `template` menghasilkan ide contoh secara deterministik supaya alur bisa
diuji tanpa model AI. Setelah model siap, ubah ke `agent` (memakai
`KraAgentChat`) atau `manual` (ide diisi lewat `?action=wowo-selesai`).
Generator kustom bisa dipasang dari kode:

```php
KraWowoBridge::setGenerator(fn(array $tugas): string => KraModelDispatcher::...);
```

## 2. Endpoint yang dipanggil Workflow WOWO

| Method | Endpoint | Balasan |
|---|---|---|
| GET | `api/index.php?action=wowo-pilar` | `{"pilar":[{"id":1,"nama":"Edukasi","deskripsi":"..."}]}` |
| POST | `api/index.php?action=wowo-tugas` | `{"ok":true,"task_id":"T1001","status":"selesai"}` |
| GET | `api/index.php?action=wowo-tugas&status=selesai` | `{"items":[{"task_id":"T1001","status":"selesai","ide":"..."}]}` |
| POST | `api/index.php?action=wowo-selesai` | `{"ok":true,"tugas":{...}}` |

Semua POST wajib menyertakan header `x-api-key: <KRA_WOWO_API_KEY>` (kalau
variabel itu diisi). Data disimpan di `.temp/wowo.json` dengan `flock` — tidak
butuh MySQL, mengikuti pola `KraTaskEngine`.

```bash
curl -H "x-api-key: KUNCI" "http://127.0.0.1:8080/api/index.php?action=wowo-pilar"

curl -X POST -H "x-api-key: KUNCI" -H "Content-Type: application/json" \
  -d '{"agen":"wowo","pilar":"Edukasi","judul":"Edukasi #9","prompt":"Buat 1 ide konten"}' \
  "http://127.0.0.1:8080/api/index.php?action=wowo-tugas"

curl -H "x-api-key: KUNCI" "http://127.0.0.1:8080/api/index.php?action=wowo-tugas&status=selesai"
```

### Menyambungkan URL

`workflows/wowo.json` secara default memanggil `{KRA_BASE_URL}/api/pilar-konten`
dan `/api/tugas`. Pilih salah satu:

**a. Rewrite Apache** (`.htaccess` di root proyek KRA):

```apache
RewriteEngine On
RewriteRule ^api/pilar-konten$ api/index.php?action=wowo-pilar [L,QSA]
RewriteRule ^api/tugas/([A-Za-z0-9_-]+)/selesai$ api/index.php?action=wowo-selesai&task_id=$1 [L,QSA]
RewriteRule ^api/tugas$ api/index.php?action=wowo-tugas [L,QSA]
```

lalu `.env` n100n cukup: `KRA_BASE_URL=http://127.0.0.1:8080`.

**b. Tanpa rewrite** — isi URL penuh di `.env` n100n, tidak perlu ubah workflow:

```env
KRA_PILAR_URL=http://127.0.0.1:8080/api/index.php?action=wowo-pilar
KRA_TUGAS_URL=http://127.0.0.1:8080/api/index.php?action=wowo-tugas
KRA_TUGAS_LIST_URL=http://127.0.0.1:8080/api/index.php?action=wowo-tugas
```

## 3. KRA memicu n100n

| Endpoint | Kegunaan |
|---|---|
| `GET ?action=n100n-status` | status n100n + ringkasan Wowo (tidak pernah 500) |
| `GET ?action=n100n-workflows` | daftar workflow n100n (id, nama, aktif) |
| `POST ?action=n100n-run` | jalankan workflow: `{"workflow_id":1,"mode":"async","wait":true}` |
| `GET ?action=n100n-execution&id=12` | detail eksekusi (log + runs per node) |

`mode=sync` menunggu langsung (cocok untuk workflow pendek). Untuk WOWO pakai
`async` + `wait=true` (default) karena ada node tunggu 15 detik dan 1 menit.

```php
require_once __DIR__ . '/api/lib/KraN100nClient.php';

$mulai  = KraN100nClient::runAsync(1, [['schedule' => gmdate('c')]]);
$detail = KraN100nClient::waitExecution((int) $mulai['execution_id'], 600);
```

## 4. Uji

```bat
php tools/wowo-bridge-test.php          :: uji KraWowoBridge tanpa web server
php -l api/lib/KraN100nClient.php       :: cek sintaks
```

Hasil yang diharapkan: `N/N pemeriksaan lolos`.

Uji ujung-ke-ujung dari sisi n100n (memakai mock KRA):

```bat
cd C:\xampp\htdocs\n100n
node examples/mock-kra.js
npm run smoke
```
