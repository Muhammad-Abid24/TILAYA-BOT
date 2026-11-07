import { generateSessionId, WIZARD_TTL_MS } from "../wizard/emailTypeWizard.js";
import { escapeHtml } from "../../utils/formatting.js";
import { AuthorizationError, OperationCancelledError } from "../../utils/errors.js";

/**
 * Registers /extend command handler.
 *
 * @param {import("telegraf").Telegraf} bot
 */
export function registerExtendHandler(bot) {
  bot.command("extend", async (ctx) => {
    const userId = ctx.from?.id;
    const text = ctx.message?.text || "";
    const parts = text.split(/\s+/);
    const emailArg = parts[1];

    const { extendService, repos, operationRegistry } = ctx.services || {};

    if (operationRegistry?.hasActiveOperation(userId)) {
      return ctx.reply(
        "⚠️ Anda memiliki operasi yang sedang berjalan. Gunakan /stop untuk membatalkannya terlebih dahulu."
      );
    }

    // 1. Direct email argument provided
    if (emailArg) {
      try {
        const validatedEmail = extendService.validateOwnership({
          userId,
          email: emailArg
        });

        const sessionId = generateSessionId();
        const expiresAt = Date.now() + WIZARD_TTL_MS;

        repos.wizardSessions.saveSession({
          id: `ext_${sessionId}`,
          userId,
          chatId: ctx.chat.id,
          state: "EXTEND_CONFIRM",
          payload: { email: validatedEmail },
          expiresAt
        });

        return ctx.reply(
          `⏳ <b>Konfirmasi Perpanjangan Email</b>\n\n` +
          `Alamat: <code>${escapeHtml(validatedEmail)}</code>\n\n` +
          `Apakah Anda yakin ingin memperpanjang masa aktif alamat email ini?`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Ya, Perpanjang", callback_data: `ext:${sessionId}:confirm` },
                  { text: "❌ Batal", callback_data: `ext:${sessionId}:cancel` }
                ]
              ]
            }
          }
        );
      } catch (err) {
        if (err instanceof AuthorizationError) {
          return ctx.reply(
            `❌ <b>Akses Ditolak</b>\n${err.message}`,
            { parse_mode: "HTML" }
          );
        }
        return ctx.reply(
          `⚠️ <b>Format Tidak Valid</b>\n${err.message}`,
          { parse_mode: "HTML" }
        );
      }
    }

    // 2. No argument: provide list of user's recently generated emails
    const recentEmails = extendService.getUserRecentEmails(userId, 5);
    if (!recentEmails || recentEmails.length === 0) {
      return ctx.reply(
        "ℹ️ <b>Belum ada email tersimpan</b>\n\n" +
        "Anda belum memiliki alamat email yang dibuat di bot ini.\n" +
        "Gunakan perintah <code>/get</code> atau <code>/bulk</code> untuk membuat email terlebih dahulu.",
        { parse_mode: "HTML" }
      );
    }

    const sessionId = generateSessionId();
    const expiresAt = Date.now() + WIZARD_TTL_MS;

    repos.wizardSessions.saveSession({
      id: `ext_${sessionId}`,
      userId,
      chatId: ctx.chat.id,
      state: "EXTEND_SELECT",
      payload: { recentEmails },
      expiresAt
    });

    const emailButtons = recentEmails.map((email, idx) => [
      { text: `✉️ ${email}`, callback_data: `ext:${sessionId}:sel:${idx}` }
    ]);

    emailButtons.push([
      { text: "❌ Batal", callback_data: `ext:${sessionId}:cancel` }
    ]);

    await ctx.reply(
      "⏳ <b>Pilih Alamat Email untuk Diperpanjang</b>\n\n" +
      "Pilih salah satu alamat email dari riwayat Anda di bawah ini:",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: emailButtons
        }
      }
    );
  });
}

/**
 * Handles callback queries for email extension flow.
 *
 * @param {any} ctx
 * @returns {Promise<boolean>}
 */
