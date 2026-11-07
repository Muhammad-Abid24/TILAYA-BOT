import { renderInboxPage, renderMessageDetail } from "../../services/inboxService.js";
import { AuthorizationError, ValidationError, OperationCancelledError } from "../../utils/errors.js";

/**
 * Registers /inbox command handler.
 *
 * @param {import("telegraf").Telegraf} bot
 */
export function registerInboxHandler(bot) {
  bot.command("inbox", async (ctx) => {
    const userId = ctx.from?.id;
    const text = ctx.message?.text || "";
    const parts = text.split(/\s+/);
    const emailArg = parts[1];

    if (!emailArg) {
      return ctx.reply(
        "⚠️ <b>Alamat email wajib diisi</b>\n\n" +
        "Gunakan format: <code>/inbox &lt;alamat_email&gt;</code>\n" +
        "Contoh: <code>/inbox contoh@domain.com</code>",
        { parse_mode: "HTML" }
      );
    }

    const { inboxService, operationRegistry } = ctx.services || {};
    if (operationRegistry?.hasActiveOperation(userId)) {
      return ctx.reply(
        "⚠️ Anda memiliki operasi yang sedang berjalan. Gunakan /stop untuk membatalkannya terlebih dahulu."
      );
    }

    let op;
    try {
      op = operationRegistry.startOperation(userId, "inbox");
    } catch (err) {
      return ctx.reply(err.message);
    }

    let loadingMsg = null;
    try {
      loadingMsg = await ctx.reply("⏳ <i>Memeriksa kotak masuk...</i>", {
        parse_mode: "HTML"
      });

      const inboxData = await inboxService.getInbox({
        userId,
        email: emailArg,
        signal: op.signal
      });

      const rendered = renderInboxPage({
        snapshotId: inboxData.snapshotId,
        email: inboxData.email,
        messages: inboxData.messages,
        page: 1
      });

      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          null,
          rendered.text,
          {
            parse_mode: "HTML",
            reply_markup: rendered.reply_markup
          }
        );
      } catch {
        await ctx.reply(rendered.text, {
          parse_mode: "HTML",
          reply_markup: rendered.reply_markup
        });
      }
    } catch (err) {
      let errorText = `❌ Terjadi kesalahan: ${err.message}`;
      if (err instanceof AuthorizationError) {
        errorText = `❌ <b>Akses Ditolak</b>\n${err.message}`;
      } else if (err instanceof ValidationError) {
        errorText = `⚠️ <b>Email Tidak Valid</b>\n${err.message}`;
      } else if (err instanceof OperationCancelledError) {
        errorText = "🛑 Pemeriksaan kotak masuk dibatalkan (/stop).";
      }

      if (loadingMsg) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            loadingMsg.message_id,
            null,
            errorText,
            { parse_mode: "HTML" }
          );
        } catch {
          await ctx.reply(errorText, { parse_mode: "HTML" });
        }
      } else {
        await ctx.reply(errorText, { parse_mode: "HTML" });
      }
    } finally {
      operationRegistry?.clearOperation(userId);
    }
  });
}

/**
 * Handles callback queries related to inbox (pagination, read message, refresh).
 *
 * @param {any} ctx
 * @returns {Promise<boolean>} Whether the callback was handled
 */
export async function handleInboxCallback(ctx) {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("inbox:")) {
    return false;
  }

  const userId = ctx.from?.id;
  const parts = data.split(":");
  const snapshotId = parts[1];
  const action = parts[2];
  const param = parts[3];

  const { repos, inboxService, operationRegistry } = ctx.services || {};

  // Verify snapshot existence and ownership
  const snapshot = repos?.inboxSnapshots?.getSnapshot(snapshotId, userId);
  if (!snapshot) {
    await ctx.answerCbQuery(
      "Sesi kotak masuk telah kedaluwarsa atau tidak valid. Silakan jalankan /inbox kembali.",
      { show_alert: true }
    );
    return true;
  }

  // Handle Refresh action
  if (action === "refresh") {
    await ctx.answerCbQuery("Memperbarui pesan...");
    try {
      const inboxData = await inboxService.getInbox({
        userId,
        email: snapshot.email
      });

      const rendered = renderInboxPage({
        snapshotId: inboxData.snapshotId,
        email: inboxData.email,
        messages: inboxData.messages,
        page: 1
      });

      await ctx.editMessageText(rendered.text, {
        parse_mode: "HTML",
        reply_markup: rendered.reply_markup
      });
    } catch (err) {
      await ctx.answerCbQuery(`Gagal memuat ulang: ${err.message}`, {
        show_alert: true
      });
    }
    return true;
  }

  // Handle Pagination action: inbox:<snapshotId>:p:<pageNumber>
  if (action === "p") {
    const pageNum = Number(param) || 1;
    await ctx.answerCbQuery();
    const rendered = renderInboxPage({
      snapshotId: snapshot.id,
      email: snapshot.email,
      messages: snapshot.messages,
      page: pageNum
    });

    try {
      await ctx.editMessageText(rendered.text, {
        parse_mode: "HTML",
        reply_markup: rendered.reply_markup
      });
    } catch {
      // Content may be identical
    }
    return true;
  }

  // Handle Read action: inbox:<snapshotId>:r:<ordinal>
  if (action === "r") {
    const ordinal = Number(param);
    await ctx.answerCbQuery("Membuka pesan...");

    if (operationRegistry?.hasActiveOperation(userId)) {
      await ctx.answerCbQuery(
        "Operasi lain sedang berjalan. Gunakan /stop terlebih dahulu.",
        { show_alert: true }
      );
      return true;
    }

    let op;
    try {
      op = operationRegistry.startOperation(userId, "read_message");
    } catch {
      return true;
    }

    try {
      const detail = await inboxService.readMessage({
        userId,
        snapshotId: snapshot.id,
        ordinal,
        signal: op.signal
      });

      if (!detail) {
        await ctx.answerCbQuery("Pesan tidak ditemukan dalam snapshot ini.", {
          show_alert: true
        });
        return true;
      }

      // Calculate which page this ordinal came from
      const returnPage = Math.ceil(ordinal / 5);
      const rendered = renderMessageDetail({
        snapshotId: snapshot.id,
        detail,
        returnPage
      });

      await ctx.editMessageText(rendered.text, {
        parse_mode: "HTML",
        reply_markup: rendered.reply_markup
      });
    } catch (err) {
      await ctx.answerCbQuery(`Gagal membaca pesan: ${err.message}`, {
        show_alert: true
      });
    } finally {
      operationRegistry?.clearOperation(userId);
    }
    return true;
  }

  return false;
}

