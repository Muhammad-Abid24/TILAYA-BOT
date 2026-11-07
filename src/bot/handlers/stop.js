/**
 * Registers /stop command handler to abort running network operations and clear active wizard sessions.
 *
 * @param {import("telegraf").Telegraf} bot
 */
export function registerStopHandler(bot) {
  bot.command("stop", async (ctx) => {
    const userId = ctx.from?.id;
    const { operationRegistry, repos } = ctx.services || {};

    let wasCancelled = false;

    // 1. Abort any active network operation (fetch / delay / polling)
    if (operationRegistry?.hasActiveOperation(userId)) {
      operationRegistry.stopOperation(userId, "Dibatalkan oleh pengguna melalui perintah /stop.");
      wasCancelled = true;
    }

    // 2. Clean up any pending stateful wizard sessions (e.g. SELECT_COUNT or SELECT_TYPES)
    if (repos?.wizardSessions) {
      const activeBulk = repos.wizardSessions.getSession(`bulk_active_${userId}`);
      if (activeBulk) {
        repos.wizardSessions.deleteSession(`bulk_active_${userId}`);
        wasCancelled = true;
      }
    }

    if (wasCancelled) {
      return ctx.reply(
        "🛑 <b>Operasi Berhasil Dibatalkan</b>\n\n" +
        "Permintaan atau proses aktif Anda telah dihentikan.\n" +
        "Bot tetap aktif dan siap menerima perintah baru.",
        { parse_mode: "HTML" }
      );
    }

    return ctx.reply(
      "ℹ️ Tidak ada operasi aktif yang sedang berjalan.\n" +
      "Ketik <code>/start</code> untuk melihat menu dan daftar perintah.",
      { parse_mode: "HTML" }
    );
  });
}

