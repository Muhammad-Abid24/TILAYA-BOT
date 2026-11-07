/**
 * Registers /export command handler.
 *
 * @param {import("telegraf").Telegraf} bot
 */
export function registerExportHandler(bot) {
  bot.command("export", async (ctx) => {
    await handleExportAction(ctx);
  });
}

/**
 * Handles export action for /export command or menu callback.
 *
 * @param {any} ctx
 */
export async function handleExportAction(ctx) {
  const userId = ctx.from?.id;
  const { exportService } = ctx.services || {};

  if (!exportService) {
    return ctx.reply("Layanan ekspor belum siap.");
  }

  const result = exportService.exportLatestBatch(userId);

  if (!result.success) {
    return ctx.reply(
      "ℹ️ <b>Belum ada riwayat email</b>\n\n" +
      "Anda belum memiliki hasil pembuatan email yang tersimpan untuk diekspor.\n" +
      "Gunakan perintah <code>/get</code> atau <code>/bulk</code> untuk membuat email terlebih dahulu.",
      { parse_mode: "HTML" }
    );
  }

  await ctx.replyWithDocument(
    {
      source: result.content,
      filename: result.filename
    },
    {
      caption: `💾 <b>Ekspor Batch Terakhir</b>\nJumlah: ${result.count} alamat email.`,
      parse_mode: "HTML"
    }
  );
}
