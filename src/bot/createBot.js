import { Telegraf } from "telegraf";
import { createAuthMiddleware } from "./middleware/auth.js";
import { registerStartHandler } from "./handlers/start.js";

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

  // 2. Register Command Handlers
  registerStartHandler(bot);

  return bot;
}

