import { Telegraf } from "telegraf";
import { createAuthMiddleware } from "./middleware/auth.js";
import { registerStartHandler } from "./handlers/start.js";
import { registerGetHandler } from "./handlers/get.js";
import { registerBulkHandler, handleSelectCountText } from "./handlers/bulk.js";
import { registerExportHandler, handleExportAction } from "./handlers/export.js";
import { registerInboxHandler, handleInboxCallback } from "./handlers/inbox.js";
import { handleWizardCallback, startEmailTypeWizard } from "./wizard/emailTypeWizard.js";
import { formatGenerationResult } from "../utils/formatting.js";
import { OperationCancelledError } from "../utils/errors.js";

/**
 * Creates and configures the Telegraf bot instance.
 *
 * @param {object} options
 * @param {string} options.botToken
 * @param {Set<number> | number[]} options.allowedIds
 * @param {object} [options.services] - Injected services, db repositories, and API client
 * @param {Telegraf} [options.customBotInstance] - For mocking in tests
 * @returns {Telegraf}
 */
export function createBot(options) {
  const {
    botToken,
    allowedIds,
    services = {},
    customBotInstance = null
  } = options;

  const bot = customBotInstance || new Telegraf(botToken);

  // Attach services to bot context for handlers
  bot.context.services = services;

  // 1. Mandatory Allowlist & Private Chat Guard Middleware
  bot.use(createAuthMiddleware({ allowedIds }));

  // 2. Text message router for stateful interactions (e.g. bulk count prompt)
  if (typeof bot.on === "function") {
    bot.on("text", async (ctx, next) => {
      await handleSelectCountText(ctx, next);
    });

    // 3. Callback query dispatcher for wizard interactions and menu actions
    bot.on("callback_query", async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (!data) return next();

    const userId = ctx.from?.id;
    const { repos, emailService, operationRegistry } = ctx.services || {};

    // Menu callback shortcuts
    if (data === "cmd:get:1") {
      await ctx.answerCbQuery();
      if (operationRegistry?.hasActiveOperation(userId)) {
        return ctx.reply(
          "⚠️ Anda memiliki operasi yang sedang berjalan. Gunakan /stop untuk membatalkannya terlebih dahulu."
        );
      }
      return startEmailTypeWizard({ ctx, count: 1, wizardRepo: repos.wizardSessions });
    }

    if (data === "cmd:bulk") {
      await ctx.answerCbQuery();
      if (operationRegistry?.hasActiveOperation(userId)) {
        return ctx.reply(
          "⚠️ Anda memiliki operasi yang sedang berjalan. Gunakan /stop untuk membatalkannya terlebih dahulu."
        );
      }
      const sessionId = `bulk_active_${userId}`;
      repos.wizardSessions.saveSession({
        id: sessionId,
        userId,
        chatId: ctx.chat.id,
        state: "SELECT_COUNT",
        payload: {},
        expiresAt: Date.now() + 10 * 60 * 1000
      });
      return ctx.reply(
        "📦 <b>Pembuatan Email Massal (Bulk)</b>\n\n" +
        "Berapa jumlah alamat email yang ingin Anda buat?\n" +
        "Ketik angka bulat antara <b>1</b> hingga <b>50</b> (atau ketik /stop untuk batal):",
        { parse_mode: "HTML" }
      );
    }

    if (data === "cmd:export") {
      await ctx.answerCbQuery();
      return handleExportAction(ctx);
    }

    if (data === "cmd:inbox") {
      await ctx.answerCbQuery();
      return ctx.reply(
        "📬 <b>Periksa Kotak Masuk</b>\n\n" +
        "Gunakan perintah: <code>/inbox &lt;alamat_email&gt;</code>\n" +
        "Contoh: <code>/inbox user@domain.com</code>",
        { parse_mode: "HTML" }
      );
    }

    // Inbox callback handling
    if (data.startsWith("inbox:")) {
      const handled = await handleInboxCallback(ctx);
      if (handled) return;
    }

    // Wizard callback handling
    if (data.startsWith("w:")) {
      const handled = await handleWizardCallback({
        ctx,
        wizardRepo: repos.wizardSessions,
        onGenerate: async ({ sessionId, count, selectedTypes }) => {
          if (operationRegistry?.hasActiveOperation(userId)) {
            await ctx.answerCbQuery(
              "Operasi lain sedang berjalan. Gunakan /stop terlebih dahulu.",
              { show_alert: true }
            );
            return;
          }

          let op;
          try {
            op = operationRegistry.startOperation(userId, "generate");
          } catch (err) {
            await ctx.reply(err.message);
            return;
          }

          // Delete session now that generation has begun
          repos.wizardSessions.deleteSession(sessionId);

          try {
            await ctx.editMessageText(
              `⏳ <i>Sedang membuat ${count} email sementara... Mohon tunggu.</i>`,
              { parse_mode: "HTML" }
            );
          } catch {
            // Ignore edit failure
          }

          try {
            const result = await emailService.generateEmails({
              userId,
              count,
              selectedTypes,
              signal: op.signal
            });

            const formatted = formatGenerationResult(result);
            try {
              await ctx.editMessageText(formatted, { parse_mode: "HTML" });
            } catch {
              await ctx.reply(formatted, { parse_mode: "HTML" });
            }
          } catch (err) {
            if (err instanceof OperationCancelledError) {
              try {
                await ctx.editMessageText("🛑 <i>Pembuatan email telah dibatalkan (/stop).</i>", {
                  parse_mode: "HTML"
                });
              } catch {
                await ctx.reply("🛑 Pembuatan email telah dibatalkan (/stop).");
              }
            } else {
              try {
                await ctx.editMessageText(
                  `❌ <b>Terjadi kesalahan:</b> ${err.message}`,
                  { parse_mode: "HTML" }
                );
              } catch {
                await ctx.reply(`❌ Terjadi kesalahan: ${err.message}`);
              }
            }
          } finally {
            operationRegistry.clearOperation(userId);
          }
        }
      });

      if (handled) return;
    }

    return next();
  });
  }

  // 4. Register Command Handlers
  registerStartHandler(bot);
  registerGetHandler(bot);
  registerBulkHandler(bot);
  registerExportHandler(bot);
  registerInboxHandler(bot);

  return bot;
}
