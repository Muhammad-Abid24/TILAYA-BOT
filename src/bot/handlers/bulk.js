import { startEmailTypeWizard, WIZARD_TTL_MS } from "../wizard/emailTypeWizard.js";
import { parseGetCount } from "./get.js";

/**
 * Registers /bulk command and count input handler.
 *
 * @param {import("telegraf").Telegraf} bot
 */
export function registerBulkHandler(bot) {
  bot.command("bulk", async (ctx) => {
    const userId = ctx.from?.id;
    const { operationRegistry, repos } = ctx.services || {};

    if (operationRegistry?.hasActiveOperation(userId)) {
      return ctx.reply(
        "⚠️ Anda memiliki operasi yang sedang berjalan. Gunakan /stop untuk membatalkannya terlebih dahulu."
      );
    }

    const sessionId = `bulk_active_${userId}`;
    const expiresAt = Date.now() + WIZARD_TTL_MS;

    repos.wizardSessions.saveSession({
      id: sessionId,
      userId,
      chatId: ctx.chat.id,
      state: "SELECT_COUNT",
      payload: {},
      expiresAt
    });

    await ctx.reply(
      "📦 <b>Pembuatan Email Massal (Bulk)</b>\n\n" +
      "Berapa jumlah alamat email yang ingin Anda buat?\n" +
      "Ketik angka bulat antara <b>1</b> hingga <b>50</b> (atau ketik /stop untuk batal):",
      { parse_mode: "HTML" }
    );
  });
}

/**
 * Middleware or message handler to capture count input when user is in SELECT_COUNT state.
 *
 * @param {any} ctx
 * @param {() => Promise<void>} next
 */
export async function handleSelectCountText(ctx, next) {
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith("/")) {
    return next();
  }

  const userId = ctx.from?.id;
  const { repos } = ctx.services || {};
  if (!repos?.wizardSessions) {
    return next();
  }

  // Find active SELECT_COUNT session for this user
  // We can query by session ID prefix or get by user
  const session = repos.wizardSessions.getSession(`bulk_${userId}`) || null;
  // If no direct key, check user's session from DB
  let countSession = session;
  if (!countSession) {
    // Check if user has an active wizard session in state SELECT_COUNT
    const row = repos.wizardSessions.getSession(`bulk_active_${userId}`);
    countSession = row;
  }

  if (!countSession || countSession.state !== "SELECT_COUNT") {
    return next();
  }

  if (countSession.expiresAt <= Date.now()) {
    repos.wizardSessions.deleteSession(countSession.id);
    return next();
  }

  const parsed = parseGetCount(text);
  if (!parsed.valid) {
    return ctx.reply(
      "⚠️ Angka tidak valid. Silakan masukkan angka bulat antara 1 dan 50 (atau ketik /stop untuk membatalkan):"
    );
  }

  // Delete SELECT_COUNT session and proceed to email type wizard
  repos.wizardSessions.deleteSession(countSession.id);

  await startEmailTypeWizard({
    ctx,
    count: parsed.count,
    wizardRepo: repos.wizardSessions
  });
}
