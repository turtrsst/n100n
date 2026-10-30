# Integrasi n100n ↔ kantor-rama-ai (KRA)

n100n tidak menyediakan alur tertentu — ia mesin. Anda merakit alur sendiri
(cabang, loop, tunggu, sheet, HTTP) dan KRA tinggal memanggilnya. Dua arah
integrasi di bawah sudah didukung:

```
┌──────────────────┐   POST /api/tugas (x-api-key)     ┌──────────────────┐
│  n100n           │ ────────────────────────────────► │  KRA             │
│  workflow engine │ ◄──────────────────────────────── │  (app + agen)    │
└──────────────────┘   GET /api/tugas?status=selesai   └──────────────────┘
        ▲                                                     │
        └──────────── webhook / API key ◄─────────────────────┘
              (KRA memicu workflow n100n)
```

## 1. Arah KRA → n100n (KRA memicu workflow)

### a. Lewat API key

```bash
curl -X POST -H "x-api-key: $N100N_TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"nama":"Rama","asal":"Klaten"}]}' \
  http://127.0.0.1:5679/api/workflows/3/run
```

Kalau workflow punya node `wait` panjang, pakai mode async supaya request KRA
tidak menggantung:

```bash
curl -X POST -H "x-api-key: $N100N_TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"nama":"Rama"}]}' \
  "http://127.0.0.1:5679/api/workflows/3/run?async=1"
# -> 202 {"execution_id": 41, "poll": "/api/executions/41"}

curl -H "x-api-key: $N100N_TOKEN" "http://127.0.0.1:5679/api/executions/41?wait=1&timeoutMs=120000"
# -> {"status":"success", "output":[...], "runs":[...]}
```

### b. Lewat webhook

Buat workflow dengan trigger **webhook**, isi `path` + aktifkan. Isi `token`
kalau endpoint terbuka ke jaringan. Data masuk ada di `$json.body`.

```bash
curl -X POST "http://127.0.0.1:5679/webhook/kra?token=rahasia" \
  -H "Content-Type: application/json" -d '{"nama":"Rama"}'
```

`?wait=1` → tunggu hasil (pakai node `respond` untuk menentukan balasan);
tanpa itu → 202 `{"accepted":true}`.

### c. Dari PHP di kantor-rama-ai

Kelas siap pakai (gaya KRA: tanpa Composer, curl + fallback streams):
**`clients/kra/kantor-rama-ai/api/lib/KraN100nClient.php`**. Cara pasang ada di
`clients/kra/kantor-rama-ai/README.md`.

```php
require_once __DIR__ . '/api/lib/KraN100nClient.php';

KraN100nClient::status();                                  // cek hidup (tak melempar exception)
KraN100nClient::run(3, [['nama' => 'Rama']], 120);         // workflow pendek, tunggu hasil
$mulai  = KraN100nClient::runAsync(1, [['schedule' => gmdate('c')]]);
$detail = KraN100nClient::waitExecution((int) $mulai['execution_id'], 600);
KraN100nClient::webhook('kra', ['nama' => 'Rama'], true, 'rahasia');
```

Dari HTTP KRA:

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
KRA_FLOW_API_KEY=<kunci acak, samakan dengan KRA_API_KEY di .env n100n>
KRA_FLOW_MODE=template    # template | agent | manual
```

## 2. Arah n100n → KRA (workflow memanggil endpoint KRA)

Bridge generik: `clients/kra/kantor-rama-ai/api/lib/KraFlowBridge.php`
(action `flow-tugas`, `flow-selesai`, `flow-status`). Data disimpan di
`.temp/flow.json` dengan flock — tidak butuh MySQL.

| Method | Endpoint | Balasan minimal |
|---|---|---|
| POST | `?action=flow-tugas` | `{"ok":true,"task_id":"T123","status":"diproses"}` |
| GET | `?action=flow-tugas&status=selesai` | `{"items":[{"task_id":"T123","status":"selesai","hasil":"..."}]}` |
| POST | `?action=flow-selesai` | `{"ok":true,"tugas":{...}}` |
| GET | `?action=flow-status` | ringkasan |

Semua POST wajib mengirim header `x-api-key` = `KRA_FLOW_API_KEY` (env KRA)
= `KRA_API_KEY` (env n100n).

URL tujuan tugas bisa dioverride tanpa menyentuh workflow:

```env
KRA_TUGAS_URL=http://127.0.0.1:8080/api/index.php?action=flow-tugas
KRA_TUGAS_LIST_URL=http://127.0.0.1:8080/api/index.php?action=flow-tugas
```

atau pakai rewrite Apache agar cukup `KRA_BASE_URL` (lihat
`clients/kra/kantor-rama-ai/docs/n100n-integration.md`).

Penting untuk keandalan:

- **Baca body request sebelum membalas error.** Kalau server membalas 503 tanpa
  membaca body, koneksi keep-alive bisa membuat request berikutnya rusak
  (bug nyata yang ditemukan saat menguji `examples/mock-kra.js`).
- Balas **503/429** saat sibuk, bukan 200 dengan `ok:false` — n100n retry
  otomatis (backoff 2x) dan pola loop `wait` tetap menunggu.
- Sertakan `task_id` di balasan POST; tanpa itu alur menganggap tugas belum
  terkirim dan mengirim ulang.

## 3. Kalau KRA dan n100n beda mesin

- n100n mendengarkan `0.0.0.0` (default) → bisa diakses dari mesin lain.
- Pakai `ngrok http 5679` bila KRA di cloud.
- Batasi firewall ke IP KRA, ganti `APP_PASSWORD`/`APP_API_TOKEN` dengan nilai acak
  (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`).
- Jangan menaruh `APP_API_TOKEN` di JavaScript frontend.

## 4. Uji tanpa KRA asli

```bash
node examples/mock-kra.js        # tiruan KRA di :5680
npm run smoke                    # contoh alur end-to-end melawan mock
```
