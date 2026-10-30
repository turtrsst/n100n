# n100n — local automation engine (n8n-like)

Engine automasi mandiri, zero dependency: Node.js built-in `http`, `sqlite`, `vm`, `fetch`. Tanpa Docker, tanpa npm install.

## Jalankan

```bat
cd C:\xampp\htdocs\n100n
node --env-file=.env server.js
```

Buka `http://localhost:5679`. Password admin ada di `.env` (`APP_PASSWORD`). Data di `data\n100n.db`.

Autostart saat boot (jalankan CMD sebagai Administrator, sekali saja):

```bat
schtasks /create /tn "n100n" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=C:\xampp\htdocs\n100n\.env C:\xampp\htdocs\n100n\server.js" /sc onstart /ru SYSTEM /f
```

Stop service: `schtasks /end /tn n100n`, hapus: `schtasks /delete /tn n100n /f`.

## Konsep

Workflow = daftar node berurutan. Data mengalir sebagai **array item** (seperti n8n). Tiap node menerima items, mengembalikan items.

| Node | Fungsi |
|---|---|
| `manual` / `webhook` / `schedule` | penanda trigger (passthrough) |
| `set` | tambah/ubah field: `{"fields":{"total":"{{ $json.qty * $json.price }}"}}` |
| `if` | filter item: `{"condition":"$json.ok === true","invert":false}` |
| `code` | JS `return items.map(...)`; dapat `items`, `$env`, `$now`, `$workflow`, `console.log` |
| `http` | request HTTP; `each:true` = sekali per item, `delayMs` = throttle antar item |
| `telegram` | kirim pesan; default token/chat dari `$env.TELEGRAM_TOKEN` / `$env.TELEGRAM_CHAT_ID` |
| `file` | `read` / `write` / `append` file lokal (vault KRA) |
| `delay` | jeda `ms` |
| `workflow` | jalankan sub-workflow (`workflow_id`), output-nya jadi input lanjutan |
| `respond` | tentukan response webhook (`status`, `body`) |
| `stop` | hentikan alur |
| `trigger` | alias trigger |

Template tersedia di semua field config: `{{ $json.field }}`, `{{ $items.length }}`, `{{ $env.NAMA }}`, `{{ $now }}`, `{{ $workflow.name }}`, `{{ $execution.id }}`. Kalau seluruh nilai berupa `{{ ... }}`, hasilnya objek/array mentah (bukan string).

## Trigger

- **webhook**: `POST http://localhost:5679/webhook/<path>`. Body masuk sebagai `$json.body`, query `$json.query`. Tambah `?wait=1` (atau `trigger_cfg.wait=true`) untuk tunggu hasil + pakai node `respond`.
- **schedule**: `every_minutes` (cek tiap 20 detik). Item pertama `{ "schedule": "<iso>" }`.
- **manual**: tombol Run di UI atau `POST /api/workflows/:id/run`.

## Error handling

Isi kolom **Error workflow** di workflow utama → saat gagal, workflow itu dijalankan dengan item `{workflow_id, workflow, execution_id, error}`. Isi dengan notifikasi Telegram untuk alert otomatis.

## Throttle (jangan banting CPU)

- `http` / `telegram` / `file` dengan `each:true` + `delayMs: 50` → jeda antar item.
- `delay` node di antara tahap.
- `APP_MAX_PARALLEL` (default 2) membatasi eksekusi bersamaan.

## API (untuk integrasi KRA)

Auth: header `x-api-key: <APP_API_TOKEN>` dari `.env`, atau cookie login.

```bat
curl -H "x-api-key: TOKEN" http://localhost:5679/api/workflows
curl -X POST -H "x-api-key: TOKEN" -H "Content-Type: application/json" ^
  -d "{\"items\":[{\"note\":\"hello\"}]}" ^
  http://localhost:5679/api/workflows/1/run
curl -H "x-api-key: TOKEN" "http://localhost:5679/api/executions?workflow_id=1"
```

Endpoint: `GET/POST /api/workflows`, `GET/PUT/DELETE /api/workflows/:id`, `POST /api/workflows/:id/run`, `GET /api/executions[?workflow_id=]`, `GET /api/executions/:id`, `GET /api/health`, `POST /api/login`, `ALL /webhook/:path`.

## Akses dari luar

Aplikasi ini plain HTTP. Untuk webhook publik: `ngrok http 5679` (ngrok sudah terpasang di server). Batasi: password admin lemah = seluruh workflow bisa diubah siapa pun — ganti `APP_PASSWORD` di `.env` jadi panjang/acak.

## Update & backup

- Backup: copy `data\n100n.db` (semua workflow + riwayat) — hentikan app dulu.
- Update kode: ganti file, restart (`schtasks /end /tn n100n` lalu `/run`).
- Versi node yang dipakai: Node 22.5+ (`node:sqlite`).

## Batasan (sengaja, agar tetap kecil)

Tidak ada: canvas drag-drop, credential vault terenkripsi, branching paralel (`if` hanya filter), retry otomatis per node, import/export file workflow dari UI. Tambah kalau benar-benar perlu.
