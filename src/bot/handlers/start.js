import { getStartMessage, getStartKeyboard } from "../../utils/formatting.js";

/**
 * Registers /start command handler.
 *
 * @param {import("telegraf").Telegraf} bot
 */
export function registerStartHandler(bot) {
  bot.command("start", async (ctx) => {
    const userName = ctx.from?.first_name || "Pengguna";
    const message = getStartMessage(userName);
    const keyboard = getStartKeyboard();

    await ctx.reply(message, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  });
}

