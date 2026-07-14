import express from 'express';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';
import crypto from 'crypto';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Security headers (tanpa dependency tambahan). CSP ketat sengaja dihindari
// karena storefront/admin memakai banyak inline script/style & handler onclick.
app.use(function(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Gambar upload: nama file unik per upload, jadi aman di-cache lama (repeat visit lebih cepat).
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

// Limiter ketat khusus login untuk cegah brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' }
});

// Limiter khusus kirim ulasan (anti-spam): maksimal 5 ulasan / jam / IP
const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak ulasan dari perangkat ini. Coba lagi nanti.' }
});

// Proteksi CSRF untuk semua endpoint admin yang mengubah data (non-GET)
app.use('/api/admin', csrfProtect);

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'store.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    icon_url TEXT,
    sort_order INTEGER DEFAULT 99,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    sku TEXT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    price INTEGER DEFAULT 0,
    original_price INTEGER,
    stock INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    badge TEXT,
    summary TEXT,
    description TEXT,
    image TEXT,
    featured INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 99,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    message TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT,
    entity_type TEXT,
    entity_id INTEGER,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );
  CREATE TABLE IF NOT EXISTS banners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    badge TEXT,
    image_path TEXT,
    sort_order INTEGER DEFAULT 99,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price INTEGER DEFAULT 0,
    original_price INTEGER,
    stock INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 99,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    comment TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    is_active INTEGER DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

try { db.exec(`ALTER TABLE product_variants ADD COLUMN description TEXT`); } catch (_) {}

try { db.exec(`ALTER TABLE products ADD COLUMN original_price INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE categories ADD COLUMN icon_url TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN must_change_pw INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE pages ADD COLUMN is_active INTEGER DEFAULT 1`); } catch (_) {}

const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  const hash = bcrypt.hashSync('cellyn123', 10);
  // Tandai wajib ganti password default setelah login pertama
  db.prepare('INSERT INTO users (username, password, role, must_change_pw) VALUES (?, ?, ?, 1)').run('admin', hash, 'admin');
}

// Seed halaman informasi toko (hanya dibuat kalau belum ada; konten bisa diedit dari admin)
const DEFAULT_PAGES = [
  { slug: 'tentang-kami', title: 'Tentang Kami', content: '<p>Selamat datang di toko kami. Silakan ubah teks ini melalui panel admin untuk menceritakan tentang toko Anda.</p>' },
  { slug: 'kebijakan-privasi', title: 'Kebijakan Privasi', content: '<p>Jelaskan bagaimana data pelanggan dikumpulkan, digunakan, dan dilindungi. Edit teks ini dari panel admin.</p>' },
  { slug: 'syarat-ketentuan', title: 'Syarat &amp; Ketentuan', content: '<p>Tuliskan syarat dan ketentuan penggunaan layanan serta pembelian di sini.</p>' },
  { slug: 'kebijakan-refund', title: 'Kebijakan Refund', content: '<p>Jelaskan kebijakan pengembalian dana / refund toko Anda di sini.</p>' },
  { slug: 'faq', title: 'FAQ', content: '<p>Kumpulan pertanyaan yang sering diajukan beserta jawabannya. Edit dari panel admin.</p>' },
  { slug: 'cara-pemesanan', title: 'Cara Pemesanan', content: '<p>Langkah-langkah cara memesan produk di toko Anda. Edit dari panel admin.</p>' },
  { slug: 'hubungi-kami', title: 'Hubungi Kami', content: '<p>Cara menghubungi toko: email, WhatsApp, dan media sosial. Edit dari panel admin.</p>' }
];
const insPage = db.prepare('INSERT OR IGNORE INTO pages (slug, title, content, is_active) VALUES (?,?,?,1)');
DEFAULT_PAGES.forEach(function (p) { insPage.run(p.slug, p.title, p.content); });

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm'];
    if(allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan JPG, PNG, GIF, WebP, MP4, atau WebM'));
  }
});

// Upload khusus file backup (.tar.gz) — tanpa filter gambar
const restoreTmpDir = path.join(dataDir, 'restore-tmp');
if (!fs.existsSync(restoreTmpDir)) fs.mkdirSync(restoreTmpDir, { recursive: true });
const uploadBackup = multer({ dest: restoreTmpDir, limits: { fileSize: 1024 * 1024 * 1024 } });

// WATERMARK
async function applyWatermark(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if(['.gif','.mp4','.webm'].includes(ext)) return;
  try {
    const settings = getSettings();
    // Cek apakah watermark aktif
    if(String(settings.watermark) === '0') return;
    const storeName = settings.storeName || settings.store_name || 'Cellyn Store';
    const img = sharp(filePath);
    const meta = await img.metadata();
    const w = meta.width || 800;
    const h = meta.height || 600;
    const fontSize = Math.max(12, Math.round(w * 0.035));
    const padding = Math.round(fontSize * 0.6);
    const textW = storeName.length * fontSize * 0.6 + padding * 2;
    const textH = fontSize + padding * 2;
    const svgWm = Buffer.from(`<svg width="${Math.ceil(textW)}" height="${Math.ceil(textH)}"><rect x="0" y="0" width="${Math.ceil(textW)}" height="${Math.ceil(textH)}" rx="4" fill="rgba(0,0,0,0.45)"/><text x="${padding}" y="${fontSize+padding*0.5}" font-size="${fontSize}" font-family="Arial,sans-serif" fill="rgba(255,255,255,0.85)" font-weight="bold">${storeName}</text></svg>`);
    const margin = Math.round(Math.min(w,h) * 0.02);
    const left = Math.max(0, w - Math.ceil(textW) - margin);
    const top = Math.max(0, h - Math.ceil(textH) - margin);
    await img
      .composite([{ input: svgWm, left, top }])
      .toFile(filePath + '_wm.tmp');
    fs.renameSync(filePath + '_wm.tmp', filePath);
  } catch(e) {
    console.error('Watermark error:', e.message);
  }
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Escape untuk konteks HTML/atribut (cegah injeksi lewat data produk/toko)
function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Token acak untuk CSRF / session
function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Proteksi CSRF (double-submit cookie) untuk request yang mengubah data
function csrfProtect(req, res, next) {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const cookieToken = req.cookies && req.cookies.csrf_token;
  const headerToken = req.get('X-CSRF-Token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF token tidak valid' });
  }
  next();
}

