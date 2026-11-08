/**
 * Authentication and authorization middleware for Telegraf bot.
 * Enforces:
 * 1. Default-deny allowlist based on numeric Telegram User ID.
 * 2. Private-chat-only constraint (rejects groups/supergroups/channels).
 * 3. Safe callback query handling: answers callback even when invalid or denied.
 */

/**
 * Creates the primary authorization middleware.
 *
 * @param {object} options
 * @param {Set<number> | number[]} options.allowedIds - Set of authorized numeric user IDs.
 * @returns {(ctx: any, next: () => Promise<void>) => Promise<void>}
 */
export function createAuthMiddleware({ allowedIds }) {
  const allowedSet = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);

  return async function authMiddleware(ctx, next) {
    // Intercept answerCbQuery to gracefully ignore expired callback query errors
    if (ctx.callbackQuery && typeof ctx.answerCbQuery === "function") {
      const originalAnswerCbQuery = ctx.answerCbQuery.bind(ctx);
      ctx.answerCbQuery = async (...args) => {
        try {
          return await originalAnswerCbQuery(...args);
        } catch (err) {
          const msg = err?.message || err?.description || "";
          if (
            msg.includes("query is too old") ||
            msg.includes("query ID is invalid") ||
            msg.includes("response timeout expired")
          ) {
            return false;
          }
          throw err;
        }
      };
    }

    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;

    // Check chat type: only private chats are permitted
    if (chatType && chatType !== "private") {
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCbQuery("Bot hanya dapat digunakan di chat privat.", {
            show_alert: true
          });
        } catch {
          // Ignore network errors on answering callback
        }
      } else if (typeof ctx.reply === "function") {
        try {
          await ctx.reply("Bot ini hanya beroperasi pada chat privat.");
        } catch {
          // Ignore network errors on reply
        }
      }
      return;
    }

    // Check numeric user ID against allowlist
    const numericUserId = Number(userId);
    if (!userId || !Number.isInteger(numericUserId) || !allowedSet.has(numericUserId)) {
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCbQuery("Akses ditolak. Bot ini bersifat privat.", {
            show_alert: true
          });
        } catch {
          // Ignore callback answering errors
        }
      } else if (typeof ctx.reply === "function") {
        try {
          await ctx.reply("Akses ditolak. Bot ini bersifat privat.");
        } catch {
          // Ignore reply errors
        }
      }
      return;
    }

    // Authorized and in private chat: proceed
    return next();
  };
}

/**
 * Creates callback session verification middleware.
 * Enforces:
 * 1. Callback belongs to the same user and chat.
 * 2. Session has not expired.
 * 3. Opaque identifier lookup on server side (no sensitive data in callback_data).
 *
 * @param {object} options
 * @param {(sessionId: string) => any | Promise<any>} options.getSession
 * @returns {(ctx: any, next: () => Promise<void>) => Promise<void>}
 */
export function createCallbackGuardMiddleware({ getSession }) {
  return async function callbackGuardMiddleware(ctx, next) {
    if (!ctx.callbackQuery?.data) {
      return next();
    }

    const data = ctx.callbackQuery.data;
    const parts = data.split(":");

    // Standard callback format: prefix:sessionId:action[:extra...]
    // If not a structured callback with sessionId (at least 3 parts), proceed to handler
    if (parts.length < 3) {
      return next();
    }

    const [prefix, sessionId, action, ...extra] = parts;

    // Look up session by sessionId
    let session = null;
    if (typeof getSession === "function") {
      session = await getSession(sessionId);
    }

    if (!session) {
      try {
        await ctx.answerCbQuery("Sesi tidak ditemukan atau telah berakhir.", {
          show_alert: true
        });
      } catch {
        // Safe callback query answer
      }
      return;
    }

    // Verify ownership: session userId and chatId must match ctx
    if (session.userId !== ctx.from?.id || (session.chatId && session.chatId !== ctx.chat?.id)) {
      try {
        await ctx.answerCbQuery("Akses callback ditolak (bukan pemilik sesi).", {
          show_alert: true
        });
      } catch {
        // Safe callback query answer
      }
      return;
    }

    // Verify TTL expiration
    const now = Date.now();
    if (session.expiresAt && session.expiresAt <= now) {
      try {
        await ctx.answerCbQuery("Sesi telah kedaluwarsa. Silakan mulai ulang.", {
          show_alert: true
        });
      } catch {
        // Safe callback query answer
      }
      return;
    }

    // Attach validated session to context state
    ctx.state = ctx.state || {};
    ctx.state.session = session;
    ctx.state.callback = {
      prefix,
      sessionId,
      action,
      extra
    };

    return next();
  };
}
