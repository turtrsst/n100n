# Panduan End-to-End: n8n Lokal Self-Hosted (untuk Pemula)

Stack folder ini:

| File | Fungsi |
|---|---|
| `docker-compose.yml` | n8n + PostgreSQL 16 (+ profile tunnel Cloudflare) |
| `.env` | Zona waktu, kunci enkripsi, batas performa (RAHASIA) |
| `PANDUAN.md` | Panduan ini |

Prasyarat: [Docker Desktop](https://www.docker.com/products/docker-desktop/) aktif (`docker version` sukses). Jalankan semua perintah dari folder ini:

```powershell
cd C:\xampp\htdocs\n100n
# dari mesin lain via jaringan:
# cd \\100.76.172.67\c$\xampp\htdocs\n100n
```

---

## 1. SETUP INFRASTRUKTUR LOKAL

### 1.1 Jalankan pertama kali

`.env` sudah dibuat (berisi `N8N_ENCRYPTION_KEY` hasil generate). Cek isinya:

```powershell
notepad .env
```

> **PERINGATAN KREDENSIAL**
> - `N8N_ENCRYPTION_KEY` mengenkripsi semua API key/password yang disimpan di n8n. Simpan salinannya di password manager.
> - **Jangan pernah diganti** setelah kredensial tersimpan → semua credential rusak permanen.
> - Jangan commit/share isi `.env`.

Start:

```powershell
docker compose up -d
docker compose ps
```

Tunggu 1–2 menit (unduh image + healthcheck postgres), lalu buka `http://localhost:5678` → buat akun admin (sekali saja).

### 1.2 Database (PostgreSQL, selalu aktif)

Compose langsung memakai PostgreSQL 16 (`container_name: n8n-postgres`) — tahan antrean data besar, tidak mudah korup dibanding SQLite.

- User/DB: `n8n_user` / `n8n_database` (lihat `docker-compose.yml`).
- Password DB ada hardcoded `n8n_password_rahasia` — hanya untuk pemakaian lokal, tidak ada port DB yang dibuka ke luar. Kalau mau ganti: ubah di 2 tempat di `docker-compose.yml` sebelum `up` **pertama kali** (setelah ada data, ganti = harus migrasi DB).

### 1.3 Persistensi (data tidak hilang saat restart)

| Volume Docker | Isi |
|---|---|
| `n100n_n8n_storage` | Workflow, kredensial, akun, pengaturan (`/home/node/.n8n`) |
| `n100n_db_storage` | Database PostgreSQL |

`docker compose down` **tidak** menghapus volume → aman. Hapus semua data hanya dengan: `docker compose down -v` (DESTRUKTIF, jangan kecuali mau mulai nol).

Backup:

```powershell
docker run --rm -v n100n_n8n_storage:/data -v ${PWD}:/backup alpine tar czf /backup/backup-n8n-$(Get-Date -Format yyyyMMdd).tgz -C /data .
```

### 1.4 Environment variables (file `.env`)

| Variabel | Fungsi |
|---|---|
| `GENERIC_TIMEZONE` | Zona waktu schedule/cron (WIB = `Asia/Jakarta`) |
| `N8N_ENCRYPTION_KEY` | Enkripsi kredensial — WAJIB, jangan diganti |
| `N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true` | File settings n8n hanya boleh dibaca owner |
| `EXECUTIONS_DATA_PRUNE=true` | Auto-hapus riwayat eksekusi lama |
| `EXECUTIONS_DATA_MAX_AGE=168` | Riwayat eksekusi disimpan 168 jam (7 hari) |
| `EXECUTIONS_DATA_PRUNE_TIMEOUT=3600` | Proses prune maksimal 1 jam |
| `N8N_MEM_LIMIT` | Batas RAM container n8n (default 1g) |
| `WEBHOOK_URL` | URL publik saat pakai tunnel (isi setelah tahu URL) |

---

## 2. AKSES DARI INTERNET (WEBHOOK LUAR)

Webhook WhatsApp/Telegram/Stripe butuh URL publik HTTPS. Dua cara:

### Opsi A — Ngrok native di Windows (sesuai tutorial)

1. Instal Ngrok: `winget install Ngrok.Ngrok` (atau unduh dari `https://ngrok.com/download`).
2. Daftar akun → ambil authtoken → sekali saja: `ngrok config add-authtoken <token>` (rahasia).
3. Jalankan: `ngrok http 5678`
4. Salin URL `https://xxxx.ngrok-free.app` → masukkan di `.env`:

```
WEBHOOK_URL=https://xxxx.ngrok-free.app
```

5. Restart: `docker compose up -d --force-recreate n8n`

> URL ngrok free berubah tiap restart `ngrok` → update `WEBHOOK_URL` + recreate lagi. Webhook provider (Telegram/Stripe/WA) harus disesuaikan kalau URL berubah.

### Opsi B — Cloudflare quick tunnel (tanpa akun, dari compose)

```powershell
docker compose --profile tunnel up -d
docker compose logs -f cloudflared
```

Cari `https://xxxx-xxxx.trycloudflare.com` di log → isi ke `.env` (`WEBHOOK_URL=https://...`) → `docker compose up -d --force-recreate n8n`.

### Cara pasang di provider

- **Telegram**: token dari `@BotFather` → node Telegram Trigger di n8n → pakai URL webhook yang dicetak n8n (`<WEBHOOK_URL>/webhook/<id>`).
- **Stripe**: Dashboard → Developers → Webhook → URL di atas.
- **WhatsApp Cloud API**: Meta Developer → Callback URL + Verify Token dari node WhatsApp Trigger.

Aturan: `WEBHOOK_URL` harus persis sama dengan domain yang dipakai → kalau salah, trigger tidak pernah kena.

---

## 3. BLUEPRINT ARSITEKTUR WORKFLOW (BEST PRACTICES)

Pola standar untuk semua workflow buatanmu.

### 3.1 Global Error Trigger (wajib)

Workflow terpisah **"00 - Global Error Handler"**:

```
[Error Trigger] -> [Telegram / Send Email / HTTP Request]
```

1. Workflow baru → hapus Manual Trigger → tambah **Error Trigger**.
2. Notifikasi paling gampang Telegram: bot dari `@BotFather` → node **Telegram** → credential baru (token) → `sendMessage` → Chat ID dari `@userinfobot`. Pesan:

```
={{ $json.execution?.error?.message || "Workflow gagal" }}
Workflow: {{ $json.workflow.name }}
URL: {{ $json.execution.url }}
```

3. Simpan → toggle **Active ON**.
4. **Settings → Error Workflow** → pilih `00 - Global Error Handler` (berlaku global; tanpa langkah ini hanya berlaku untuk workflow itu sendiri).

### 3.2 Throttling & Wait Logic (jangan banting CPU)

**A. Batasi paralelisme** — sumber data → **Split In Batches** (Loop Over Items) → ukuran batch `10`–`50`. n8n hanya proses per batch → RAM stabil.

**B. Jeda antar batch** — setelah tiap batch: node **Wait** → `Time interval` → `2` detik. Ribuan item jalan terkendali, CPU dingin. Juga untuk rate-limit API (misal 1 pesan/detik WhatsApp).

**C. Cron bukan polling berat** — Schedule Trigger `15 menit`/`1 jam`, bukan tiap detik. Proses massal cukup 1x jadwal + batching di dalamnya.

**D. Skala besar** — kalau ribuan eksekusi/menit: n8n mode queue + worker terpisah (butuh konfigurasi tambahan; jalur mudahnya: batching + Wait di atas sudah cukup untuk lokal).

### 3.3 Sub-Workflow Structure (Execute Workflow)

```
10 - Main: WhatsApp Inbox           (aktif, ada Trigger)
 ├─ Execute Workflow -> 20 - Validate Input
 ├─ Execute Workflow -> 30 - Process: AI / Klasifikasi
 ├─ Execute Workflow -> 40 - Save to Sheets/DB
 └─ Error -> 00 - Global Error Handler
```

- Naming berangka (`10-`, `20-`, `00-`) → urutan kebaca.
- Induk **hanya orkestrasi**; logika bisnis di sub.
- Sub pakai **Execute Workflow Trigger** di atas (bukan Manual) → menerima input dari induk, tidak perlu Active, tidak butuh webhook publik.
- Execute Workflow → pilih workflow → hasil sub keluar sebagai output node → data kembali ke induk.
- Manfaat: test per bagian, pakai ulang, induk tetap pendek.

---

## 4. PERINTAH TERMINAL (CHEAT SHEET)

Dari folder `C:\xampp\htdocs\n100n`:

```powershell
# Jalankan
docker compose up -d

# Status & log (debug eror)
docker compose ps
docker compose logs -f n8n
docker compose logs -f n8n --tail 100

# Matikan (data TETAP aman)
docker compose down

# Mulai ulang
docker compose restart n8n

# Update n8n ke versi terbaru
docker compose pull
docker compose up -d

# Rollback: set image di docker-compose.yml ke tag versi lama (cek hub.docker.com/r/n8nio/n8n/tags), lalu up -d

# Tunnel Cloudflare
docker compose --profile tunnel up -d

# Hapus SEMUA data (DESTRUKTIF! backup dulu)
docker compose --profile tunnel down -v
```

Update rutin: backup volume → `pull` → `up -d` → cek `docker compose logs n8n`.

---

## 5. TIPS PERFORMA

1. **Batas RAM container** — `N8N_MEM_LIMIT=1g` di `.env` (komputer 8GB: 1g; 16GB: boleh 2g).
2. **Batas RAM WSL2** — Docker Desktop di Windows jalan di WSL2 yang default makan banyak RAM. Buat `C:\Users\<NamaUser>\.wslconfig`:

```ini
[wsl2]
memory=4GB
swap=2GB
```

Lalu restart WSL: `wsl --shutdown`.
3. **Prune eksekusi** sudah aktif (7 hari) → disk tidak membengkak.
4. **Batch + Wait** (bagian 3.2) → CPU stabil saat ribuan item.
5. **Jangan simpan data besar** di context workflow → arahkan ke file/DB/S3.
6. Cek real-time: `docker stats`. Kalau `n8n-local-app` tembus limit → naikkan `N8N_MEM_LIMIT` atau tambah node **Limit** di awal alur.

---

## CHECKLIST AKHIR

- [ ] `.env` terisi, `N8N_ENCRYPTION_KEY` disimpan aman di password manager
- [ ] `docker compose up -d` jalan, `docker compose ps` sehat
- [ ] `http://localhost:5678` → akun admin dibuat → workflow contoh tersimpan
- [ ] Timezone `Asia/Jakarta` terkonfirmasi di Settings → Timezone n8n
- [ ] (Luar) Tunnel jalan → `WEBHOOK_URL` diisi → `docker compose up -d --force-recreate n8n` → webhook test provider masuk
- [ ] Error Workflow global aktif & teruji (buang gagal disengaja → notifikasi masuk)
