# Panduan Deployment TILAYA Telegram Bot

Dokumen ini menjelaskan prosedur deployment produksi untuk bot **TILAYA** pada server Linux menggunakan systemd dan Node.js 22 LTS.

> [!IMPORTANT]
> **Aturan Single-Instance Long Polling**: Token bot Telegram HANYA boleh dijalankan oleh tepat **satu instance aktif**. Menjalankan dua instance atau lebih secara bersamaan akan menyebabkan konflik update (`409 Conflict: terminated by other getUpdates request`).
> Jangan pernah melakukan deployment ke server produksi tanpa persetujuan eksplisit pemilik sistem.

---

## 1. Prasyarat Sistem

- **OS**: Linux (Ubuntu 22.04+, Debian 12+, RHEL 9+, atau AlmaLinux).
- **Node.js**: Node.js **22.x LTS** (`node -v` >= 22.0.0).
- **Process Manager**: systemd.
- **Port Inbound**: **TIDAK ADA**. Bot ini beroperasi penuh menggunakan outbound long-polling ke Telegram API (`https://api.telegram.org`) dan TempMail upstream. Jangan membuka port firewall inbound apa pun.

---

## 2. Pembuatan User Sistem Non-Root

Jalankan perintah berikut sebagai administrator (`root` atau `sudo`):

```bash
# Buat system user dan group unprivileged tanpa shell login
sudo useradd --system --shell /usr/sbin/nologin --home-dir /opt/tilaya-bot tilaya
```

---

## 3. Instalasi Kode dan Dependencies

```bash
# Salin source code ke direktori target
sudo mkdir -p /opt/tilaya-bot
sudo cp -r . /opt/tilaya-bot/
cd /opt/tilaya-bot

# Set kepemilikan folder
sudo chown -R tilaya:tilaya /opt/tilaya-bot

# Pasang dependency produksi sebagai user tilaya
sudo -u tilaya npm ci --omit=dev
```

---

## 4. Konfigurasi Environment dan Direktori State

1. Siapkan direktori konfigurasi dan file `.env`:
   ```bash
   sudo mkdir -p /etc/tilaya-bot
   sudo cp /opt/tilaya-bot/.env.example /etc/tilaya-bot/.env
   sudo chown -R tilaya:tilaya /etc/tilaya-bot
   # Kunci permission ketat 0600
   sudo chmod 600 /etc/tilaya-bot/.env
   sudo chmod 700 /etc/tilaya-bot
   ```

2. Edit `/etc/tilaya-bot/.env` dan sesuaikan nilainya:
   ```env
   BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   ALLOWED_TELEGRAM_IDS=123456789,987654321
   TEMPMAIL_BASE_URL=https://api.tempmail.upstream.com
   SQLITE_PATH=/var/lib/tilaya-bot/tilaya.db
   API_BATCH_SIZE=50
   BULK_DELAY_MS=1000
   POLL_TIMEOUT_MS=75000
   POLL_INTERVAL_MS=5000
   ```

3. Siapkan direktori state untuk SQLite:
   ```bash
   sudo mkdir -p /var/lib/tilaya-bot
   sudo chown -R tilaya:tilaya /var/lib/tilaya-bot
   sudo chmod 700 /var/lib/tilaya-bot
   ```

---

## 5. Pemasangan dan Aktivasi Service systemd

```bash
# 1. Salin file service ke systemd
sudo cp /opt/tilaya-bot/deploy/telegram-tempmail.service /etc/systemd/system/

# 2. Reload daemon systemd
sudo systemctl daemon-reload

# 3. Aktifkan service agar otomatis berjalan saat boot
sudo systemctl enable telegram-tempmail.service

# 4. Jalankan service
sudo systemctl start telegram-tempmail.service

# 5. Periksa status service
sudo systemctl status telegram-tempmail.service
```

---

## 6. Monitoring dan Log Terstruktur

Gunakan `journalctl` untuk memantau log aplikasi secara realtime:

```bash
# Pantau log realtime
sudo journalctl -u telegram-tempmail.service -f

# Tampilkan 100 baris log terakhir
sudo journalctl -u telegram-tempmail.service -n 100 --no-pager
```

> Invarian Keamanan: Log bot secara otomatis disanitasi sehingga tidak mencatat `BOT_TOKEN`, API key, alamat email pengguna, maupun isi pesan/OTP.

---

## 7. Prosedur Pemeliharaan & Operasional

### A. Shutdown dan Restart Graceful
Service telah dikonfigurasi dengan `TimeoutStopSec=15s`. Ketika service dihentikan atau di-restart, bot akan menangkap sinyal `SIGTERM`, memutus koneksi long polling ke Telegram, membatalkan request aktif, dan menutup koneksi basis data SQLite dengan aman.

```bash
# Restart service
sudo systemctl restart telegram-tempmail.service

# Hentikan service
sudo systemctl stop telegram-tempmail.service
```

### B. Backup Database SQLite
Karena SQLite beroperasi dalam mode WAL (`journal_mode = WAL`), backup yang aman dapat dilakukan menggunakan utilitas `sqlite3 .backup` saat bot sedang berjalan:

```bash
# Backup berkala (aman saat service berjalan)
sudo sqlite3 /var/lib/tilaya-bot/tilaya.db ".backup '/var/backups/tilaya-$(date +%Y%m%d-%H%M%S).db'"
sudo chown tilaya:tilaya /var/backups/tilaya-*.db
sudo chmod 600 /var/backups/tilaya-*.db
```

### C. Restore Database
```bash
# 1. Hentikan service
sudo systemctl stop telegram-tempmail.service

# 2. Pulihkan berkas database
sudo cp /var/backups/tilaya-20261108-120000.db /var/lib/tilaya-bot/tilaya.db
sudo chown tilaya:tilaya /var/lib/tilaya-bot/tilaya.db
sudo chmod 600 /var/lib/tilaya-bot/tilaya.db
# Hapus berkas wal dan shm lama bila ada
sudo rm -f /var/lib/tilaya-bot/tilaya.db-wal /var/lib/tilaya-bot/tilaya.db-shm

# 3. Jalankan kembali service
sudo systemctl start telegram-tempmail.service
```