function issueCsrfCookie(req, res) {
  let token = req.cookies && req.cookies.csrf_token;
  if (!token) {
    token = randomToken();
    res.cookie('csrf_token', token, { httpOnly: false, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  }
  return token;
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function getSession(req) {
  const sid = req.cookies && req.cookies.session_id;
  if (!sid) return null;
  const now = new Date().toISOString();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(sid, now);
  if (!session) return null;
  return db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(session.user_id);
}

function requireAuth(req, res, next) {
  const user = getSession(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

function audit(user, action, entity_type, entity_id, detail) {
  try {
    db.prepare('INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, detail) VALUES (?,?,?,?,?,?)')
      .run(user && user.id ? user.id : null, user && user.username ? user.username : 'system', action, entity_type, entity_id || null, detail || null);
  } catch (_) {}
}

const SETTINGS_MAP = {
  storeName: 'store_name',
  tagline: 'tagline',
  description: 'description',
  heroDesc: 'hero_desc',
  whatsappNumber: 'whatsapp_number',
  heroPill: 'hero_pill',
  heroTitle: 'hero_title',
  heroSubtitle: 'hero_subtitle',
  primaryColor: 'primary_color',
  secondaryColor: 'secondary_color',
  bgColor: 'bg_color',
  fontFamily: 'font_family',
  footerText: 'footer_text',
  logoPath: 'logo_path',
  bannerPath: 'banner_path',
  qrisImagePath: 'qris_image_path',
  discordUrl: 'discord_url',
  contactEmail: 'contact_email',
  operatingHours: 'operating_hours',
  instagramUrl: 'instagram_url',
  tiktokUrl: 'tiktok_url',
  facebookUrl: 'facebook_url'
};

const SNAKE_TO_CAMEL = {};
Object.keys(SETTINGS_MAP).forEach(function(k) { SNAKE_TO_CAMEL[SETTINGS_MAP[k]] = k; });

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  rows.forEach(function(row) {
    const camel = SNAKE_TO_CAMEL[row.key] || row.key;
    result[camel] = row.value;
  });
  return result;
}

function saveSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// AUTH
app.post('/api/login', loginLimiter, function(req, res) {
  const username = req.body.username;
  const password = req.body.password;
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  const sid = generateSessionId();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sid, user.id, expires);
  res.cookie('session_id', sid, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  issueCsrfCookie(req, res);
  audit(user, 'LOGIN', 'user', user.id, 'Login berhasil');
  res.json({ success: true, user: { id: user.id, username: user.username, role: user.role }, mustChangePassword: !!user.must_change_pw });
});

app.post('/api/logout', function(req, res) {
  const sid = req.cookies && req.cookies.session_id;
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  res.clearCookie('session_id');
  res.json({ success: true });
});

app.get('/api/me', function(req, res) {
  const user = getSession(req);
  if (!user) return res.json({ authenticated: false, user: null });
  // Pastikan cookie CSRF tersedia untuk sesi yang sudah login
  const csrfToken = issueCsrfCookie(req, res);
  const full = db.prepare('SELECT must_change_pw FROM users WHERE id = ?').get(user.id);
  res.json({
    authenticated: true,
    user: { id: user.id, username: user.username, role: user.role },
    mustChangePassword: !!(full && full.must_change_pw),
    csrfToken
  });
});

app.post('/api/admin/change-password', requireAuth, function(req, res) {
  const currentPassword = req.body.currentPassword || req.body.old_password;
  const newPassword = req.body.newPassword || req.body.new_password;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Password lama dan baru wajib diisi' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Password saat ini salah' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ?, must_change_pw = 0 WHERE id = ?').run(hash, req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  res.clearCookie('session_id');
  audit(req.user, 'CHANGE_PASSWORD', 'user', req.user.id, 'Password diubah');
  res.json({ success: true, message: 'Password berhasil diubah' });
});

// DASHBOARD
app.get('/api/admin/dashboard', requireAuth, function(req, res) {
  const totalProducts = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  const activeProducts = db.prepare('SELECT COUNT(*) as c FROM products WHERE status = ?').get('active').c;
  const lowStock = db.prepare('SELECT COUNT(*) as c FROM products WHERE stock <= 5 AND status = ?').get('active').c;
  const categories = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
  res.json({ totalProducts, activeProducts, lowStock, totalCategories: categories });
});

// PRODUCTS
app.get('/api/admin/products', requireAuth, function(req, res) {
  const products = db.prepare(
    'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id ORDER BY p.sort_order ASC, p.id DESC'
  ).all();
  res.json(products);
});

// Aksi massal: hapus / tampilkan / sembunyikan beberapa produk sekaligus
app.post('/api/admin/products/bulk', requireAuth, function(req, res) {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  const action = req.body.action;
  if (!ids.length) return res.status(400).json({ error: 'Tidak ada produk dipilih' });
  const ph = ids.map(() => '?').join(',');
  if (action === 'delete') {
    db.prepare('DELETE FROM products WHERE id IN (' + ph + ')').run(...ids);
  } else if (action === 'show' || action === 'hide') {
    const status = action === 'show' ? 'active' : 'draft';
    db.prepare('UPDATE products SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id IN (' + ph + ')').run(status, ...ids);
  } else {
    return res.status(400).json({ error: 'Aksi tidak dikenal' });
  }
  audit(req.user, action.toUpperCase(), 'product', 0, 'Aksi massal ' + action + ' (' + ids.length + ' produk)');
  res.json({ success: true, count: ids.length });
});

// Urutkan ulang produk (drag & drop admin): body { order:[id,...] }
app.post('/api/admin/products/reorder', requireAuth, function(req, res) {
  const order = Array.isArray(req.body.order) ? req.body.order.map(Number).filter(Boolean) : [];
  if (!order.length) return res.status(400).json({ error: 'Urutan kosong' });
  const upd = db.prepare('UPDATE products SET sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  const tx = db.transaction(list => { list.forEach((id, i) => upd.run(i + 1, id)); });
  tx(order);
  audit(req.user, 'REORDER', 'product', 0, 'Urutan produk diperbarui');
  res.json({ success: true });
});

app.post('/api/admin/products', requireAuth, function(req, res) {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Nama produk wajib' });
  let slug = slugify(b.name);
  if (db.prepare('SELECT id FROM products WHERE slug = ?').get(slug)) slug = slug + '-' + Date.now();
  const result = db.prepare(
    'INSERT INTO products (name, slug, sku, category_id, price, original_price, stock, status, badge, summary, description, featured, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(b.name, slug, b.sku || null, b.category_id || null, b.price || 0, b.original_price || null, b.stock || 0, b.status || 'active', b.badge || null, b.summary || null, b.description || null, b.featured ? 1 : 0, b.sort_order || 99);
  audit(req.user, 'CREATE', 'product', result.lastInsertRowid, 'Produk dibuat');
  res.json({ id: result.lastInsertRowid, slug });
});

app.put('/api/admin/products/:id', requireAuth, function(req, res) {
  const id = req.params.id;
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Nama produk wajib' });
  // Pertahankan status unggulan bila tidak dikirim (dikelola terpisah lewat toggle)
  const cur = db.prepare('SELECT featured FROM products WHERE id = ?').get(id);
  const featuredVal = (b.featured === undefined || b.featured === null) ? (cur ? cur.featured : 0) : (b.featured ? 1 : 0);
  db.prepare(
    'UPDATE products SET name=?, sku=?, category_id=?, price=?, original_price=?, stock=?, status=?, badge=?, summary=?, description=?, featured=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(b.name, b.sku || null, b.category_id || null, b.price || 0, b.original_price || null, b.stock || 0, b.status || 'active', b.badge || null, b.summary || null, b.description || null, featuredVal, b.sort_order || 99, id);
  audit(req.user, 'UPDATE', 'product', id, 'Produk diperbarui');
  res.json({ id: Number(id), success: true });
});

// Toggle status unggulan (hero) tanpa mengubah field lain
app.put('/api/admin/products/:id/featured', requireAuth, function(req, res) {
  const val = req.body.featured ? 1 : 0;
  db.prepare('UPDATE products SET featured = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(val, req.params.id);
  audit(req.user, 'UPDATE', 'product', req.params.id, 'Set unggulan=' + val);
  res.json({ success: true, featured: val });
});

app.delete('/api/admin/products/:id', requireAuth, function(req, res) {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  audit(req.user, 'DELETE', 'product', req.params.id, 'Produk dihapus');
  res.json({ success: true });
});

// Crop gambar produk ke rasio 16:9 (seragam di kartu, hero, & galeri)
async function cropTo169(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.gif', '.mp4', '.webm'].includes(ext)) return; // jangan crop animasi/video
  try {
    const buf = await sharp(filePath).resize(1280, 720, { fit: 'cover', position: 'centre' }).toBuffer();
    fs.writeFileSync(filePath, buf);
  } catch (e) { console.error('Crop 16:9 error:', e.message); }
}

app.post('/api/admin/products/:id/image-upload', requireAuth, upload.single('file'), async function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
  await cropTo169(req.file.path);
  await applyWatermark(req.file.path);
  const imageUrl = '/uploads/' + req.file.filename;
  db.prepare('UPDATE products SET image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(imageUrl, req.params.id);
  res.json({ success: true, image: imageUrl });
});

// CATEGORIES
app.get('/api/admin/categories', requireAuth, function(req, res) {
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all());
});

app.post('/api/admin/categories', requireAuth, function(req, res) {
  const name = req.body.name;
  const description = req.body.description;
  if (!name) return res.status(400).json({ error: 'Nama kategori wajib' });
  let slug = slugify(name);
  if (db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug)) slug = slug + '-' + Date.now();
  const result = db.prepare('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)').run(name, slug, description || null);
  audit(req.user, 'CREATE', 'category', result.lastInsertRowid, 'Kategori dibuat');
  res.json({ id: result.lastInsertRowid, slug });
});

app.put('/api/admin/categories/:id', requireAuth, function(req, res) {
  const id = req.params.id;
  const name = req.body.name;
  const description = req.body.description;
  if (!name) return res.status(400).json({ error: 'Nama kategori wajib' });
  db.prepare('UPDATE categories SET name = ?, description = ? WHERE id = ?').run(name, description || null, id);
  audit(req.user, 'UPDATE', 'category', id, 'Kategori diperbarui');
  res.json({ id: Number(id), success: true });
});

app.delete('/api/admin/categories/:id', requireAuth, function(req, res) {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  audit(req.user, 'DELETE', 'category', req.params.id, 'Kategori dihapus');
  res.json({ success: true });
});

app.post('/api/admin/categories/reorder', requireAuth, function(req, res) {
  let ids = [];
  if (Array.isArray(req.body.items)) {
    ids = req.body.items.map(function(x) { return x.id; });
  } else if (Array.isArray(req.body.order)) {
    ids = req.body.order;
  } else {
    return res.status(400).json({ error: 'Format tidak valid' });
  }
  const update = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
  db.transaction(function(arr) { arr.forEach(function(id, i) { update.run(i + 1, id); }); })(ids);
  audit(req.user, 'REORDER', 'category', null, 'Urutan kategori diubah');
  res.json({ success: true });
});

app.post('/api/admin/categories/:id/icon-upload', requireAuth, upload.single('file'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
  const iconUrl = '/uploads/' + req.file.filename;
  db.prepare('UPDATE categories SET icon_url = ? WHERE id = ?').run(iconUrl, req.params.id);
  res.json({ success: true, icon_url: iconUrl });
});

// SETTINGS
app.get('/api/admin/settings', requireAuth, function(req, res) {
  res.json(getSettings());
});

app.put('/api/admin/settings', requireAuth, function(req, res) {
  Object.keys(req.body).forEach(function(camelKey) {
    const value = req.body[camelKey];
    if (value === undefined || value === null) return;
    const snakeKey = SETTINGS_MAP[camelKey] || camelKey;
    saveSetting(snakeKey, String(value));
  });
  audit(req.user, 'UPDATE', 'settings', null, 'Pengaturan diperbarui');
  res.json({ success: true });
});

// PAGES (admin) — kelola halaman informasi toko
app.get('/api/admin/pages', requireAuth, function(req, res) {
  res.json(db.prepare('SELECT * FROM pages ORDER BY id ASC').all());
});

app.put('/api/admin/pages/:id', requireAuth, function(req, res) {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Halaman tidak ditemukan' });
  const b = req.body || {};
  const title = (b.title != null ? String(b.title).trim() : page.title) || page.title;
  const content = b.content != null ? String(b.content) : page.content;
  db.prepare('UPDATE pages SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, content, req.params.id);
  audit(req.user, 'UPDATE', 'page', req.params.id, 'Halaman "' + title + '" diperbarui');
  res.json({ success: true });
});

app.put('/api/admin/pages/:id/toggle', requireAuth, function(req, res) {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Halaman tidak ditemukan' });
  const val = page.is_active ? 0 : 1;
  db.prepare('UPDATE pages SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(val, req.params.id);
  audit(req.user, 'UPDATE', 'page', req.params.id, 'Halaman "' + page.title + '" ' + (val ? 'diaktifkan' : 'dinonaktifkan'));
  res.json({ success: true, is_active: val });
});

app.post('/api/admin/logo-upload', requireAuth, upload.single('file'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
  const url = '/uploads/' + req.file.filename;
  saveSetting('logo_path', url);
  res.json({ success: true, path: url });
});

app.post('/api/admin/banner-upload', requireAuth, upload.single('file'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
  const url = '/uploads/' + req.file.filename;
  saveSetting('banner_path', url);
  res.json({ success: true, path: url });
});

app.post('/api/admin/qris-upload', requireAuth, upload.single('file'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
  const url = '/uploads/' + req.file.filename;
  saveSetting('qris_image_path', url);
  res.json({ success: true, path: url });
});

// STOREFRONT
app.get('/api/storefront', function(req, res) {
  const settings = getSettings();
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all();
  const products = db.prepare(
    'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.status = ? ORDER BY p.sort_order ASC, p.id DESC'
  ).all('active');
  // Tambah variants ke setiap produk
  // Ambil semua varian dalam SATU query lalu kelompokkan (hindari N+1 saat produk banyak).
  const allVariants = db.prepare('SELECT * FROM product_variants ORDER BY sort_order ASC, id ASC').all();
  const variantsByProduct = {};
  for (const v of allVariants) { (variantsByProduct[v.product_id] = variantsByProduct[v.product_id] || []).push(v); }
  products.forEach(p => { p.variants = variantsByProduct[p.id] || []; });
  const notifications = db.prepare('SELECT * FROM notifications WHERE is_read = 0 ORDER BY created_at DESC LIMIT 3').all();
  const banners = db.prepare('SELECT * FROM banners WHERE active=1 ORDER BY sort_order ASC, id ASC').all();
  // Map settings ke snake_case untuk store object
  const store = {
    name: settings.storeName || settings.store_name || 'Cellyn Store',
    tagline: settings.tagline || '',
    description: settings.description || '',
    hero_pill: settings.heroPill || settings.hero_pill || '',
    hero_title: settings.heroTitle || settings.hero_title || '',
    hero_subtitle: settings.heroSubtitle || settings.hero_subtitle || '',
    hero_desc: settings.heroDesc || settings.hero_desc || settings.tagline || '',
    footer_text: settings.footerText || '',
    logo_path: settings.logoPath || '',
    banner_path: settings.bannerPath || '',
    primary_color: settings.primaryColor || '',
    secondary_color: settings.secondaryColor || '',
    bg_color: settings.bgColor || '',
    font_family: settings.fontFamily || '',
    qris_image_path: settings.qrisImagePath || '',
    whatsapp_number: settings.whatsappNumber || '',
    discord_url: settings.discordUrl || 'https://discord.gg/cellynstore',
    wa_template: settings.wa_template || '',
    contact_email: settings.contactEmail || '',
    operating_hours: settings.operatingHours || '',
    instagram_url: settings.instagramUrl || '',
    tiktok_url: settings.tiktokUrl || '',
    facebook_url: settings.facebookUrl || ''
  };
  const pages = db.prepare('SELECT slug, title FROM pages WHERE is_active = 1 ORDER BY id ASC').all();
  res.json({ store, settings, categories, products, notifications, banners, pages });
});

app.get('/api/categories', function(req, res) {
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all());
});

app.get('/api/products', function(req, res) {
  const category = req.query.category;
  const search = req.query.search;
  const limit = req.query.limit;
  let sql = 'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.status = ?';
  const params = ['active'];
  if (category && category !== 'all') { sql += ' AND c.slug = ?'; params.push(category); }
  if (search) {
    sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.badge LIKE ? OR p.summary LIKE ?)';
    const q = '%' + search + '%';
    params.push(q, q, q, q);
  }
  sql += ' ORDER BY p.sort_order ASC, p.id DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
  res.json(db.prepare(sql).all(...params));
});

// Migrate tambah kolom jika belum ada
try { db.prepare('ALTER TABLE products ADD COLUMN sold_count INTEGER DEFAULT 0').run(); } catch(e) {}
try { db.prepare('ALTER TABLE products ADD COLUMN view_count INTEGER DEFAULT 0').run(); } catch(e) {}
try { db.prepare('ALTER TABLE products ADD COLUMN thumbnail TEXT').run(); } catch(e) {}

// PRODUCT THUMBNAIL UPLOAD
app.post('/api/admin/products/:id/thumb-upload', requireAuth, upload.single('file'), async function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
  await cropTo169(req.file.path);
  await applyWatermark(req.file.path);
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE products SET thumbnail=? WHERE id=?').run(url, req.params.id);
  res.json({ success: true, thumbnail: url });
});

// REVIEWS
app.get('/api/products/:id/reviews', function(req, res) {
  const reviews = db.prepare("SELECT * FROM reviews WHERE product_id=? AND status='approved' ORDER BY created_at DESC").all(req.params.id);
  const stats = db.prepare("SELECT COUNT(*) as total, AVG(rating) as avg FROM reviews WHERE product_id=? AND status='approved'").get(req.params.id);
  res.json({ reviews, total: stats.total, avg: Math.round((stats.avg||0)*10)/10 });
});

app.post('/api/products/:id/reviews', reviewLimiter, function(req, res) {
  const { name, rating, comment } = req.body;
  if(!name||!rating) return res.status(400).json({ error: 'Nama dan rating wajib' });
  if(rating<1||rating>5) return res.status(400).json({ error: 'Rating harus 1-5' });
  const r = db.prepare("INSERT INTO reviews (product_id,name,rating,comment,status) VALUES (?,?,?,?,'pending')").run(req.params.id, name.slice(0,50), Number(rating), (comment||'').slice(0,500));
  res.json({ success: true, id: r.lastInsertRowid });
});

app.get('/api/admin/reviews', requireAuth, function(req, res) {
  const reviews = db.prepare('SELECT r.*, p.name as product_name FROM reviews r LEFT JOIN products p ON r.product_id=p.id ORDER BY r.created_at DESC').all();
  res.json(reviews);
});

app.put('/api/admin/reviews/:id/approve', requireAuth, function(req, res) {
  db.prepare("UPDATE reviews SET status='approved' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.put('/api/admin/reviews/:id/reject', requireAuth, function(req, res) {
  db.prepare("UPDATE reviews SET status='rejected' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/reviews/:id', requireAuth, function(req, res) {
  db.prepare('DELETE FROM reviews WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// PRODUCT VARIANTS
app.get('/api/admin/products/:id/variants', requireAuth, function(req, res) {
  res.json(db.prepare('SELECT * FROM product_variants WHERE product_id=? ORDER BY sort_order ASC, id ASC').all(req.params.id));
});

app.post('/api/admin/products/:id/variants', requireAuth, function(req, res) {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Nama varian wajib' });
  const r = db.prepare('INSERT INTO product_variants (product_id,name,price,original_price,stock,sort_order,description) VALUES (?,?,?,?,?,?,?)').run(
    req.params.id, b.name, Number(b.price||0), b.original_price||null, Number(b.stock||0), Number(b.sort_order||99), b.description||null
  );
  res.json({ id: r.lastInsertRowid, success: true });
});

app.put('/api/admin/variants/:id', requireAuth, function(req, res) {
  const b = req.body;
  db.prepare('UPDATE product_variants SET name=?,price=?,original_price=?,stock=?,sort_order=?,description=? WHERE id=?').run(
    b.name, Number(b.price||0), b.original_price||null, Number(b.stock||0), Number(b.sort_order||99), b.description||null, req.params.id
  );
  res.json({ success: true });
});

app.delete('/api/admin/variants/:id', requireAuth, function(req, res) {
  db.prepare('DELETE FROM product_variants WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// PRODUCT VIEW ENDPOINT
app.post('/api/products/:id/view', function(req, res) {
  db.prepare('UPDATE products SET view_count = COALESCE(view_count,0)+1 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// TRACK ORDER — dipanggil saat customer benar-benar checkout (klik WhatsApp),
// menambah sold_count per produk. Tidak dipanggil saat sekadar melihat keranjang.
app.post('/api/track-order', function(req, res) {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const stmt = db.prepare('UPDATE products SET sold_count = COALESCE(sold_count,0)+? WHERE id=?');
  const tx = db.transaction(function(arr) {
    arr.forEach(function(it) {
      const id = it && it.id;
      const qty = Math.max(1, Number(it && it.qty || 1));
      if (id) stmt.run(qty, id);
    });
  });
  try { tx(items); } catch (e) {}
  res.json({ success: true });
});
app.post('/api/build-whatsapp-link', function(req, res) {
  const items = req.body.items || [];
  if (!items.length) return res.status(400).json({ error: 'Keranjang kosong' });
  const settings = getSettings();
  let wa = settings.whatsappNumber || '';
  wa = wa.replace(/\D/g, '');
  if (wa.startsWith('0')) wa = '62' + wa.slice(1);
  if (!wa) wa = '6200000000000';
  const lines = items.map(function(i) {
    return `• ${i.name} x${i.qty} = Rp${new Intl.NumberFormat('id-ID').format(i.price * i.qty)}`;
  });
  const total = items.reduce(function(a, b) { return a + (b.price * b.qty); }, 0);
  const totalStr = 'Rp' + new Intl.NumberFormat('id-ID').format(total);
  const storeName = settings.storeName || settings.store_name || 'Cellyn Store';
  const jumlahItem = String(items.reduce((a,b)=>a+b.qty, 0));
  const tmpl = settings.wa_template || '';
  let message;
  if (tmpl) {
    message = tmpl
      .replace(/{{items}}/g, lines.join('\n'))
      .replace(/{{total}}/g, totalStr)
      .replace(/{{nama_toko}}/g, storeName)
      .replace(/{{jumlah_item}}/g, jumlahItem);
  } else {
    message = `Halo, saya ingin order:\n\n${lines.join('\n')}\n\nTotal: ${totalStr}\n\nMohon konfirmasi ketersediaan. Terima kasih!`;
  }
  const waLink = `https://wa.me/${wa}?text=${encodeURIComponent(message)}`;
  res.json({ success: true, waLink, message });
});

// BANNERS
app.get('/api/admin/banners', requireAuth, function(req, res) {
  res.json(db.prepare('SELECT * FROM banners ORDER BY sort_order ASC, id ASC').all());
});

app.post('/api/admin/banners', requireAuth, function(req, res) {
  const b = req.body;
  const result = db.prepare('INSERT INTO banners (title, badge, sort_order, active) VALUES (?,?,?,?)').run(b.title||'', b.badge||'', b.sort_order||99, 1);
  audit(req.user, 'CREATE', 'banner', result.lastInsertRowid, 'Banner dibuat');
  res.json({ id: result.lastInsertRowid, success: true });
});

app.put('/api/admin/banners/:id', requireAuth, function(req, res) {
  const b = req.body;
  db.prepare('UPDATE banners SET title=?, badge=?, sort_order=?, active=? WHERE id=?').run(b.title||'', b.badge||'', b.sort_order||99, b.active!==undefined?b.active:1, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/banners/:id', requireAuth, function(req, res) {
  db.prepare('DELETE FROM banners WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/banners/:id/image-upload', requireAuth, upload.single('file'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE banners SET image_path=? WHERE id=?').run(url, req.params.id);
  res.json({ success: true, image_path: url });
});

// NOTIFICATIONS
app.get('/api/admin/notifications', requireAuth, function(req, res) {
  res.json(db.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all());
});

app.post('/api/admin/notifications', requireAuth, function(req, res) {
  const title = req.body.title;
  const message = req.body.message;
  if (!title) return res.status(400).json({ error: 'Judul wajib diisi' });
  const result = db.prepare('INSERT INTO notifications (title, message) VALUES (?, ?)').run(title, message || null);
  audit(req.user, 'CREATE', 'notification', result.lastInsertRowid, 'Notifikasi dibuat');
  res.json({ id: result.lastInsertRowid, success: true });
});

app.post('/api/admin/notifications/:id/read', requireAuth, function(req, res) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/notifications/:id', requireAuth, function(req, res) {
  db.prepare('DELETE FROM notifications WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/notifications', function(req, res) {
  res.json(db.prepare('SELECT * FROM notifications WHERE is_read = 0 ORDER BY created_at DESC').all());
});

// AUDIT
app.get('/api/admin/audit-logs', requireAuth, function(req, res) {
  res.json(db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200').all());
});

// EXPORT
app.get('/api/admin/export/products.csv', requireAuth, function(req, res) {
  const products = db.prepare('SELECT p.id,p.name,p.sku,c.name as category,p.price,p.original_price,p.stock,p.status,p.badge,p.summary,p.created_at FROM products p LEFT JOIN categories c ON p.category_id=c.id ORDER BY p.id DESC').all();
  const headers = ['id','name','sku','category','price','original_price','stock','status','badge','summary','created_at'];
  const csv = [headers.join(',')].concat(products.map(function(p) {
    return headers.map(function(h) { return '"' + String(p[h] || '').replace(/"/g, '""') + '"'; }).join(',');
  })).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
  res.send(csv);
});

app.get('/api/admin/export/audit.csv', requireAuth, function(req, res) {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC').all();
  const headers = ['id','username','action','entity_type','entity_id','detail','created_at'];
  const csv = [headers.join(',')].concat(logs.map(function(l) {
    return headers.map(function(h) { return '"' + String(l[h] || '').replace(/"/g, '""') + '"'; }).join(',');
  })).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
  res.send(csv);
});

// BACKUP: unduh 1 file berisi database + semua gambar upload
app.get('/api/admin/backup', requireAuth, function(req, res) {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="cellyn-backup-' + ts + '.tar.gz"');
  const tar = spawn('tar', ['-czf', '-', '-C', __dirname, 'data/store.db', 'public/uploads']);
  tar.stdout.pipe(res);
  tar.stderr.on('data', () => {});
  tar.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: 'Backup gagal: ' + e.message }); });
  try { saveSetting('last_backup_at', new Date().toISOString()); } catch (_) {}
  audit(req.user, 'BACKUP', 'system', null, 'Unduh backup');
});

// RESTORE: upload file backup, timpa database + gambar, lalu restart
app.post('/api/admin/restore', requireAuth, uploadBackup.single('file'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File backup tidak ditemukan' });
  const tmp = req.file.path;
  // 1) Validasi arsip DULU (jangan sentuh data kalau file salah): harus gzip/tar valid & berisi data/store.db
  const check = spawn('tar', ['-tzf', tmp]);
  let listing = '';
  check.stdout.on('data', (d) => { listing += d.toString(); });
  check.stderr.on('data', () => {});
  check.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} if (!res.headersSent) res.status(500).json({ error: 'Gagal membaca arsip: ' + e.message }); });
  check.on('close', (checkCode) => {
    const hasDb = listing.split('\n').some((l) => { const t = l.trim(); return t === 'data/store.db' || t === './data/store.db'; });
    if (checkCode !== 0 || !hasDb) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (!res.headersSent) res.status(400).json({ error: 'File backup tidak valid (bukan arsip backup Cellyn Store). Data TIDAK diubah.' });
      return;
    }
    // 2) Valid → simpan salinan pengaman lalu timpa
    try { fs.copyFileSync(path.join(dataDir, 'store.db'), path.join(dataDir, 'store.db.prev')); } catch (_) {}
    const tar = spawn('tar', ['-xzf', tmp, '-C', __dirname]);
    tar.stderr.on('data', () => {});
    tar.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} if (!res.headersSent) res.status(500).json({ error: 'Restore gagal: ' + e.message }); });
    tar.on('close', (code) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (code !== 0) { if (!res.headersSent) res.status(500).json({ error: 'Restore gagal (arsip rusak?)' }); return; }
      // Buang WAL lama agar SQLite membaca store.db hasil restore saat restart
      try { fs.unlinkSync(path.join(dataDir, 'store.db-wal')); } catch (_) {}
      try { fs.unlinkSync(path.join(dataDir, 'store.db-shm')); } catch (_) {}
      audit(req.user, 'RESTORE', 'system', null, 'Restore backup');
      res.json({ success: true, message: 'Restore berhasil. Server akan restart, silakan muat ulang & login kembali.' });
      setTimeout(() => process.exit(0), 1500);
    });
  });
});

app.get('/secretadmin', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'secretadmin.html'));
});

// HALAMAN INFORMASI TOKO (publik): /page/:slug — nonaktif/tidak ada => 404
app.get('/page/:slug', function(req, res) {
  const s = getSettings();
  const storeName = s.storeName || s.store_name || 'Cellyn Store';
  const logo = s.logoPath || '';
  const page = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
  if (!page || !page.is_active) {
    return res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(renderPageHtml({
      storeName: storeName, logo: logo, title: 'Halaman tidak ditemukan',
      body: '<p>Halaman yang Anda cari tidak tersedia atau sedang dinonaktifkan.</p>',
      pages: [], notFound: true
    }));
  }
  // Konten ditulis admin (tepercaya); buang tag <script> sebagai pengaman tambahan
  const body = String(page.content || '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const pages = db.prepare('SELECT slug, title FROM pages WHERE is_active = 1 ORDER BY id ASC').all();
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderPageHtml({
    storeName: storeName, logo: logo, title: page.title, body: body, pages: pages,
    updatedAt: page.updated_at
  }));
});

function renderPageHtml(o) {
  const title = escHtml(o.title);
  const store = escHtml(o.storeName);
  const logoHtml = o.logo
    ? `<img src="${escHtml(o.logo)}" alt="${store}" style="width:32px;height:32px;border-radius:6px;object-fit:cover">`
    : `<span class="pg-logo-ph">${store.charAt(0) || 'C'}</span>`;
  const nav = (o.pages || []).map(function(p) {
    return `<a href="/page/${escHtml(p.slug)}">${escHtml(p.title)}</a>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ${store}</title>
${o.notFound ? '<meta name="robots" content="noindex">' : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#141414;color:#e5e5e5;line-height:1.7;min-height:100vh;display:flex;flex-direction:column}
a{color:#E50914;text-decoration:none}
a:hover{text-decoration:underline}
.pg-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:10px;padding:14px 5vw;background:rgba(10,10,10,0.9);backdrop-filter:blur(8px);border-bottom:1px solid #242424}
.pg-header .name{font-weight:900;color:#E50914;letter-spacing:0.04em;text-transform:uppercase;font-size:15px}
.pg-logo-ph{width:32px;height:32px;border-radius:6px;background:#E50914;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900}
.pg-wrap{flex:1;max-width:860px;width:100%;margin:0 auto;padding:36px 5vw 60px}
.pg-title{font-size:clamp(24px,4vw,34px);font-weight:900;color:#fff;margin-bottom:6px}
.pg-updated{font-size:12px;color:#808080;margin-bottom:26px}
.pg-content{font-size:15.5px;color:#cfcfcf}
.pg-content h1,.pg-content h2,.pg-content h3{color:#fff;font-weight:800;margin:26px 0 10px;line-height:1.3}
.pg-content h2{font-size:21px}.pg-content h3{font-size:17px}
.pg-content p{margin:0 0 14px}
.pg-content ul,.pg-content ol{margin:0 0 14px;padding-left:22px}
.pg-content li{margin:6px 0}
.pg-content img{max-width:100%;height:auto;border-radius:10px;margin:10px 0}
.pg-content a{text-decoration:underline}
.pg-content blockquote{border-left:3px solid #E50914;padding:6px 16px;margin:14px 0;background:#1c1c1c;border-radius:0 8px 8px 0;color:#bdbdbd}
.pg-back{display:inline-flex;align-items:center;gap:6px;margin-top:24px;padding:11px 20px;background:#1f1f1f;border:1px solid #333;border-radius:6px;color:#fff;font-weight:700;font-size:14px}
.pg-back:hover{background:#2a2a2a;text-decoration:none}
.pg-back svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pg-footer{border-top:1px solid #242424;background:#0b0b0b;padding:26px 5vw;text-align:center}
.pg-footer .fnav{display:flex;flex-wrap:wrap;gap:10px 20px;justify-content:center;margin-bottom:14px}
.pg-footer .fnav a{color:#a3a3a3;font-size:13px;font-weight:600}
.pg-footer .fnav a:hover{color:#fff}
.pg-copy{font-size:12px;color:#6b6b6b}
</style>
</head>
<body>
<header class="pg-header">
  <a href="/" style="display:flex;align-items:center;gap:10px">${logoHtml}<span class="name">${store}</span></a>
</header>
<main class="pg-wrap">
  <h1 class="pg-title">${title}</h1>
  ${o.updatedAt ? `<div class="pg-updated">Diperbarui: ${escHtml(String(o.updatedAt).slice(0, 10))}</div>` : ''}
  <div class="pg-content">${o.body || ''}</div>
  <a class="pg-back" href="/"><svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Kembali ke beranda</a>
</main>
<footer class="pg-footer">
  ${nav ? `<div class="fnav">${nav}</div>` : ''}
  <div class="pg-copy">&copy; ${new Date().getFullYear()} ${store}</div>
</footer>
</body>
</html>`;
}

// BOT DETECTION + OG META TAG INJECTION
const BOT_UA = /whatsapp|telegram|twitterbot|facebookexternalhit|linkedinbot|slackbot|discordbot|googlebot|bingbot|applebot|pinterest|vkshare|w3c_validator|curl|wget|python-requests|scrapy/i;

function buildOGHtml(meta) {
  const title = escHtml(meta.title);
  const description = escHtml(meta.description);
  const image = escHtml(meta.image);
  const url = escHtml(meta.url);
  const siteName = escHtml(meta.siteName);
  const urlJson = JSON.stringify(String(meta.url || '')); // aman untuk konteks JS string
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:site_name" content="${siteName}">
<meta property="og:locale" content="id_ID">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
</head>
<body>
<script>window.location.href=${urlJson};</script>
<p>Redirecting... <a href="${url}">Klik di sini</a></p>
</body>
</html>`;
}

app.get('*', function(req, res) {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const ua = req.headers['user-agent'] || '';
  const isBot = BOT_UA.test(ua);
  // Dukung dua bentuk URL: lama "?produk=ID" dan cantik "/produk/ID-slug"
  const produkId = req.query.produk || (req.path.match(/^\/produk\/(\d+)/) || [])[1] || null;
  const siteUrl = 'https://cellynstore.web.id';

  // Bot request untuk sebuah produk — inject meta produk (judul, harga, gambar)
  if (isBot && produkId) {
    try {
      const p = db.prepare('SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.id=? AND p.status="active"').get(produkId);
      if (p) {
        const s = getSettings();
        const storeName = s.storeName || s.store_name || 'Cellyn Store';
        // Harga: pakai harga produk; kalau 0, ambil dari varian (min / "Mulai ...")
        const fmt = n => 'Rp' + new Intl.NumberFormat('id-ID').format(Number(n || 0));
        let priceLabel = '';
        if (Number(p.price || 0) > 0) {
          priceLabel = fmt(p.price) + (Number(p.original_price || 0) > Number(p.price) ? ' (PROMO!)' : '');
        } else {
          const vp = db.prepare('SELECT price FROM product_variants WHERE product_id=?').all(p.id).map(r => Number(r.price || 0)).filter(n => n > 0);
          if (vp.length) { const mn = Math.min(...vp), mx = Math.max(...vp); priceLabel = mn === mx ? fmt(mn) : 'Mulai ' + fmt(mn); }
        }
        const descBase = String(p.summary || p.description || (p.name + ' di ' + storeName)).replace(/<[^>]*>/g, '').slice(0, 140);
        const desc = (priceLabel ? priceLabel + ' \u00b7 ' : '') + descBase;
        // Gambar preview: banner (landscape) dulu, lalu thumbnail, terakhir default
        const imgSrc = p.image || p.thumbnail || '';
        const img = imgSrc ? (imgSrc.startsWith('http') ? imgSrc : siteUrl + imgSrc) : siteUrl + '/uploads/og-default.jpg';
        return res.send(buildOGHtml({
          title: `${p.name} — ${storeName}`,
          description: desc,
          image: img,
          url: `${siteUrl}/produk/${p.id}-${p.slug || ''}`,
          siteName: storeName
        }));
      }
    } catch(e) {}
  }

  // Bot request tanpa produk — inject meta toko
  if (isBot) {
    try {
      const s = getSettings();
      const storeName = s.storeName || s.store_name || 'Cellyn Store';
      const tagline = s.tagline || 'Produk digital premium terpercaya';
      const logo = s.logoPath || s.logo_path || '';
      const img = logo ? (logo.startsWith('http') ? logo : siteUrl+logo) : siteUrl+'/uploads/og-default.jpg';
      return res.send(buildOGHtml({
        title: storeName,
        description: tagline,
        image: img,
        url: siteUrl,
        siteName: storeName
      }));
    } catch(e) {}
  }

  // Browser biasa — serve static index.html
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Not found');
});

// Bersihkan sesi kedaluwarsa secara berkala (dan sekali saat start)
function cleanupExpiredSessions() {
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()); } catch (_) {}
}
cleanupExpiredSessions();
setInterval(cleanupExpiredSessions, 60 * 60 * 1000).unref();

app.listen(PORT, function() { console.log('Cellyn Store running on port ' + PORT); });
