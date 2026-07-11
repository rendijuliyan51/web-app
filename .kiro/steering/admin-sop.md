# SOP & Aturan Admin

Standar operasional & pelayanan untuk SEMUA admin (admin lebih dari satu, jadi
pelayanan harus konsisten). Dokumen ini acuan internal tim — bukan untuk member.

## Prinsip pelayanan
1. **Ramah & profesional.** Sapa member, jawab jelas, jangan jutek meski sibuk.
2. **Konsisten.** Semua admin mengikuti alur & harga yang sama. Jangan bikin
   aturan/harga sendiri-sendiri.
3. **Responsif.** Begitu menangani tiket, jalankan `!pay` agar member tahu
   pesanannya sedang diproses (status muncul di papan antrian).
4. **Urut & adil.** Proses tiket berurutan dari yang paling lama menunggu.
   Top Spender bulan berjalan diprioritaskan (otomatis ditandai sistem).

## Alur menangani tiket (standar)
1. Cek detail tiket (produk, nominal, data yang diisi member).
2. `!pay` untuk menandai tiket sedang kamu tangani. (`!unpay` bila batal/dialihkan.)
3. Verifikasi pembayaran (cek bukti transfer/QRIS) sebelum memproses.
4. Proses pesanan sesuai layanan.
5. Tutup tiket dengan command penyelesaian yang sesuai
   (`!acc`, `!gpdone`, `!gift`, `!mlselesai`, `!jbselesai`, dst) — JANGAN hapus
   channel manual, biar transaksi tercatat & garansi/rating berjalan.
6. Ingatkan member memberi rating dalam 24 jam (garansi).

## Yang WAJIB
- Verifikasi pembayaran sebelum kirim/proses barang.
- Catat transaksi lewat command penyelesaian (bukan tutup manual).
- Jaga kerahasiaan data member (akun, email, dll) — jangan disebar.
- Eskalasi ke owner bila ragu / kasus tidak biasa / sengketa.

## Yang DILARANG
- Memproses tanpa verifikasi pembayaran.
- Memberi harga/diskon di luar ketentuan tanpa izin owner.
- Memakai data/akun member untuk keperluan pribadi.
- Menelantarkan tiket yang sudah di-`!pay` (kalau tidak sanggup, `!unpay` agar
  admin lain bisa ambil alih).
- Promosi/jualan pribadi di server.

## Penanganan kasus khusus
- **Scam / penipuan:** tindak tegas — kumpulkan bukti, tutup transaksi, laporkan
  ke owner untuk ban. Tidak ada toleransi.
- **Komplain garansi:** arahkan ke panel/tiket garansi; cek riwayat transaksi
  & rating sebelum memutuskan.
- **Member promosi tanpa izin / jual barang sama:** beri peringatan, hapus
  promosi, eskalasi bila berulang.

## Catatan
File ini steering internal (lihat juga `ticket-queue.md` untuk aturan antrean).
Perbarui bila SOP berubah, dan sampaikan ke seluruh admin.
