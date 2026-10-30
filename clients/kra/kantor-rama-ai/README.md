# Integrasi n100n untuk kantor-rama-ai (KRA)

Folder ini berisi perubahan siap-pakai untuk repo
[`turtrsst/kantor-rama-ai`](https://github.com/turtrsst/kantor-rama-ai) supaya
Workflow WOWO di n100n bisa bicara dua arah dengan KRA.

| File | Tujuan di repo KRA |
|---|---|
| `api/lib/KraN100nClient.php` | klien HTTP KRA → n100n (status, run, runAsync, waitExecution, webhook) |
| `api/lib/KraWowoBridge.php` | endpoint Wowo: pilar konten, terima tugas, daftar hasil |
| `tools/wowo-bridge-test.php` | uji KraWowoBridge tanpa web server/MySQL |
| `docs/n100n-integration.md` | dokumentasi integrasi |
| `patches/0001-n100n-wowo-integration.patch` | patch `api/index.php` + file di atas sekaligus |

## Cara pasang

### Opsi A — pakai patch (disarankan)

```bash
# di folder proyek KRA, pastikan working tree bersih
git apply --check /path/ke/0001-n100n-wowo-integration.patch   # cek dulu
git apply /path/ke/0001-n100n-wowo-integration.patch
```

Patch menambahkan 2 `require_once`, 7 action baru (`wowo-pilar`, `wowo-tugas`,
`wowo-selesai`, `n100n-status`, `n100n-workflows`, `n100n-run`,
`n100n-execution`), dan memperbarui daftar action di pesan 404.

### Opsi B — copy manual

1. Copy `api/lib/KraN100nClient.php` dan `api/lib/KraWowoBridge.php` ke `api/lib/` KRA.
2. Copy `tools/wowo-bridge-test.php` ke `tools/`.
3. Buka `api/index.php`:
   - tambahkan setelah `require_once __DIR__ . '/lib/KraWorkflowEngine.php';`
     ```php
     require_once __DIR__ . '/lib/KraN100nClient.php';
     require_once __DIR__ . '/lib/KraWowoBridge.php';
     ```
   - salin blok `// ---------------- integrasi n100n (Workflow WOWO) ----------------`
     dari patch (bagian `@@ -469 +471,129 @@`) dan tempel **sebelum**
     `$available = 'status, agents, ...`.

## Konfigurasi

Isi environment di mesin KRA (XAMPP: `setprop`/wrapper Apache):

```env
KRA_N100N_URL=http://127.0.0.1:5679
KRA_N100N_TOKEN=<APP_API_TOKEN dari .env n100n>
KRA_WOWO_API_KEY=<kunci acak; samakan dengan KRA_API_KEY di .env n100n>
KRA_WOWO_MODE=template      # template | agent | manual
KRA_WOWO_AGENT=rama         # dipakai hanya pada mode agent
```

Dan di `.env` n100n:

```env
KRA_BASE_URL=http://127.0.0.1:8080
KRA_API_KEY=<sama dengan KRA_WOWO_API_KEY>
```

Kalau KRA tidak memakai rewrite Apache, pakai URL penuh (tidak perlu ubah workflow):

```env
KRA_PILAR_URL=http://127.0.0.1:8080/api/index.php?action=wowo-pilar
KRA_TUGAS_URL=http://127.0.0.1:8080/api/index.php?action=wowo-tugas
KRA_TUGAS_LIST_URL=http://127.0.0.1:8080/api/index.php?action=wowo-tugas
```

## Uji

```bat
php -l api/lib/KraN100nClient.php
php -l api/lib/KraWowoBridge.php
php tools/wowo-bridge-test.php
```

Keluaran yang diharapkan: `N/N pemeriksaan lolos`.

Cek integrasi hidup (n100n harus jalan):

```bat
curl -H "x-api-key: %KRA_WOWO_API_KEY%" "http://127.0.0.1:8080/api/index.php?action=n100n-status"
curl -H "x-api-key: %KRA_WOWO_API_KEY%" "http://127.0.0.1:8080/api/index.php?action=n100n-workflows"
```

## Catatan

- `mode=template` sengaja deterministik supaya alur WOWO bisa diuji tanpa model AI.
  Ganti ke `agent` setelah provider model KRA siap, atau `manual` bila ide diisi
  manusia lewat `?action=wowo-selesai`.
- Data Wowo disimpan di `.temp/wowo.json` (flock), bukan MySQL — mengikuti pola
  `KraTaskEngine` agar tetap jalan saat MySQL XAMPP mati.
- Endpoint POST wajib mengirim `x-api-key` bila `KRA_WOWO_API_KEY` diisi.
