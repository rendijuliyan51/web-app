# Cellyn Store

Toko digital (e-commerce) dengan tampilan **gelap ala Netflix** + **panel admin** untuk mengelola semua konten tanpa perlu ngoding. Berjalan di **Node.js (Express) + SQLite**, frontend **vanilla JS/HTML/CSS** (tanpa build step, tanpa framework).

- **Domain:** https://cellynstore.web.id
- **Storefront:** `/` — katalog produk, hero, keranjang, checkout via WhatsApp
- **Admin panel:** `/secretadmin` — kelola produk, kategori, produk unggulan (hero), pengaturan, ulasan, pengumuman, backup/restore

> **Catatan untuk AI/kolaborator berikutnya:** dokumen ini adalah sumber kebenaran soal cara pasang & rawat aplikasi ini. Baca bagian **Deploy** dan **Backup & Restore** sebelum menyentuh server. Detail deploy tambahan ada di [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

---

## Ringkasan Teknis

| Item | Nilai |
|------|-------|
| Runtime | Node.js >= 18 (dites di Node 22) |
| Framework | Express.js |
| Database | SQLite via `better-sqlite3` (file `data/store.db`, mode WAL) |
| Frontend | Vanilla HTML/CSS/JS di `public/` (tanpa build/bundler) |
| Process manager (produksi) | **PM2**, nama proses `cellyn-store` |
| Reverse proxy | Nginx → `http://localhost:3000` |
| SSL | Let's Encrypt (Certbot) |
| DNS | Cloudflare (mode **DNS only** / awan abu-abu) |
| Auth admin | Session cookie httpOnly + Secure + CSRF (bcrypt untuk password) |
| Port | `3000` (dapat diubah via env `PORT`) |

**Tidak ada** MongoDB, tidak ada React, tidak ada langkah build. Semua dependency ada di `package.json` dan native module (`better-sqlite3`, `sharp`) ter-compile saat `npm install`.

---

## Struktur Folder

```
web-app/
├── server.js              # Seluruh backend (Express + SQLite + semua API) — satu file
├── package.json
├── public/
│   ├── index.html         # Storefront (tema Netflix) — HTML+CSS+JS jadi satu
│   ├── secretadmin.html   # Panel admin — HTML+CSS+JS jadi satu
│   └── uploads/           # Gambar yang di-upload (produk, logo, QRIS) — TIDAK di-commit
├── data/
│   └── store.db           # Database SQLite — TIDAK di-commit, dibuat otomatis saat start
├── deploy/                # Contoh config deploy (nginx, systemd, script, panduan)
│   └── DEPLOY.md
└── .env                   # PORT (dibuat dari .env.example) — TIDAK di-commit
```

Data penting yang **wajib di-backup**: `data/store.db` + `public/uploads/`. (Lihat bagian Backup & Restore.)

---

## Environment Variables (`.env`)

Aplikasi ini sengaja dibuat minim konfigurasi. Salin `.env.example` → `.env`:

```
PORT=3000
```

Kredensial admin **tidak** disimpan di `.env` — akun admin default dibuat otomatis di database (lihat di bawah).

---

## Menjalankan Lokal (development)

```bash
npm install
npm run dev      # node --watch server.js
# atau: npm start
```

Buka `http://localhost:3000`. Admin di `http://localhost:3000/secretadmin`.

> **Penting:** cookie sesi memakai flag `Secure`, jadi **login admin hanya berfungsi lewat HTTPS** (atau `localhost` yang dianggap secure oleh browser). Login lewat `http://<IP>:3000` (bukan localhost, tanpa TLS) tidak akan menyimpan cookie — ini normal, bukan bug.

---

## Deploy ke VPS Baru (dari nol)

Setup live saat ini: **`/var/www/web-app` + PM2 + Nginx + Certbot** di Ubuntu 22.04/24.04.

### 1. Install Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs git build-essential python3
```

### 2. Ambil kode & dependency
```bash
sudo mkdir -p /var/www && cd /var/www
sudo git clone https://github.com/rendijuliyan51/web-app.git
cd web-app
cp .env.example .env      # isi PORT=3000
npm install               # meng-compile better-sqlite3 & sharp — butuh build-essential
```
> Kalau ada proses Node lama di port 3000: `pkill -f node` lalu tunggu 2 detik.

### 3. Jalankan dengan PM2
```bash
sudo npm install -g pm2
pm2 start server.js --name cellyn-store
pm2 save
pm2 startup               # jalankan perintah yang ditampilkan (auto-start saat reboot)
```
Cek: `pm2 status` → `cellyn-store` harus `online`. Log: `pm2 logs cellyn-store --lines 20` → harus muncul `Cellyn Store running on port 3000`.

### 4. Nginx (reverse proxy ke port 3000)
```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/cellynstore.web.id
```
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name cellynstore.web.id www.cellynstore.web.id;
    client_max_body_size 60M;             # server pakai multer limit 50MB

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        'upgrade';
    }
}
```
```bash
sudo ln -sf /etc/nginx/sites-available/cellynstore.web.id /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. DNS di Cloudflare
Tambah A record `@` dan `www` ke IP VPS, **mode DNS only (awan abu-abu)** — wajib abu-abu saat menerbitkan SSL.

### 6. SSL (Certbot)
```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d cellynstore.web.id -d www.cellynstore.web.id
```

### 7. Pulihkan data (kalau pindah/ganti VPS) — lihat bagian **Restore** di bawah.

---

## Update Aplikasi (setelah ada perubahan di GitHub)

```bash
cd /var/www/web-app
git pull origin main
npm install            # hanya jika ada perubahan dependency di package.json
pm2 restart cellyn-store
pm2 logs cellyn-store --lines 20
```
> Jalankan perintah **satu per satu**; jangan menempel teks instruksi ke dalam baris perintah (mis. `--lines` yang nyangkut ke `pm2 restart` akan error).
>
> Kalau perubahan hanya file statis di `public/`, cukup `git pull` + `pm2 restart` (tanpa `npm install`), lalu **hard refresh** browser (Ctrl+Shift+R). Kalau pakai Cloudflare mode *proxied*, purge cache; kalau *DNS only*, tidak perlu.

---

## Backup & Restore (PENTING — anti kehilangan data)

Semua data ada di `data/store.db` (produk, kategori, pengaturan, ulasan, akun admin) + `public/uploads/` (gambar). Backup = arsip `.tar.gz` dari kedua itu.

### Lewat panel admin (cara mudah)
1. Login `/secretadmin` → tab **Backup**.
2. **Unduh Backup** → dapat file `cellyn-backup-<tanggal>.tar.gz`. Simpan di luar VPS (Google Drive/laptop).
3. **Restore:** tab **Backup** → pilih file → **Restore** → server otomatis restart, semua data kembali. Login ulang.

### Pemulihan penuh di VPS baru (skenario "VPS mati")
1. Deploy aplikasi seperti langkah 1–6 di atas (aplikasi kosong dulu tidak apa-apa).
2. Buka `/secretadmin`, login default, tab **Backup** → upload file `.tar.gz` terakhir → **Restore**.
3. Selesai — produk, gambar, dan pengaturan kembali seperti semula.

### Lewat command line (manual, tanpa panel)
```bash
# Backup
cd /var/www/web-app
tar -czf ~/cellyn-backup-$(date +%F).tar.gz data/store.db public/uploads
# Restore
cd /var/www/web-app && pm2 stop cellyn-store
tar -xzf /path/ke/cellyn-backup-XXXX.tar.gz -C /var/www/web-app
rm -f data/store.db-wal data/store.db-shm
pm2 restart cellyn-store
```
> Endpoint backup: `GET /api/admin/backup` (butuh login). Restore: `POST /api/admin/restore` (multipart, field `file`). Keduanya pakai `tar` bawaan sistem — tidak ada dependency npm tambahan.

---

## Panel Admin (`/secretadmin`)

- **Login default:** username `admin`, password `cellyn123`. **Wajib ganti** saat pertama login (dipaksa oleh sistem).
- **Tab:**
  - **Produk** — tambah/edit/hapus produk (nama, harga, harga coret, stok, kategori, badge, ringkasan, deskripsi, thumbnail, gambar besar) + **varian** produk.
  - **Kategori** — kelola kategori (tampil sebagai baris di homepage & chip filter).
  - **Store & Tampilan** — nama toko, logo, teks hero, footer, nomor WhatsApp, QRIS, Discord, **warna aksen** (latar & font dikunci ke tema Netflix).
  - **Unggulan** — pilih produk yang tampil di **hero** (banner besar). Hero berputar antar produk unggulan; kalau kategori tertentu dipilih di storefront, hero menampilkan unggulan kategori itu.
  - **Password**, **Ulasan** (moderasi), **Notifikasi** (pengumuman), **Audit** (log), **Backup**.

---

## Ringkasan API (dipakai frontend)

Publik: `GET /api/storefront`, `GET /api/products`, `GET /api/categories`, `GET /api/products/:id/reviews`, `POST /api/products/:id/reviews` (rate-limit 5/jam/IP), `POST /api/products/:id/view`, `POST /api/track-order`, `POST /api/build-whatsapp-link`.

Auth: `POST /api/login` (rate-limit 10/15menit), `POST /api/logout`, `GET /api/me`, `POST /api/admin/change-password`.

Admin (butuh sesi + header `X-CSRF-Token`): CRUD `/api/admin/products`, `/api/admin/categories`, `/api/admin/settings`, `/api/admin/reviews`, `/api/admin/notifications`, varian, upload gambar, `PUT /api/admin/products/:id/featured`, `GET /api/admin/backup`, `POST /api/admin/restore`, export CSV, audit log, dashboard.

---

## Catatan Keamanan

- Password admin: **bcrypt**. Token sesi & CSRF: `crypto.randomBytes` (bukan `Math.random`).
- Cookie sesi & CSRF: `httpOnly` (sesi) + **`Secure`** (hanya HTTPS) + `SameSite=Lax`.
- Proteksi **CSRF** (double-submit cookie) untuk semua endpoint `/api/admin` non-GET.
- **Rate limit**: login (10/15m), ulasan (5/jam), umum (200/15m).
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `HSTS`.
- Semua output dinamis di-escape (anti-XSS); query SQL memakai parameter (anti-SQL-injection).
- Sesi kedaluwarsa dibersihkan dari DB otomatis (saat start + tiap jam).

---

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Setelah `git pull`, fitur baru belum muncul | Belum restart. Jalankan `pm2 restart cellyn-store` (perintah terpisah). Verifikasi: `pm2 logs cellyn-store --lines 20`. |
| Buka `/api/admin/backup` malah pindah ke halaman toko | Server belum jalan kode terbaru (restart gagal). Cek `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/admin/backup` → harus **401** (bukan 200). |
| Login admin gagal / cookie tidak tersimpan | Login harus lewat **HTTPS** (domain), bukan `http://IP:3000`. Cookie ber-flag Secure. |
| Situs "mentok loading" di HP/browser lama | Sudah ada failsafe + kompatibilitas; pastikan versi terbaru ter-deploy & hard refresh. |
| Port 3000 dipakai | `pkill -f node` lalu `pm2 restart cellyn-store`. |
| Perubahan frontend tak muncul | Hard refresh (Ctrl+Shift+R). Jika Cloudflare *proxied*, purge cache. |
| Admin panel error setelah restore | Sesi lama tidak ada di DB hasil restore — cukup login ulang. |
| Restore: "JSON.parse: unexpected character…" | Respons bukan JSON. Umumnya file backup > `client_max_body_size` Nginx → Nginx balas HTML 413. Naikkan `client_max_body_size` (mis. `1024M`) lalu `nginx -t && systemctl reload nginx`. Bisa juga server keburu restart (restore tetap berhasil — cukup login ulang). |

---

## Konvensi Pengembangan

- **Deploy alur:** `git pull origin main && pm2 restart cellyn-store` di `/var/www/web-app`.
- **Perubahan kode:** buat branch baru dari `main`, buka Pull Request (jangan push langsung ke `main`). Setiap set perubahan = 1 PR.
- **Jangan** menaruh kredensial (password/IP/token) di dalam repo (repo publik). Simpan rahasia di catatan pribadi.
- Tidak ada langkah build: edit `public/index.html` / `public/secretadmin.html` / `server.js` langsung.
- CI (`.github/workflows/ci.yml`): `npm install` + `node --check server.js`.
