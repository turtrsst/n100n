# n100n — local automation engine (n8n-like)

Engine automasi mandiri, zero dependency: Node.js built-in `http`, `sqlite`, `vm`, `fetch`.
Tanpa Docker, tanpa `npm install`. Menjalankan workflow bergaya n8n — termasuk
**percabangan (if/else), loop, sheet, webhook, scheduler, dan sub-workflow**.

Engine berbasis **graf** (node + `next`): percabangan, loop, tunggu, HTTP dengan
retry, sheet, webhook, scheduler, sub-workflow. **Alurnya Anda rakit sendiri** —
`workflows/` hanya berisi contoh pola, bukan alur jadi milik siapa pun.

- [`docs/MEMBUAT-ALUR-SENDIRI.md`](docs/MEMBUAT-ALUR-SENDIRI.md) — resep pola:
  cabang, loop-polling, HTTP tahan gangguan, sheet, webhook, scheduler.
- [`docs/KRA-INTEGRATION.md`](docs/KRA-INTEGRATION.md) — kontrak dua arah dengan kantor-rama-ai.
- [`clients/kra/kantor-rama-ai`](clients/kra/kantor-rama-ai) — kelas PHP + patch siap
  tempel di repo KRA (`git apply patches/0001-n100n-flow-bridge.patch`).

## Jalankan

```bat
cd C:\xampp\htdocs\n100n
node --env-file=.env server.js
```

Buka `http://localhost:5679`. Password admin ada di `.env` (`APP_PASSWORD`). Data di `data\n100n.db`.
Saat pertama kali dijalankan (database kosong), semua file `workflows/*.json`
dimuat sebagai contoh: `contoh-alur-polling.json` (kirim tugas → tunggu → cek
hasil → simpan) dan `contoh-webhook.json` (terima → olah → balas).
Matikan dengan `APP_SEED=0`, atau hapus saja contohnya dari UI.
Contoh webhook dimuat **nonaktif** — nyalakan toggle **Aktif** dulu, kalau tidak
`/webhook/contoh` menjawab 404.

Autostart saat boot (jalankan CMD sebagai Administrator, sekali saja):

```bat
schtasks /create /tn "n100n" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=C:\xampp\htdocs\n100n\.env C:\xampp\htdocs\n100n\server.js" /sc onstart /ru SYSTEM /f
```

Stop service: `schtasks /end /tn n100n`, hapus: `schtasks /delete /tn n100n /f`.

## Konsep

Workflow = daftar node. Data mengalir sebagai **array item** (seperti n8n).

```json
{
  "id": "n8",
  "type": "ifElse",
  "name": "Tugas Terkirim?",
  "config": { "condition": "!$json.task_id" },
  "next": { "true": "n9", "false": "n10" }
}
```

- `next` kosong → lanjut ke node berikutnya di array (cara lama tetap jalan).
- `next: "n3"` → semua item ke node `n3`.
- `next: { "true": "n9", "false": "n10" }` → ikut cabang output node.
- `next: null` → alur selesai di node ini.
- Dua cabang yang menuju node sama otomatis digabung (merge item).

### UI

Halaman `http://localhost:5679` menyediakan:

- **Pratinjau graf** (3 baris × 5 node bila panjang) dengan panah cabang dan panah
  loop bergaris putus-putus berlabel `ulang` — meniru tampilan n8n di screenshot.
- **Editor koneksi visual** per node: pilih output (`main` / `true` / `false` / bebas)
  dan node tujuan lewat dropdown, `+ cabang`, atau kembali ke mode otomatis.
- **Log live** saat **Run async**, plus pewarnaan node di graf: hijau = sukses,
  oranye = diputar lebih dari sekali (loop), merah = error, lengkap dengan badge `×N`.
- Import / Export / Cek alur, dan detail tiap node per eksekusi (masuk, keluar, ms, putaran).

### Node

| Node | Fungsi |
|---|---|
| `manual` / `webhook` / `schedule` / `trigger` | penanda trigger (passthrough) |
| `noop` | lewatkan data (tempat menyimpan setelan) |
| `set` | tambah/ubah field: `{"fields":{"total":"{{ $json.qty * $json.price }}"}}` |
| `if` | filter item (satu arah): `{"condition":"$json.ok === true","invert":false}` |
| `ifElse` | **dua cabang** `true`/`false`; juga `conditions:[{left,operator,right}]` |
| `switch` | banyak cabang: `{"rules":[{"output":"ide","condition":"..."}],"fallback":"lain"}` |
| `code` | JS; dapat `items`, `$env`, `$now`, `$workflow`, `$vars`, `$json`, `$node`, `console.log` |
| `http` | request HTTP: `retry`, `retryDelayMs`, `allowNon2xx`, `split`, `keepEmpty`, `each`, `delayMs`, `query`, `fullResponse` |
| `sheet` | Google Sheets (`driver:"google"`) atau CSV (`driver:"csv"`): `read` / `append` / `update` / `write` |
| `telegram` | kirim pesan; default token/chat dari `$env.TELEGRAM_TOKEN` / `$env.TELEGRAM_CHAT_ID` |
| `file` | `read` / `write` / `append` / `exists` file lokal (vault KRA) |
| `delay` / `wait` | jeda `ms` (maks 10 menit) |
| `workflow` | jalankan sub-workflow (`workflow_id`) |
| `respond` | tentukan response webhook (`status`, `body`) |
| `stop` | hentikan cabang |
| `log` | tulis pesan ke log eksekusi |

