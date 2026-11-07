import { startEmailTypeWizard } from "../wizard/emailTypeWizard.js";

/**
 * Parses and validates the count argument for /get.
 *
 * @param {string} rawArg
 * @returns {{ valid: boolean, count?: number, error?: string }}
 */
export function parseGetCount(rawArg) {
  if (!rawArg || rawArg.trim().length === 0) {
    return { valid: true, count: 1 };
  }

  const trimmed = rawArg.trim();
  // Ensure string is pure digits without decimal point
  if (!/^\d+$/.test(trimmed)) {
    return {
      valid: false,
      error: "⚠️ Jumlah tidak valid. Masukkan angka bulat positif antara 1 dan 50 (contoh: <code>/get 5</code>)."
    };
  }

  const num = Number(trimmed);
  if (num < 1 || num > 50) {
    return {
      valid: false,
      error: "⚠️ Batas pembuatan email adalah 1 hingga 50 alamat per perintah."
    };
  }

  return { valid: true, count: num };
}

/**
 * Registers /get command handler.
 *
 * @param {import("telegraf").Telegraf} bot
 */
export function registerGetHandler(bot) {
  bot.command("get", async (ctx) => {
    const userId = ctx.from?.id;
    const text = ctx.message?.text || "";
    const parts = text.split(/\s+/);
    const countArg = parts.slice(1).join(" ");

    const parsed = parseGetCount(countArg);
    if (!parsed.valid) {
      return ctx.reply(parsed.error, { parse_mode: "HTML" });
    }

    const { operationRegistry, repos } = ctx.services || {};
    if (operationRegistry?.hasActiveOperation(userId)) {
      return ctx.reply(
        "⚠️ Anda memiliki operasi yang sedang berjalan. Gunakan /stop untuk membatalkannya terlebih dahulu."
      );
    }

    await startEmailTypeWizard({
      ctx,
      count: parsed.count,
      wizardRepo: repos.wizardSessions
    });
  });
}
