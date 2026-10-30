# Integrasi n100n ↔ kantor-rama-ai (KRA)

Dua arah integrasi, keduanya sudah didukung n100n v1.1:

```
┌──────────────────┐   POST /api/tugas (x-api-key)     ┌──────────────────┐
│  n100n (WOWO)    │ ────────────────────────────────► │  KRA             │
│  workflow engine │ ◄──────────────────────────────── │  (Wowo agent)    │
└──────────────────┘   GET /api/tugas?status=selesai   └──────────────────┘
        ▲                                                     │
        └──────────── webhook / API key ◄─────────────────────┘
              (KRA memicu workflow n100n)
```

## 1. Arah KRA → n100n (KRA memicu workflow)

### a. Lewat API key (paling sederhana, tanpa perlu aktifkan workflow)

```bash
curl -X POST -H "x-api-key: $N100N_TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"nama":"Rama","asal":"Klaten"}]}' \
  http://127.0.0.1:5679/api/workflows/3/run
```

Kalau workflow punya `wait` panjang (mis. WOWO yang menunggu 15 detik / 1 menit),
pakai mode async supaya request KRA tidak menggantung:

```bash
curl -X POST -H "x-api-key: $N100N_TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"nama":"Rama"}]}' \
  "http://127.0.0.1:5679/api/workflows/3/run?async=1"
# -> 202 {"execution_id": 41, "poll": "/api/executions/41"}

curl -H "x-api-key: $N100N_TOKEN" "http://127.0.0.1:5679/api/executions/41?wait=1&timeoutMs=120000"
# -> {"status":"success", "output":[...], "runs":[...]}
```

### b. Lewat webhook (dipanggil dari frontend/form/KRA apa pun)

Buat workflow dengan trigger **webhook**, `path=kra`, `method=POST`, aktifkan,
lalu isi `token` di tab trigger kalau endpoint terbuka ke jaringan:

```bash
curl -X POST "http://127.0.0.1:5679/webhook/kra?token=rahasia" \
  -H "Content-Type: application/json" -d '{"nama":"Rama"}'
```

Di dalam workflow, data masuk ada di `$json.body`, query di `$json.query`.

- `?wait=1` → tunggu hasil; kalau workflow punya node `respond`, body node itulah
  yang dikembalikan (status, header) ke pemanggil.
- tanpa `wait=1` → 202 `{"accepted":true}` (fire and forget).

### c. Dari PHP di kantor-rama-ai (KRA)

Sudah tersedia kelas khusus yang mengikuti gaya KRA (tanpa Composer, curl +
fallback streams): **`clients/kra/kantor-rama-ai/api/lib/KraN100nClient.php`**.
Lihat `clients/kra/kantor-rama-ai/README.md` untuk cara memasang (patch atau copy).

```php
require_once __DIR__ . '/api/lib/KraN100nClient.php';

KraN100nClient::status();                                  // cek hidup (tak melempar exception)
KraN100nClient::run(3, [['nama' => 'Rama']], 120);         // workflow pendek, tunggu hasil
$mulai  = KraN100nClient::runAsync(1, [['schedule' => gmdate('c')]]);
$detail = KraN100nClient::waitExecution((int) $mulai['execution_id'], 600);
KraN100nClient::webhook('kra', ['nama' => 'Rama'], true, 'rahasia');
```

Lalu dari HTTP KRA:

```
GET  api/index.php?action=n100n-status
GET  api/index.php?action=n100n-workflows
POST api/index.php?action=n100n-run          {"workflow_id":1,"mode":"async","wait":true}
GET  api/index.php?action=n100n-execution&id=12
```

`.env` KRA:

```env
KRA_N100N_URL=http://127.0.0.1:5679
KRA_N100N_TOKEN=<APP_API_TOKEN dari .env n100n>
KRA_WOWO_API_KEY=<kunci acak, samakan dengan KRA_API_KEY di .env n100n>
KRA_WOWO_MODE=template    # template | agent | manual
```

## 2. Arah n100n → KRA (WOWO memanggil endpoint KRA)

Implementasinya sudah jadi di `clients/kra/kantor-rama-ai/api/lib/KraWowoBridge.php`
plus action baru di `api/index.php` (lihat patch). Data disimpan di
`.temp/wowo.json` dengan flock — tidak butuh MySQL.

| Method | Path | Dipakai node | Balasan minimal |
|---|---|---|---|
| GET | `/api/pilar-konten` | Ambil Pilar Konten | `{"pilar":[{"id":1,"nama":"Edukasi","deskripsi":"..."}]}` |
| POST | `/api/tugas` | Beri Tugas ke Wowo | `{"task_id":"T123","status":"diproses"}` |
| GET | `/api/tugas?agen=wowo&status=selesai` | Cek Daftar Tugas | `{"items":[{"task_id":"T123","status":"selesai","ide":"..."}]}` |

Semua endpoint WAJIB menyocokkan header `x-api-key` dengan `KRA_WOWO_API_KEY`
(env KRA) = `KRA_API_KEY` (env n100n).

URL-nya bisa dioverride tanpa menyentuh workflow:

```env
KRA_PILAR_URL=http://127.0.0.1:8080/api/index.php?action=wowo-pilar
KRA_TUGAS_URL=http://127.0.0.1:8080/api/index.php?action=wowo-tugas
KRA_TUGAS_LIST_URL=http://127.0.0.1:8080/api/index.php?action=wowo-tugas
```

atau pakai rewrite Apache supaya cukup set `KRA_BASE_URL` (lihat
`clients/kra/kantor-rama-ai/docs/n100n-integration.md`).

Penting untuk keandalan:

- **Baca body request sebelum membalas error.** Kalau server membalas 503 tanpa
  membaca body, koneksi keep-alive bisa membuat request berikutnya rusak
  (ini bug nyata yang ditemukan saat pengujian `examples/mock-kra.js`).
- Balas **503/429** saat agen sibuk, bukan 200 dengan `ok:false` — n100n akan
  retry otomatis (backoff 2x) dan loop `Tugas Terkirim?` menunggu 15 detik.
- Sertakan `task_id` di balasan POST; tanpa itu WOWO menganggap tugas belum
  terkirim dan mengirim ulang.

## 3. Kalau KRA dan n100n beda mesin

- n100n dengarkan `0.0.0.0` (default) → bisa diakses dari mesin lain.
- Pakai `ngrok http 5679` bila KRA di cloud.
- Batasi firewall ke IP KRA, ganti `APP_PASSWORD`/`APP_API_TOKEN` dengan nilai acak
  (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`).
- Jangan pernah menaruh `APP_API_TOKEN` di JavaScript frontend.

## 4. Uji tanpa KRA asli

```bash
node examples/mock-kra.js        # tiruan KRA di :5680
npm run smoke                    # jalankan WOWO end-to-end melawan mock
```