export async function handleExtendCallback(ctx) {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("ext:")) {
    return false;
  }

  const userId = ctx.from?.id;
  const parts = data.split(":");
  const sessionId = parts[1];
  const action = parts[2];
  const param = parts[3];

  const { repos, extendService, operationRegistry } = ctx.services || {};
  const session = repos?.wizardSessions?.getSession(`ext_${sessionId}`);

  // 1. Session check
  if (!session) {
    await ctx.answerCbQuery(
      "Sesi perpanjangan tidak ditemukan atau telah berakhir.",
      { show_alert: true }
    );
    return true;
  }

  // 2. Ownership check
  if (session.userId !== userId || session.chatId !== ctx.chat?.id) {
    await ctx.answerCbQuery(
      "Akses ditolak: Anda bukan pemilik sesi perpanjangan ini.",
      { show_alert: true }
    );
    return true;
  }

  // 3. Expiration check
  if (session.expiresAt <= Date.now()) {
    repos.wizardSessions.deleteSession(`ext_${sessionId}`);
    await ctx.answerCbQuery(
      "Sesi perpanjangan telah kedaluwarsa. Silakan ulangi dengan /extend.",
      { show_alert: true }
    );
    return true;
  }

  // Handle Cancel
  if (action === "cancel") {
    repos.wizardSessions.deleteSession(`ext_${sessionId}`);
    await ctx.answerCbQuery("Perpanjangan dibatalkan.");
    try {
      await ctx.editMessageText("❌ <i>Perpanjangan email dibatalkan.</i>", {
        parse_mode: "HTML"
      });
    } catch {
      // Ignore edit failure
    }
    return true;
  }

  // Handle Email Selection: ext:<sessionId>:sel:<index>
  if (action === "sel") {
    const idx = Number(param);
    const selectedEmail = session.payload?.recentEmails?.[idx];

    if (!selectedEmail) {
      await ctx.answerCbQuery("Alamat email tidak valid.", { show_alert: true });
      return true;
    }

    // Update state to EXTEND_CONFIRM
    session.state = "EXTEND_CONFIRM";
    session.payload = { email: selectedEmail };
    repos.wizardSessions.saveSession({
      id: `ext_${sessionId}`,
      userId,
      chatId: ctx.chat.id,
      state: "EXTEND_CONFIRM",
      payload: session.payload,
      expiresAt: session.expiresAt
    });

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `⏳ <b>Konfirmasi Perpanjangan Email</b>\n\n` +
      `Alamat: <code>${escapeHtml(selectedEmail)}</code>\n\n` +
      `Apakah Anda yakin ingin memperpanjang masa aktif alamat email ini?`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Ya, Perpanjang", callback_data: `ext:${sessionId}:confirm` },
              { text: "❌ Batal", callback_data: `ext:${sessionId}:cancel` }
            ]
          ]
        }
      }
    );
    return true;
  }

  // Handle Confirm & Execute API: ext:<sessionId>:confirm
  if (action === "confirm") {
    const emailToExtend = session.payload?.email;
    if (!emailToExtend) {
      await ctx.answerCbQuery("Data perpanjangan tidak lengkap.", { show_alert: true });
      return true;
    }

    if (operationRegistry?.hasActiveOperation(userId)) {
      await ctx.answerCbQuery(
        "Operasi lain sedang berjalan. Gunakan /stop terlebih dahulu.",
        { show_alert: true }
      );
      return true;
    }

    let op;
    try {
      op = operationRegistry.startOperation(userId, "extend");
    } catch (err) {
      await ctx.reply(err.message);
      return true;
    }

    // Delete session before network call
    repos.wizardSessions.deleteSession(`ext_${sessionId}`);

    try {
      await ctx.editMessageText(
        `⏳ <i>Menghubungi server upstream untuk memperpanjang email...</i>`,
        { parse_mode: "HTML" }
      );
    } catch {
      // Ignore edit failure
    }

    try {
      const result = await extendService.executeExtend({
        userId,
        email: emailToExtend,
        signal: op.signal
      });

      let responseText =
        `✅ <b>Email Berhasil Diperpanjang</b>\n\n` +
        `Alamat: <code>${escapeHtml(emailToExtend)}</code>\n` +
        `Keterangan: ${escapeHtml(result.message || "Berhasil")}`;

      if (result.expiresAt) {
        responseText += `\nKedaluwarsa baru: <code>${escapeHtml(result.expiresAt)}</code>`;
      }

      await ctx.editMessageText(responseText, { parse_mode: "HTML" });
    } catch (err) {
      let errorText = `❌ <b>Gagal Memperpanjang Email</b>\n\n${escapeHtml(err.message)}`;
      if (err instanceof OperationCancelledError) {
        errorText = "🛑 Perpanjangan email telah dibatalkan (/stop).";
      }

      try {
        await ctx.editMessageText(errorText, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(errorText, { parse_mode: "HTML" });
      }
    } finally {
      operationRegistry?.clearOperation(userId);
    }

    return true;
  }

  return false;
}
