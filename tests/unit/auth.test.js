import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createAuthMiddleware,
  createCallbackGuardMiddleware
} from "../../src/bot/middleware/auth.js";

describe("Authorization and Callback Security Middleware (T02)", () => {
  const ALLOWED_IDS = new Set([1001, 1002]);
  const authMiddleware = createAuthMiddleware({ allowedIds: ALLOWED_IDS });

  function createMockCtx({
    userId = 1001,
    chatType = "private",
    chatId = 1001,
    isCallback = false,
    callbackData = ""
  } = {}) {
    let repliedText = null;
    let answeredCbQuery = null;
    let nextCalled = false;

    const ctx = {
      from: { id: userId },
      chat: { id: chatId, type: chatType },
      state: {},
      reply: async (text) => {
        repliedText = text;
      },
      getRepliedText: () => repliedText,
      getNextCalled: () => nextCalled,
      getAnsweredCbQuery: () => answeredCbQuery
    };

    if (isCallback) {
      ctx.callbackQuery = {
        data: callbackData,
        from: { id: userId }
      };
      ctx.answerCbQuery = async (text, options) => {
        answeredCbQuery = { text, options };
      };
    }

    const next = async () => {
      nextCalled = true;
    };

    return { ctx, next };
  }

  describe("createAuthMiddleware", () => {
    it("should allow an authorized user in a private chat", async () => {
      const { ctx, next } = createMockCtx({ userId: 1001, chatType: "private" });
      await authMiddleware(ctx, next);

      assert.equal(ctx.getNextCalled(), true);
      assert.equal(ctx.getRepliedText(), null);
    });

    it("should reject an unauthorized user in a private chat and send refusal message", async () => {
      const { ctx, next } = createMockCtx({ userId: 9999, chatType: "private" });
      await authMiddleware(ctx, next);

      assert.equal(ctx.getNextCalled(), false);
      assert.ok(ctx.getRepliedText()?.includes("Akses ditolak"));
    });

    it("should reject an authorized user if chat is a group or supergroup", async () => {
      const groupCtx = createMockCtx({ userId: 1001, chatType: "group" });
      await authMiddleware(groupCtx.ctx, groupCtx.next);
      assert.equal(groupCtx.ctx.getNextCalled(), false);
      assert.ok(groupCtx.ctx.getRepliedText()?.includes("chat privat"));

      const supergroupCtx = createMockCtx({ userId: 1001, chatType: "supergroup" });
      await authMiddleware(supergroupCtx.ctx, supergroupCtx.next);
      assert.equal(supergroupCtx.ctx.getNextCalled(), false);
      assert.ok(supergroupCtx.ctx.getRepliedText()?.includes("chat privat"));
    });

    it("should answer callback query with alert when unauthorized user clicks a button", async () => {
      const { ctx, next } = createMockCtx({
        userId: 9999,
        chatType: "private",
        isCallback: true,
        callbackData: "some:action"
      });
      await authMiddleware(ctx, next);

      assert.equal(ctx.getNextCalled(), false);
      assert.ok(ctx.getAnsweredCbQuery()?.text?.includes("Akses ditolak"));
      assert.equal(ctx.getAnsweredCbQuery()?.options?.show_alert, true);
    });

    it("should answer callback query with alert when invoked in a non-private chat", async () => {
      const { ctx, next } = createMockCtx({
        userId: 1001,
        chatType: "group",
        isCallback: true,
        callbackData: "some:action"
      });
      await authMiddleware(ctx, next);

      assert.equal(ctx.getNextCalled(), false);
      assert.ok(ctx.getAnsweredCbQuery()?.text?.includes("chat privat"));
      assert.equal(ctx.getAnsweredCbQuery()?.options?.show_alert, true);
    });

    it("should safely ignore 'query is too old' error when answering callback query", async () => {
      const { ctx, next } = createMockCtx({
        userId: 1001,
        chatType: "private",
        isCallback: true,
        callbackData: "cmd:inbox"
      });
      // Mock answerCbQuery throwing query is too old error
      ctx.answerCbQuery = async () => {
        throw new Error("400: Bad Request: query is too old and response timeout expired or query ID is invalid");
      };

      await authMiddleware(ctx, next);
      assert.equal(ctx.getNextCalled(), true);

      // Calling ctx.answerCbQuery directly should return false without throwing
      const result = await ctx.answerCbQuery();
      assert.equal(result, false);
    });

    it("should rethrow other errors when answering callback query", async () => {
      const { ctx, next } = createMockCtx({
        userId: 1001,
        chatType: "private",
        isCallback: true,
        callbackData: "cmd:inbox"
      });
      ctx.answerCbQuery = async () => {
        throw new Error("500: Internal Server Error");
      };

      await authMiddleware(ctx, next);
      assert.equal(ctx.getNextCalled(), true);

      await assert.rejects(async () => {
        await ctx.answerCbQuery();
      }, /500: Internal Server Error/);
    });
  });

  describe("createCallbackGuardMiddleware", () => {
    it("should let non-callback updates pass through", async () => {
      const guard = createCallbackGuardMiddleware({ getSession: async () => null });
      const { ctx, next } = createMockCtx({ isCallback: false });

      await guard(ctx, next);
      assert.equal(ctx.getNextCalled(), true);
    });

    it("should reject callback when session does not exist", async () => {
      const guard = createCallbackGuardMiddleware({ getSession: async () => null });
      const { ctx, next } = createMockCtx({
        userId: 1001,
        isCallback: true,
        callbackData: "w:sess123:toggle:1"
      });

      await guard(ctx, next);
      assert.equal(ctx.getNextCalled(), false);
      assert.ok(ctx.getAnsweredCbQuery()?.text?.includes("tidak ditemukan"));
    });

    it("should reject callback when session belongs to a different user (anti-hijack)", async () => {
      const fakeSession = {
        userId: 1002, // Different user
        chatId: 1001,
        expiresAt: Date.now() + 60000
      };
      const guard = createCallbackGuardMiddleware({ getSession: async () => fakeSession });
      const { ctx, next } = createMockCtx({
        userId: 1001, // Attacker or wrong user
        chatId: 1001,
        isCallback: true,
        callbackData: "w:sess123:gen"
      });

      await guard(ctx, next);
      assert.equal(ctx.getNextCalled(), false);
      assert.ok(ctx.getAnsweredCbQuery()?.text?.includes("bukan pemilik sesi"));
    });

    it("should reject callback when session has expired", async () => {
      const expiredSession = {
        userId: 1001,
        chatId: 1001,
        expiresAt: Date.now() - 5000 // Expired 5 seconds ago
      };
      const guard = createCallbackGuardMiddleware({ getSession: async () => expiredSession });
      const { ctx, next } = createMockCtx({
        userId: 1001,
        chatId: 1001,
        isCallback: true,
        callbackData: "w:sess123:gen"
      });

      await guard(ctx, next);
      assert.equal(ctx.getNextCalled(), false);
      assert.ok(ctx.getAnsweredCbQuery()?.text?.includes("kedaluwarsa"));
    });

    it("should accept valid callback and attach session to ctx.state", async () => {
      const validSession = {
        id: "sess123",
        userId: 1001,
        chatId: 1001,
        expiresAt: Date.now() + 60000,
        selectedTypes: [1, 2]
      };
      const guard = createCallbackGuardMiddleware({ getSession: async () => validSession });
      const { ctx, next } = createMockCtx({
        userId: 1001,
        chatId: 1001,
        isCallback: true,
        callbackData: "w:sess123:toggle:2"
      });

      await guard(ctx, next);
      assert.equal(ctx.getNextCalled(), true);
      assert.equal(ctx.state.session, validSession);
      assert.equal(ctx.state.callback.prefix, "w");
      assert.equal(ctx.state.callback.sessionId, "sess123");
      assert.equal(ctx.state.callback.action, "toggle");
      assert.deepEqual(ctx.state.callback.extra, ["2"]);
    });
  });
});

