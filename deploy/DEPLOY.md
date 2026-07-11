# Panduan Deploy Cellyn Store ke VPS (via Termux)

Panduan ini mengasumsikan VPS **Ubuntu 22.04/24.04 atau Debian 12**. Kalau OS-mu berbeda, beri tahu dulu.

Kamu menjalankan semua perintah dari **Termux di HP** dengan cara SSH ke VPS.

---

## 0. Persiapan DNS (lakukan lebih dulu)

Di panel pengelola domain, buat 2 record ke **IP VPS** kamu:

| Type | Name | Value        |
|------|------|--------------|
| A    | `@`  | `IP_VPS_KAMU` |
| A    | `www`| `IP_VPS_KAMU` |

Propagasi bisa 5 menit sampai beberapa jam. Cek dengan: `ping domainkamu.com` (harus muncul IP VPS).

---

## 1. SSH dari Termux (disarankan pakai SSH key)

Di Termux:

```bash
pkg update && pkg install openssh -y

# (Sekali saja) buat SSH key supaya tidak perlu ketik password terus
ssh-keygen -t ed25519

# Salin public key ke VPS (ganti user & IP)
ssh-copy-id root@IP_VPS_KAMU

# Masuk ke VPS
ssh root@IP_VPS_KAMU
```

> Tips keamanan: setelah key aktif, matikan login password di VPS (`PasswordAuthentication no` di `/etc/ssh/sshd_config`).

---

## 2. Opsi A — Setup otomatis (paling gampang)

Setelah masuk ke VPS, jalankan:

```bash
# Ambil script setup langsung dari repo
git clone https://github.com/rendijuliyan51/web-app.git /opt/cellyn-store
cd /opt/cellyn-store

# Jalankan setup (ganti domain kamu)
sudo DOMAIN=domainkamu.com bash deploy/setup.sh
```

Script ini otomatis: install Node.js + nginx, buat user aplikasi, `npm install`, pasang service systemd, dan pasang reverse proxy nginx.

Lalu aktifkan HTTPS (setelah DNS sudah mengarah ke VPS):

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d domainkamu.com -d www.domainkamu.com
```

Selesai. Buka `https://domainkamu.com`.

---

## 3. Opsi B — Setup manual (kalau mau paham tiap langkah)

```bash
# 1. Install Node.js 22 + tools
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs git build-essential python3 nginx

# 2. Ambil kode
sudo git clone https://github.com/rendijuliyan51/web-app.git /opt/cellyn-store
cd /opt/cellyn-store
sudo npm install --omit=dev

# 3. Coba jalan manual dulu (Ctrl+C untuk stop)
node server.js
# harusnya muncul: Cellyn Store running on port 3000
```

Lalu buat service systemd `/etc/systemd/system/cellyn-store.service` (contoh ada di `deploy/cellyn-store.service`, ganti `__APP_USER__`, `__APP_DIR__`, `__PORT__`), dan config nginx dari `deploy/nginx-cellyn-store.conf` (ganti `__DOMAIN__`, `__PORT__`). Aktifkan:

```bash
sudo systemctl enable --now cellyn-store
sudo ln -sf /etc/nginx/sites-available/cellyn-store /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 4. Perintah operasional sehari-hari

```bash
# Status & log aplikasi
systemctl status cellyn-store
journalctl -u cellyn-store -f

# Update aplikasi setelah ada perubahan di GitHub
cd /opt/cellyn-store
sudo git pull
sudo npm install --omit=dev
sudo systemctl restart cellyn-store
```

---

## 5. Hal penting setelah live

- **Ganti password admin default.** Buka `https://domainkamu.com/secretadmin`, login `admin` / `cellyn123`, lalu ganti password (panel akan memaksa ini).
- **Preview share sosial (OG meta).** Di `server.js` ada `siteUrl` yang masih hardcoded ke domain contoh. Kalau mau preview link di WhatsApp/Discord memakai domain kamu, bagian itu perlu disesuaikan — bilang saja, nanti saya buat dapat diatur lewat environment variable.
- **Backup data.** Database ada di `/opt/cellyn-store/data/store.db` dan gambar di `/opt/cellyn-store/public/uploads/`. Backup dua folder ini secara berkala.
- **Firewall.** Kalau pakai UFW: `sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable`.
