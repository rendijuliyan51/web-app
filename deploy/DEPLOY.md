# Panduan Deploy Cellyn Store ke VPS

> **PENTING — setup live saat ini:** aplikasi berjalan dari **`/var/www/web-app`** dan dikelola oleh **PM2** (bukan systemd). Nginx mem-proxy ke `http://localhost:3000`. Ikuti panduan ini; jangan pakai path `/opt/cellyn-store`.
>
> Jangan pernah menaruh kredensial (password SSH, IP, token) di file ini karena repo bersifat publik. Simpan hal sensitif di catatan pribadi.

Panduan ini untuk VPS **Ubuntu 22.04 / 24.04**.

| Item | Nilai |
|------|-------|
| Lokasi aplikasi | `/var/www/web-app` |
| Entry point | `server.js` |
| Runtime | Node.js 20/22 (Express.js) |
| Port | `3000` (di-proxy Nginx) |
| Process manager | **PM2** (nama proses: `cellyn-store`) |
| Reverse proxy | Nginx |
| SSL | Let's Encrypt via Certbot |
| DNS | Cloudflare (mode **DNS only** / awan abu-abu) |

---

## 0. DNS (lakukan lebih dulu)

Di **Cloudflare Dashboard** → domain kamu → menu **DNS**, buat 2 record ke IP VPS:

| Type | Name | Content       | Proxy status              |
|------|------|---------------|---------------------------|
| A    | `@`  | `IP_VPS_KAMU` | **DNS only** (abu-abu)     |
| A    | `www`| `IP_VPS_KAMU` | **DNS only** (abu-abu)     |

> NS domain sudah diarahkan ke Cloudflare, jadi semua perubahan DNS dilakukan di Cloudflare, bukan di panel domain.
>
> Proxy **wajib DNS only** saat menerbitkan SSL (Certbot) agar verifikasi berhasil. Setelah SSL aktif, boleh diubah ke *proxied* bila diinginkan (tapi ingat: mode proxied menambah cache Cloudflare, sehingga perubahan frontend perlu *Purge Cache*).

---

## 1. SSH ke VPS

```bash
ssh root@IP_VPS_KAMU
```

> Disarankan pakai SSH key dan matikan login password (`PasswordAuthentication no` di `/etc/ssh/sshd_config`).

---

## 2. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs git build-essential python3
node -v && npm -v
```

---

## 3. Ambil kode & konfigurasi

```bash
sudo mkdir -p /var/www
cd /var/www
sudo git clone https://github.com/rendijuliyan51/web-app.git
cd web-app

cp .env.example .env
nano .env          # minimal set PORT=3000
```

> Catatan: ada kemungkinan sudah ada proses Node lama di port 3000 (mis. dari user `cellyn`). Kalau bentrok port, hentikan dulu: `pkill -f node` lalu tunggu 2 detik.

---

## 4. Install dependency & tes jalan

```bash
npm install
node server.js     # tes; harus muncul "Cellyn Store running on port 3000". Ctrl+C untuk stop.
```

---

## 5. Jalankan dengan PM2 (agar tetap hidup + auto-start saat reboot)

```bash
sudo npm install -g pm2

pm2 start server.js --name cellyn-store
pm2 save
pm2 startup        # jalankan perintah yang ditampilkan agar PM2 auto-start saat boot
```

Cek: `pm2 status` → proses `cellyn-store` harus `online`.

---

## 6. Nginx reverse proxy

Contoh config ada di `deploy/nginx-cellyn-store.conf` (ganti `__DOMAIN__` dan `__PORT__` → `3000`). Atau buat manual:

```bash
sudo nano /etc/nginx/sites-available/cellynstore.web.id
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name cellynstore.web.id www.cellynstore.web.id;

    client_max_body_size 60M;   # server pakai multer limit 50MB

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

Aktifkan:

```bash
sudo ln -sf /etc/nginx/sites-available/cellynstore.web.id /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7. SSL (Certbot) — pastikan DNS Cloudflare mode DNS only dulu

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d cellynstore.web.id -d www.cellynstore.web.id
```

Ikuti prompt (email, setuju TOS). Certbot otomatis meng-update Nginx & mengaktifkan HTTPS, serta memasang timer auto-renew.

---

## 8. Update aplikasi setelah ada perubahan di GitHub

Ini alur yang benar untuk setup PM2 ini:

```bash
cd /var/www/web-app
git pull origin main
npm install            # hanya jika ada perubahan dependency
pm2 restart cellyn-store
```

Verifikasi konten baru benar-benar disajikan:

```bash
# pastikan proses port 3000 memang dari /var/www/web-app
ss -ltnp | grep :3000

# contoh cek penanda unik di HTML yang disajikan server
curl -s http://localhost:3000 | grep -c "E50914"
```

> Kalau DNS Cloudflare **DNS only**, tidak ada cache CDN — cukup hard refresh browser (Ctrl+Shift+R). Kalau mode **proxied**, lakukan **Purge Everything** di Cloudflare → Caching.

---

## 9. Perintah maintenance PM2

```bash
pm2 status                 # daftar & status proses
pm2 logs cellyn-store      # lihat log realtime
pm2 restart cellyn-store   # restart
pm2 stop cellyn-store      # stop
pm2 save                   # simpan daftar proses saat ini
```

---

## 10. Hal penting setelah live

- **Ganti password admin default.** Buka `https://cellynstore.web.id/secretadmin`, login `admin` / `cellyn123`, lalu ganti password (panel memaksa ini pada login pertama).
- **Backup data.** Database SQLite di `/var/www/web-app/data/store.db` dan gambar di `/var/www/web-app/public/uploads/`. Backup dua lokasi ini berkala.
- **Preview share sosial (OG meta).** Di `server.js` variabel `siteUrl` masih hardcoded ke `https://cellynstore.web.id`. Kalau ganti domain, sesuaikan bagian itu (bisa dibuat lewat environment variable — minta bila perlu).
- **Firewall (UFW).** `sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable`.

---

## Catatan tentang berkas systemd di folder `deploy/`

Berkas `deploy/cellyn-store.service` dan `deploy/setup.sh` menggambarkan pemasangan alternatif berbasis **systemd** di `/opt/cellyn-store`. **Setup live saat ini TIDAK memakai itu** — memakai PM2 di `/var/www/web-app`. Berkas tersebut dipertahankan sebagai referensi opsional. Jangan campur kedua metode agar tidak terjadi bentrok port 3000.
