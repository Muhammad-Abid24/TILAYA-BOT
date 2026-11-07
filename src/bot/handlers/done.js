import { generateSessionId, WIZARD_TTL_MS } from "../wizard/emailTypeWizard.js";

/**
 * Registers /done command handler.
 *
 * @param {import("telegraf").Telegraf} bot
 */
export function registerDoneHandler(bot) {
  bot.command("done", async (ctx) => {
    await initiateDoneConfirmation(ctx);
  });
}

/**
 * Initiates the /done confirmation message and session.
 *
 * @param {any} ctx
 */
export async function initiateDoneConfirmation(ctx) {
  const userId = ctx.from?.id;
  const { repos } = ctx.services || {};

  const sessionId = generateSessionId();
  const expiresAt = Date.now() + WIZARD_TTL_MS;

  repos.wizardSessions.saveSession({
    id: `done_${sessionId}`,
    userId,
    chatId: ctx.chat.id,
    state: "DONE_CONFIRM",
    payload: {},
    expiresAt
  });

  const text =
    `⚠️ <b>Konfirmasi Pembersihan Data Lokal (/done)</b>\n\n` +
    `Perintah ini akan <b>menghapus seluruh riwayat lokal Anda</b> pada bot TILAYA:\n` +
    `• Seluruh riwayat email yang pernah dibuat\n` +
    `• Berkas export batch terakhir\n` +
    `• Snapshot kotak masuk dan sesi aktif\n\n` +
    `<i>Catatan: Ini HANYA menghapus database lokal pada bot ini dan TIDAK menghapus pesan di server upstream.</i>\n\n` +
    `Apakah Anda yakin ingin menghapus seluruh data Anda?`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🗑️ Ya, Hapus Semua", callback_data: `done:${sessionId}:confirm` },
        { text: "❌ Batal", callback_data: `done:${sessionId}:cancel` }
      ]
    ]
  };

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: keyboard
  });
}

/**
 * Handles callback queries for /done confirmation.
 *
 * @param {any} ctx
 * @returns {Promise<boolean>}
 */
export async function handleDoneCallback(ctx) {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("done:")) {
    return false;
  }

  const userId = ctx.from?.id;
  const parts = data.split(":");
  const sessionId = parts[1];
  const action = parts[2];

  const { repos, operationRegistry } = ctx.services || {};
  const session = repos?.wizardSessions?.getSession(`done_${sessionId}`);

  // 1. Session existence check
  if (!session) {
    await ctx.answerCbQuery(
      "Sesi konfirmasi tidak ditemukan atau telah berakhir.",
      { show_alert: true }
    );
    return true;
  }

  // 2. Ownership check
  if (session.userId !== userId || session.chatId !== ctx.chat?.id) {
    await ctx.answerCbQuery(
      "Akses ditolak: Anda bukan pemilik sesi konfirmasi ini.",
      { show_alert: true }
    );
    return true;
  }

  // 3. Expiration check
  if (session.expiresAt <= Date.now()) {
    repos.wizardSessions.deleteSession(`done_${sessionId}`);
    await ctx.answerCbQuery(
      "Sesi konfirmasi telah kedaluwarsa.",
      { show_alert: true }
    );
    return true;
  }

  // Handle Cancel (AC: cancel tidak menghapus)
  if (action === "cancel") {
    repos.wizardSessions.deleteSession(`done_${sessionId}`);
    await ctx.answerCbQuery("Pembersihan riwayat dibatalkan.");
    try {
      await ctx.editMessageText(
        "❌ <i>Pembersihan riwayat dibatalkan. Seluruh data Anda tetap tersimpan.</i>",
        { parse_mode: "HTML" }
      );
    } catch {
      // Ignore edit failure
    }
    return true;
  }

  // Handle Confirm (AC: confirm menghapus seluruh data lokal user secara transaksional)
  if (action === "confirm") {
    await ctx.answerCbQuery("Membersihkan seluruh data lokal...");

    // 1. Abort active network operations first
    if (operationRegistry) {
      operationRegistry.stopOperation(userId, "Operasi dibatalkan karena perintah /done.");
    }

    // 2. Execute transactional database purge for this user
    repos.userCleaner.clearUserData(userId);

    try {
      await ctx.editMessageText(
        `✅ <b>Seluruh Riwayat Lokal Berhasil Dihapus</b>\n\n` +
        `Semua data pembuatan email, riwayat batch, snapshot, dan sesi Anda telah dibersihkan secara bersih.\n\n` +
        `<i>Untuk memulai kembali dari awal, gunakan perintah <code>/get</code> atau <code>/bulk</code>.</i>`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply("✅ Seluruh riwayat lokal Anda telah dibersihkan.");
    }

    return true;
  }

  return false;
}

