#!/usr/bin/env bash
set -euo pipefail

# ============================================================
#  Cellyn Store - setup otomatis untuk VPS Ubuntu / Debian
#  Jalankan sebagai root:
#     sudo DOMAIN=domainkamu.com bash deploy/setup.sh
# ============================================================

# --- Konfigurasi (boleh diubah lewat environment variable) ---
DOMAIN="${DOMAIN:-example.com}"          # ganti ke domain kamu, mis. cellynstore.web.id
APP_USER="${APP_USER:-cellyn}"           # user sistem untuk menjalankan aplikasi
APP_DIR="${APP_DIR:-/opt/cellyn-store}"  # lokasi aplikasi di VPS
REPO="${REPO:-https://github.com/rendijuliyan51/web-app.git}"
PORT="${PORT:-3000}"
NODE_MAJOR="${NODE_MAJOR:-22}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Script ini harus dijalankan sebagai root (pakai sudo)." >&2
  exit 1
fi

echo ">> [1/7] Update paket & install prasyarat..."
apt-get update -y
apt-get install -y curl git build-essential python3 nginx

echo ">> [2/7] Install Node.js ${NODE_MAJOR}..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v

echo ">> [3/7] Buat user aplikasi (${APP_USER})..."
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

echo ">> [4/7] Clone / update repo di ${APP_DIR}..."
# Cegah error "detected dubious ownership" karena folder dimiliki user aplikasi
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi

echo ">> [5/7] Install dependencies (production)..."
cd "$APP_DIR"
npm install --omit=dev
mkdir -p "$APP_DIR/data" "$APP_DIR/public/uploads"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo ">> [6/7] Pasang service systemd..."
sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__APP_USER__|$APP_USER|g" \
    -e "s|__PORT__|$PORT|g" \
    "$APP_DIR/deploy/cellyn-store.service" > /etc/systemd/system/cellyn-store.service
systemctl daemon-reload
systemctl enable --now cellyn-store

echo ">> [7/7] Pasang konfigurasi nginx..."
sed -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__PORT__|$PORT|g" \
    "$APP_DIR/deploy/nginx-cellyn-store.conf" > /etc/nginx/sites-available/cellyn-store
ln -sf /etc/nginx/sites-available/cellyn-store /etc/nginx/sites-enabled/cellyn-store
# Nonaktifkan default site kalau ada, supaya tidak bentrok
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "==================================================================="
echo " Selesai!"
echo " - Cek status app :  systemctl status cellyn-store"
echo " - Lihat log      :  journalctl -u cellyn-store -f"
echo " - Buka           :  http://$DOMAIN  (setelah DNS mengarah ke VPS)"
echo ""
echo " Aktifkan HTTPS (setelah DNS aktif):"
echo "   apt-get install -y certbot python3-certbot-nginx"
echo "   certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo ""
echo " JANGAN LUPA: login admin di /secretadmin lalu GANTI password default!"
echo "==================================================================="
