# Aturan Antrian Tiket (WAJIB)

## FIFO dengan tier prioritas Top Spender

Antrian tiket memakai **FIFO dengan tier prioritas**:

1. **Tier prioritas** — tiket milik **Top Spender bulan berjalan** (Top-N, default
   `TOP_SPENDER_TOP_N = 10`) **didahulukan** di barisan tunggu.
2. **FIFO di dalam tier** — sesama tiket prioritas, maupun sesama tiket non-prioritas,
   tetap diurutkan berdasarkan waktu tiket dibuka (`opened_at`, terlama dulu).

> Keputusan ini diambil **secara eksplisit oleh pemilik toko** dan menggantikan
> aturan lama "FIFO ketat tanpa prioritas".

### Deteksi prioritas berbasis DATA, bukan role

- Status prioritas **ditentukan dari DATA transaksi** via
  `cogs/top_spender.get_top_spenders(year, month, limit)` untuk bulan berjalan.
- **JANGAN** memakai role untuk deteksi prioritas. Konstanta
  `TOP_SPENDER_ROLE_ID` di `cogs/top_spender.py` hanya untuk pemberian role
  kosmetik, **bukan** untuk logika antrian.
- Tidak ada faktor prioritas lain (nominal per-transaksi, jenis layanan,
  referral, dsb.). Hanya keanggotaan Top-N bulan berjalan.

## Implikasi untuk kode

- `utils/queue.py`:
  - `normalize_ticket(...)` menerima `priority_ids` (set `member_id`) dan
    menyetel `is_priority = member_id in priority_ids`.
  - `collect_tickets(...)` meneruskan `priority_ids` ke `normalize_ticket`.
  - `build_queue()` mengurutkan dengan key `(not is_priority, opened_at)` →
    tier prioritas dulu, FIFO di dalam tier.
- `cogs/queue.py`:
  - Menghitung `priority_ids = {s["user_id"] for s in get_top_spenders(now.year,
    now.month, TOP_SPENDER_TOP_N)}` lalu meneruskannya ke `collect_tickets`.
  - Papan antrian menandai entri prioritas dengan 👑.
- Tiket berstatus "diproses" (`handling`, di-set lewat `!pay`) dikeluarkan dari
  hitungan **barisan tunggu** — ini independen dari prioritas dan bukan
  pelanggaran aturan.

## Saat menambah fitur baru

- Prioritas **hanya** boleh berbasis Top Spender bulan berjalan seperti di atas.
- Permintaan menambah jenis prioritas lain (mis. role tertentu, booster, nominal)
  harus **diklarifikasi & disetujui pemilik toko** lebih dulu, dan file ini wajib
  diperbarui bila keputusannya berubah.