Opsi per node: `onError: "continue"` (lanjut walau gagal, item dapat field `error`),
`max_visits` + `on_limit: "continue"`, dan `config.once` (jalankan sekali walau banyak item).

Template tersedia di semua field config: `{{ $json.field }}`, `{{ $items.length }}`,
`{{ $env.NAMA }}`, `{{ $vars.hitung }}`, `{{ $node['Nama Node'] }}`, `{{ $now }}`,
`{{ $workflow.name }}`, `{{ $execution.id }}`. Kalau seluruh nilai berupa `{{ ... }}`,
hasilnya objek/array mentah (bukan string).

## Trigger

- **webhook**: `POST http://localhost:5679/webhook/<path>`.
  Body masuk sebagai `$json.body`, query `$json.query`. Isi `token` di trigger lalu
  kirim header `x-webhook-token` (atau `?token=`) untuk mengamankan endpoint.
  `?wait=1` (atau `trigger_cfg.wait`) = tunggu hasil + pakai node `respond`;
  `?async=1` = langsung balas 202.
- **schedule**: tiga mode, semuanya mendukung zona waktu (default `Asia/Jakarta`):
  - `{"mode":"interval","every_minutes":15}`
  - `{"mode":"daily","at":"07:00"}`
  - `{"mode":"weekly","days":[1],"at":"07:00"}` → Senin 07:00
- **manual**: tombol Run di UI atau `POST /api/workflows/:id/run`.

## Error handling

Isi kolom **Error workflow** di workflow utama → saat gagal, workflow itu dijalankan
dengan item `{workflow_id, workflow, execution_id, error}`. Isi dengan notifikasi
Telegram untuk alert otomatis. Untuk node yang boleh gagal sendiri, pakai
`onError: "continue"`.

## Throttle (jangan banting CPU)

- `http` / `telegram` / `file` dengan `each:true` + `delayMs: 50` → jeda antar item.
- `wait` / `delay` di antara tahap.
- `APP_MAX_PARALLEL` (default 2) membatasi eksekusi bersamaan.
- `max_steps` / `max_visits` mencegah loop tak berujung menghabiskan CPU.

## API

Auth: header `x-api-key: <APP_API_TOKEN>` dari `.env`, atau cookie login.

```bat
curl -H "x-api-key: TOKEN" http://localhost:5679/api/workflows
curl -X POST -H "x-api-key: TOKEN" -H "Content-Type: application/json" ^
  -d "{\"items\":[{\"note\":\"hello\"}]}" ^
  http://localhost:5679/api/workflows/1/run
curl -H "x-api-key: TOKEN" "http://localhost:5679/api/executions?workflow_id=1"
```

| Endpoint | Kegunaan |
|---|---|
| `GET /api/health` | status mesin (publik, tanpa auth) |
| `GET /api/workflows` · `POST /api/workflows` | daftar / buat |
| `GET/PUT/DELETE /api/workflows/:id` | detail / ubah / hapus |
| `GET /api/workflows/:id/export` | unduh definisi JSON |
| `POST /api/workflows/import` | impor definisi (objek atau array) |
| `POST /api/workflows/:id/validate` | cek `next`/tipe node |
| `POST /api/workflows/:id/toggle` | aktif/nonaktif |
| `POST /api/workflows/:id/run` | jalankan (`?async=1` untuk latar belakang) |
| `GET /api/executions[?workflow_id=&status=&limit=]` | riwayat |
| `GET /api/executions/:id[?wait=1&timeoutMs=120000]` | detail + log + runs per node |
| `GET /api/nodes` | daftar tipe node |
| `ALL /webhook/:path` | trigger webhook |

## Testing

```bat
npm test                 :: seluruh test (engine, API, dan contoh alur end-to-end)
node examples/mock-kra.js :: tiruan API KRA untuk uji lokal
npm run smoke            :: contoh alur end-to-end melawan mock KRA
```

Tidak ada dependency: cukup Node 22.5+ (`node:sqlite`).

## Akses dari luar

Aplikasi ini plain HTTP. Untuk webhook publik: `ngrok http 5679`.
Batasi: password admin lemah = seluruh workflow bisa diubah siapa pun — ganti
`APP_PASSWORD` di `.env` jadi panjang/acak, dan isi `APP_API_TOKEN`.
Login dibatasi 5 percobaan gagal per IP (60 detik).

## Update & backup

- Backup: copy `data\n100n.db` (semua workflow + riwayat) — hentikan app dulu.
- Update kode: ganti file, restart (`schtasks /end /tn n100n` lalu `/run`).
- Migrasi otomatis: kolom baru (`settings`, `runs`) ditambahkan saat start.

## Batasan (sengaja, agar tetap kecil)

Tidak ada: canvas drag-drop interaktif (tersedia pratinjau graf read-only),
credential vault terenkripsi, eksekusi paralel antar cabang (antrian tetap
berurutan, hasilnya sama), retry per item pada node non-HTTP.
