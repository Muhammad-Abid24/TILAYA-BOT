/**
 * Text and UI formatting helpers for Telegram messages.
 */

/**
 * Escapes characters for Telegram HTML mode.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Builds the /start greeting and command summary text.
 *
 * @param {string} [userName]
 * @returns {string}
 */
export function getStartMessage(userName = "Pengguna") {
  const safeName = escapeHtml(userName);
  return (
    `👋 Halo, <b>${safeName}</b>!\n` +
    `Selamat datang di <b>TILAYA</b> — Bot Temporary Email Privat.\n\n` +
    `📋 <b>Daftar Perintah:</b>\n` +
    `• <code>/get</code> — Buat 1 email sementara dengan wizard tipe\n` +
    `• <code>/get N</code> — Buat N email (1–50) dengan wizard tipe\n` +
    `• <code>/bulk</code> — Wizard pembuatan email banyak (1–50)\n` +
    `• <code>/inbox &lt;email&gt;</code> — Cek kotak masuk dan baca pesan email Anda\n` +
    `• <code>/extend</code> — Perpanjang masa aktif alamat email\n` +
    `• <code>/export</code> — Unduh berkas .txt dari batch terakhir Anda\n` +
    `• <code>/stop</code> — Batalkan operasi aktif yang sedang berjalan\n` +
    `• <code>/done</code> — Hapus seluruh riwayat data lokal Anda di bot ini\n\n` +
    `<i>Pilih tombol menu di bawah atau ketik perintah di atas untuk memulai.</i>`
  );
}

/**
 * Builds the inline keyboard menu for /start.
 * Note: Callback data uses simple action identifiers without sensitive data.
 */
export function getStartKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⚡ Get 1 Email", callback_data: "cmd:get:1" },
        { text: "📦 Bulk Generate", callback_data: "cmd:bulk" }
      ],
      [
        { text: "📥 Cek Inbox", callback_data: "cmd:inbox" },
        { text: "⏳ Perpanjang", callback_data: "cmd:extend" }
      ],
      [
        { text: "💾 Export Terakhir", callback_data: "cmd:export" },
        { text: "🗑️ Bersihkan Histori", callback_data: "cmd:done" }
      ]
    ]
  };
}

