# Integrasi n100n untuk kantor-rama-ai (KRA)

Folder ini berisi perubahan siap-pakai untuk repo
[`turtrsst/kantor-rama-ai`](https://github.com/turtrsst/kantor-rama-ai) supaya
workflow n100n bisa bicara dua arah dengan KRA. Netral: tidak mengasumsikan alur
tertentu — Anda pakai endpoint antrean tugas ini dari alur apa pun yang Anda rakit.

| File | Tujuan di repo KRA |
|---|---|
| `pasang.js` | **Pemasang otomatis** (disarankan): menyalin file + menyisipkan require/action ke `api/index.php`, idempoten |
| `api/lib/KraN100nClient.php` | klien HTTP KRA → n100n (status, run, runAsync, waitExecution, webhook) |
| `api/lib/KraFlowBridge.php` | antrean tugas + kategori: terima tugas, daftar hasil, tandai selesai |
| `tools/flow-bridge-test.php` | uji KraFlowBridge tanpa web server/MySQL |
| `docs/n100n-integration.md` | dokumentasi integrasi |
| `snippets/aksi-n100n.php` | potongan action yang disisipkan `pasang.js` |
| `patches/0001-n100n-flow-bridge.patch` | patch siap-apply untuk branch **main** |
| `patches/0001-flow-bridge-kra-049ded0b.patch` | patch siap-apply untuk branch `arena/049ded0b-kantor-rama-ai` |

## Cara pasang

### Opsi A — pemasang otomatis (disarankan, tahan beda branch)

```bash
# dari folder mana pun; Node dipakai karena n100n memang butuh Node
node pasang.js "C:\xampp\htdocs\kantor-rama-ai" --check   # lihat rencana
node pasang.js "C:\xampp\htdocs\kantor-rama-ai"           # terapkan
```

Aman dijalankan berulang: yang sudah ada dilewati. Yang diubah di `api/index.php`
hanya tiga hal — 2 `require_once`, blok 8 action, dan daftar action di pesan 404 —
dan `api/index.php.bak-n100n` dibuat sebagai cadangan.

### Opsi B — pakai patch

```bash
git apply --check /path/ke/0001-flow-bridge-kra-049ded0b.patch   # branch 049ded0b
# atau, untuk branch main:
git apply --check /path/ke/0001-n100n-flow-bridge.patch
```

Patch konteks terikat ke versi `api/index.php` saat dibuat. Kalau branch Anda
sudah berubah lagi, pakai `pasang.js` (Opsi A) — ia mencari titik sisip sendiri.

Kedua cara menambahkan 2 `require_once`, 8 action baru (`flow-tugas`,
`flow-selesai`, `flow-kategori`, `flow-status`, `n100n-status`,
`n100n-workflows`, `n100n-run`, `n100n-execution`), dan memperbarui daftar action
di pesan 404.

### Opsi C — copy manual

1. Copy `api/lib/KraN100nClient.php` dan `api/lib/KraFlowBridge.php` ke `api/lib/` KRA.
2. Copy `tools/flow-bridge-test.php` ke `tools/`.
3. Buka `api/index.php`:
   - tambahkan setelah `require_once __DIR__ . '/lib/KraWorkflowEngine.php';`
     ```php
     require_once __DIR__ . '/lib/KraN100nClient.php';
     require_once __DIR__ . '/lib/KraFlowBridge.php';
     ```
   - salin blok `// ---------------- integrasi n100n (antrean tugas) ----------------`
     dari patch (bagian `@@ -469 +471,129 @@`) dan tempel **sebelum**
     `$available = 'status, agents, ...`.

## Konfigurasi

Isi environment di mesin KRA (XAMPP: `setprop`/wrapper Apache):

```env
KRA_N100N_URL=http://127.0.0.1:5679
KRA_N100N_TOKEN=<APP_API_TOKEN dari .env n100n>
KRA_FLOW_API_KEY=<kunci acak; samakan dengan KRA_API_KEY di .env n100n>
KRA_FLOW_MODE=template      # template | agent | manual
KRA_FLOW_AGENT=rama         # dipakai hanya pada mode agent
```

Dan di `.env` n100n:

```env
KRA_BASE_URL=http://127.0.0.1:8080
KRA_API_KEY=<sama dengan KRA_FLOW_API_KEY>
```

Kalau KRA tidak memakai rewrite Apache, pakai URL penuh (tidak perlu ubah workflow):

```env
KRA_TUGAS_URL=http://127.0.0.1:8080/api/index.php?action=flow-tugas
KRA_TUGAS_LIST_URL=http://127.0.0.1:8080/api/index.php?action=flow-tugas
```

## Uji

```bat
php -l api/lib/KraN100nClient.php
php -l api/lib/KraFlowBridge.php
php tools/flow-bridge-test.php
```

Keluaran yang diharapkan: `N/N pemeriksaan lolos`.

Cek integrasi hidup (n100n harus jalan):

```bat
curl -H "x-api-key: %KRA_FLOW_API_KEY%" "http://127.0.0.1:8080/api/index.php?action=n100n-status"
curl -H "x-api-key: %KRA_FLOW_API_KEY%" "http://127.0.0.1:8080/api/index.php?action=n100n-workflows"
```

## Catatan

- `mode=template` sengaja deterministik supaya alur bisa diuji tanpa model AI.
  Ganti ke `agent` setelah provider model KRA siap, atau `manual` bila hasil diisi
  manusia lewat `?action=flow-selesai`.
- Data tugas disimpan di `.temp/flow.json` (flock), bukan MySQL — mengikuti pola
  `KraTaskEngine` agar tetap jalan saat MySQL XAMPP mati.
- Endpoint POST wajib mengirim `x-api-key` bila `KRA_FLOW_API_KEY` diisi.
- Untuk alur seperti apa pun di n100n, cukup arahkan node HTTP ke
  `KRA_TUGAS_URL`/`KRA_TUGAS_LIST_URL`. Pola perakitannya ada di
  `docs/MEMBUAT-ALUR-SENDIRI.md` pada repo n100n.
