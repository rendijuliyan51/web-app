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
`);

try { db.exec(`ALTER TABLE products ADD COLUMN original_price INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE categories ADD COLUMN icon_url TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN must_change_pw INTEGER DEFAULT 0`); } catch (_) {}

const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  const hash = bcrypt.hashSync('cellyn123', 10);
  // Tandai wajib ganti password default setelah login pertama
  db.prepare('INSERT INTO users (username, password, role, must_change_pw) VALUES (?, ?, ?, 1)').run('admin', hash, 'admin');
}

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
  discordUrl: 'discord_url'
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

app.post('/api/admin/products/:id/image-upload', requireAuth, upload.single('file'), async function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
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
  const variantStmt = db.prepare('SELECT * FROM product_variants WHERE product_id=? ORDER BY sort_order ASC, id ASC');
  products.forEach(p => { p.variants = variantStmt.all(p.id); });
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
    wa_template: settings.wa_template || ''
  };
  res.json({ store, settings, categories, products, notifications, banners });
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
  const r = db.prepare('INSERT INTO product_variants (product_id,name,price,original_price,stock,sort_order) VALUES (?,?,?,?,?,?)').run(
    req.params.id, b.name, Number(b.price||0), b.original_price||null, Number(b.stock||0), Number(b.sort_order||99)
  );
  res.json({ id: r.lastInsertRowid, success: true });
});

app.put('/api/admin/variants/:id', requireAuth, function(req, res) {
  const b = req.body;
  db.prepare('UPDATE product_variants SET name=?,price=?,original_price=?,stock=?,sort_order=? WHERE id=?').run(
    b.name, Number(b.price||0), b.original_price||null, Number(b.stock||0), Number(b.sort_order||99), req.params.id
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
  audit(req.user, 'BACKUP', 'system', null, 'Unduh backup');
});

// RESTORE: upload file backup, timpa database + gambar, lalu restart
app.post('/api/admin/restore', requireAuth, uploadBackup.single('file'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'File backup tidak ditemukan' });
  const tmp = req.file.path;
  try { fs.copyFileSync(path.join(dataDir, 'store.db'), path.join(dataDir, 'store.db.prev')); } catch (_) {}
  const tar = spawn('tar', ['-xzf', tmp, '-C', __dirname]);
  tar.stderr.on('data', () => {});
  tar.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} if (!res.headersSent) res.status(500).json({ error: 'Restore gagal: ' + e.message }); });
  tar.on('close', (code) => {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (code !== 0) { if (!res.headersSent) res.status(500).json({ error: 'Restore gagal (file backup tidak valid?)' }); return; }
    // Buang WAL lama agar SQLite membaca store.db hasil restore saat restart
    try { fs.unlinkSync(path.join(dataDir, 'store.db-wal')); } catch (_) {}
    try { fs.unlinkSync(path.join(dataDir, 'store.db-shm')); } catch (_) {}
    audit(req.user, 'RESTORE', 'system', null, 'Restore backup');
    res.json({ success: true, message: 'Restore berhasil. Server akan restart, silakan muat ulang & login kembali.' });
    setTimeout(() => process.exit(0), 800);
  });
});

app.get('/secretadmin', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'secretadmin.html'));
});

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
  const produkId = req.query.produk;
  const siteUrl = 'https://cellynstore.web.id';

  // Bot request dengan ?produk=ID — inject meta produk
  if (isBot && produkId) {
    try {
      const p = db.prepare('SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.id=? AND p.status="active"').get(produkId);
      if (p) {
        const s = getSettings();
        const storeName = s.storeName || s.store_name || 'Cellyn Store';
        const price = new Intl.NumberFormat('id-ID').format(p.price);
        const orig = Number(p.original_price||0);
        const hasDisc = orig > Number(p.price);
        const desc = (p.summary || p.description || `Harga: Rp${price}${hasDisc?' (PROMO!)':''} — ${storeName}`).slice(0,200);
        const img = p.image ? (p.image.startsWith('http') ? p.image : siteUrl+p.image) : siteUrl+'/uploads/og-default.jpg';
        return res.send(buildOGHtml({
          title: `${p.name} — ${storeName}`,
          description: desc,
          image: img,
          url: `${siteUrl}/?produk=${p.id}`,
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
