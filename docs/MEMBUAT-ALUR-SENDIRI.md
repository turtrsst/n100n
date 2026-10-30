# Merakit alur sendiri

n100n tidak punya alur bawaan yang mengikat — `workflows/` hanya berisi **contoh**.
Anda merakit alur sesuai kebutuhan app KRA, lalu memicunya dari KRA (API/webhook)
atau dari scheduler.

Panduan ini menjelaskan pola-pola yang tersedia. Contoh lengkapnya ada di
`workflows/contoh-alur-polling.json` (14 node: kirim tugas → tunggu → cek → simpan)
dan `workflows/contoh-webhook.json` (3 node: terima → olah → balas).

## 1. Menambah alur

Tiga cara:

1. **Dari UI** — `+ Workflow`, tambah node, atur koneksi lewat dropdown.
2. **Import JSON** — tombol **Import**, atau `POST /api/workflows/import`.
3. **File di `workflows/`** — otomatis dimuat hanya saat database masih kosong
   (`APP_SEED=0` untuk mematikan).

Struktur minimal:

```json
{
  "name": "Alur saya",
  "trigger": "manual",
  "trigger_cfg": {},
  "nodes": [
    { "id": "n1", "type": "manual", "name": "Mulai", "config": {}, "next": "n2" },
    { "id": "n2", "type": "code",   "name": "Olah",  "config": { "code": "return items;" }, "next": null }
  ]
}
```

## 2. Pola yang sering dipakai

### a. Bercabang (if/else) dan menyatu lagi

```json
{ "id": "cek", "type": "ifElse", "config": { "condition": "$json.status === 'ok'" },
  "next": { "true": "jalurA", "false": "jalurB" } }
```

Dua cabang yang menuju node yang sama otomatis digabung (item di-merge).
Operator siap pakai lewat `conditions`, mis.:

```json
{ "type": "ifElse", "config": {
   "conditions": [
     { "left": "$json.status", "operator": "eq", "right": "selesai" },
     { "left": "$json.hasil",  "operator": "notEmpty" }
   ],
   "combinator": "and"
} }
```

Operator: `eq, neq, gt, gte, lt, lte, contains, notContains, empty, notEmpty, truthy, falsy`.
Nilai `right` dianggap literal kecuali diawali `$` atau `{{ }}`.

### b. Loop (kirim ulang / polling)

Panah kembali cukup ditulis di `next`:

```json
{ "id": "tunggu", "type": "wait", "config": { "ms": 15000 }, "next": "kirim" }
```

Beri penjaga supaya tidak berputar selamanya — dua cara:

- counter di `$vars` pada kondisi ifElse:
  `"!$json.task_id && $vars.coba < 3"` (naikkan `$vars.coba` di node `code`)
- `max_visits` per node (default 100) dan `settings.max_steps` (default 1000);
  `"on_limit": "continue"` membuat node dilewati, bukan menggagalkan alur.

### c. HTTP yang tahan gangguan

```json
{ "type": "http", "config": {
    "method": "POST",
    "url": "{{ $env.KRA_TUGAS_URL }}",
    "headers": { "x-api-key": "{{ $env.KRA_API_KEY }}" },
    "body": { "judul": "{{ $json.judul }}" },
    "retry": 2,              // 5xx/429 & error jaringan diulang dengan backoff
    "retryDelayMs": 1000,
    "allowNon2xx": true,     // gagal -> item {error, status, body}, alur lanjut
    "split": "$json.items",  // pecah balasan jadi banyak item
    "keepEmpty": true        // tetap kirim 1 item kosong walau hasilnya nol
} }
```

### d. Membaca / menulis sheet

```json
{ "type": "sheet", "config": {
    "driver": "{{ $env.CONTOH_SHEET_DRIVER || 'csv' }}",   // csv | google
    "action": "read",                                      // read | append | update | write
    "path": "files/sumber.csv",
    "spreadsheetId": "{{ $env.CONTOH_SUMBER_SHEET_ID }}",
    "range": "Sumber!A1:C",
    "once": true                                           // baca sekali saja
} }
{ "type": "sheet", "config": {
    "action": "append", "once": true,
    "rows": "{{ $items }}",
    "columns": ["dibuat", "task_id", "agen", "judul", "hasil"]
} }
```

Driver `google` memakai service account (`GOOGLE_SA_JSON`), tanpa dependency.

### e. Menerima panggilan dari app KRA (webhook)

```json
{ "trigger": "webhook", "trigger_cfg": { "path": "kra", "method": "POST", "wait": true, "token": "rahasia" } }
```

Data masuk: `$json.body`, `$json.query`, `$json.headers`, `$json.method`.
Pakai node `respond` untuk menentukan status + body balasan.

### f. Berkala (scheduler)

```json
{ "trigger": "schedule", "trigger_cfg": { "mode": "weekly", "days": [1], "at": "07:00", "timezone": "Asia/Jakarta" } }
```

Mode lain: `{"mode":"interval","every_minutes":15}`, `{"mode":"daily","at":"07:00"}`.

## 3. Variabel yang tersedia

| Variabel | Isi |
|---|---|
| `$json` | item saat ini |
| `$items` | semua item yang masuk node ini |
| `$node['Nama Node']` | output node lain pada eksekusi ini |
| `$vars` | variabel bebas per eksekusi (counter, flag) |
| `$env` | environment variable |
| `$now`, `$today` | waktu ISO / tanggal |
| `$workflow`, `$execution` | id & nama |

Di node `code`, semua tersedia sebagai parameter; `console.log` masuk ke log.

## 4. Memanggil alur dari KRA

```php
require_once __DIR__ . '/api/lib/KraN100nClient.php';

$mulai  = KraN100nClient::runAsync($workflowId, [['sumber' => 'kra']]);
$detail = KraN100nClient::waitExecution((int) $mulai['execution_id'], 600);
```

atau lewat webhook (paling ringan untuk app KRA):

```php
KraN100nClient::webhook('kra', ['nama' => 'Rama'], wait: true, webhookToken: 'rahasia');
```

Detail kontrak dua arah: `docs/KRA-INTEGRATION.md`.

## 5. Menelusuri masalah

- Tab **Eksekusi terakhir** → klik baris → lihat log per langkah + `runs`
  (masuk, keluar, ms, putaran ke berapa).
- Node di graf diberi warna: hijau sukses, oranye diputar >1x, merah error.
- `APP_DEBUG=1 node --env-file=.env server.js` → dump output tiap node ke konsol.
- `POST /api/workflows/:id/validate` untuk mengecek `next` yang menunjuk node hilang.
