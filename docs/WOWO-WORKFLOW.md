# Workflow WOWO — pemetaan dari screenshot n8n ke n100n

Definisi siap pakai: `workflows/wowo.json` (otomatis dimuat saat database masih kosong,
atau impor lewat tombol **Import** di UI).

| # | Node di screenshot | Node n100n | Catatan |
|---|---|---|---|
| 1 | Tap Senin 07:00 | `schedule` | `mode=weekly, days=[1], at=07:00, timezone=Asia/Jakarta` |
| 2 | Pengaturan | `noop` | isi setelan di `config` (gaya, jumlah kata, pilar default) |
| 3 | Ambil Pilar Konten | `http` | `split: "$json.pilar"` memecah balasan jadi banyak item |
| 4 | Topik yang Sudah Ada (read: sheet) | `sheet` | driver `csv` (lokal) atau `google` (service account) |
| 5 | Susun Perintah | `code` | pilih pilar paling jarang dipakai, susun prompt |
| 6 | Beri Tugas ke Wowo | `http` | `retry:1`, `allowNon2xx:true` |
| 7 | Catat ID Tugas | `code` | ambil `task_id`, simpan `$vars.coba` |
| 8 | Tugas Terkirim? | `ifElse` | `next: {true: n9, false: n10}` |
| 9 | Tunggu 15 Detik | `wait` | `ms: 15000`, `next: n6` → **loop ke node 6** |
| 10 | Cek Daftar Tugas | `http` | `split: "$json.items"`, `keepEmpty:true` |
| 11 | Cari Hasil | `code` | kalau belum ada, hasilkan `{menunggu:true}` |
| 12 | Masih Menunggu? | `ifElse` | `next: {true: n13, false: n14}` |
| 13 | Tunggu 1 Menit | `wait` | `ms: 60000`, `next: n10` → **loop ke node 10** |
| 14 | Parse Ide | `code` | normalisasi ide, kembalikan `[]` kalau kosong |
| 15 | Simpan Ide | `sheet` | `action: append`, `columns` eksplisit |

## Kenapa dulu tidak bisa

Versi sebelumnya mengeksekusi node **berurutan satu arah**: array node dijalankan
dari atas ke bawah, node `if` hanya *membuang* item (tidak punya dua cabang), dan
tidak ada cara kembali ke node sebelumnya. Akibatnya:

- panah `Tugas Terkirim? → Tunggu 15 Detik → Beri Tugas ke Wowo` tidak mungkin;
- panah `Masih Menunggu? → Tunggu 1 Menit → Cek Daftar Tugas` tidak mungkin;
- `read: sheet` tidak ada node-nya (hanya `file`);
- trigger `Senin 07:00` tidak ada (hanya `every_minutes`).

Sekarang engine memakai **graf**: setiap node punya `id` dan `next`.

```json
{
  "id": "n8",
  "type": "ifElse",
  "name": "Tugas Terkirim?",
  "config": { "condition": "!$json.task_id && $vars.coba < 3" },
  "next": { "true": "n9", "false": "n10" }
}
```

Aturan routing:

- `next` tidak ada → lanjut ke node berikutnya di array (kompatibel dengan workflow lama).
- `next: "n3"` → semua item ke node `n3`.
- `next: {"true": "n9", "false": "n10"}` → mengikuti cabang output node.
- `next: null` → alur berakhir di node ini (outputnya jadi hasil eksekusi).

Item yang datang ke node yang sama dari dua cabang otomatis **digabung** (merge),
mirip perilaku n8n.

## Variabel yang tersedia

| Variabel | Isi |
|---|---|
| `$json` | item saat ini |
| `$items` | semua item yang masuk ke node ini |
| `$node['Nama Node']` | output node lain pada eksekusi ini |
| `$vars` | variabel bebas per eksekusi (mis. `$vars.coba`, `$vars.cek`) |
| `$env` | environment variable |
| `$now`, `$today` | waktu ISO / tanggal |
| `$workflow`, `$execution` | id & nama |

Di node `code`, semua di atas tersedia sebagai parameter, plus `console.log`
yang masuk ke log eksekusi.

## Batas keamanan loop

- `settings.max_steps` (default 1000) → total langkah per eksekusi.
- `node.max_visits` / `settings.max_visits` (default 100) → satu node boleh
  dijalankan berapa kali. WOWO memakai `max_visits: 20`.
- `node.on_limit: "continue"` → lewati node setelah batas tercapai, jangan gagalkan alur.

## Menjalankan

```bash
# 1. siapkan data contoh
mkdir -p files
printf 'topik,pilar,dibuat\nEdukasi #1,Edukasi,2026-10-01\n' > files/topik.csv

# 2. tiruan KRA (kalau KRA asli belum siap)
node examples/mock-kra.js

# 3. isi .env
#   KRA_BASE_URL=http://localhost:5680
#   KRA_API_KEY=dev-kra-key
#   WOWO_SHEET_DRIVER=csv

# 4. jalankan n100n lalu tekan Run (atau Run async) pada "Workflow WOWO"
npm start
```

Waktu nyata satu putaran: maksimal 3× (retry + 15 detik) untuk pengiriman tugas,
lalu 5× 1 menit untuk menunggu hasil — sekitar 5–6 menit. Karena itu di UI pakai
**Run async**, dan dari KRA pakai `runAsync()` + `waitExecution()`.
