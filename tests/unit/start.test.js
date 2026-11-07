import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getStartMessage, getStartKeyboard } from "../../src/utils/formatting.js";
import { createBot } from "../../src/bot/createBot.js";

describe("/start Handler & Menu (T05)", () => {
  it("should contain all required MVP commands in the start message", () => {
    const msg = getStartMessage("Alice");

    assert.ok(msg.includes("Alice"));
    assert.ok(msg.includes("/get"));
    assert.ok(msg.includes("/bulk"));
    assert.ok(msg.includes("/inbox"));
    assert.ok(msg.includes("/extend"));
    assert.ok(msg.includes("/export"));
    assert.ok(msg.includes("/stop"));
    assert.ok(msg.includes("/done"));
  });

  it("should escape special characters in user names to prevent HTML injection", () => {
    const rawName = "<script>alert('xss')</script> & bob";
    const msg = getStartMessage(rawName);

    assert.ok(!msg.includes("<script>"));
    assert.ok(msg.includes("&lt;script&gt;"));
    assert.ok(msg.includes("&amp; bob"));
  });

  it("should provide inline keyboard menu with all actions", () => {
    const kb = getStartKeyboard();
    assert.ok(Array.isArray(kb.inline_keyboard));
    assert.ok(kb.inline_keyboard.length >= 3);

    const flatButtons = kb.inline_keyboard.flat();
    const actions = flatButtons.map((b) => b.callback_data);

    assert.ok(actions.includes("cmd:get:1"));
    assert.ok(actions.includes("cmd:bulk"));
    assert.ok(actions.includes("cmd:inbox"));
    assert.ok(actions.includes("cmd:extend"));
    assert.ok(actions.includes("cmd:export"));
    assert.ok(actions.includes("cmd:done"));
  });

  it("should handle /start for authorized user in private chat", async () => {
    let capturedReply = null;
    let capturedOptions = null;

    // Minimal Telegraf mock
    const registeredHandlers = new Map();
    const mockBot = {
      context: {},
      use(fn) {
        this.middleware = fn;
      },
      command(cmd, handler) {
        registeredHandlers.set(cmd, handler);
      },
      on() {}
    };

    createBot({
      botToken: "123456:mock_token",
      allowedIds: new Set([1001]),
      customBotInstance: mockBot
    });

    const handler = registeredHandlers.get("start");
    assert.ok(handler, "/start handler must be registered");

    const ctx = {
      from: { id: 1001, first_name: "Abid" },
      chat: { id: 1001, type: "private" },
      reply: async (text, options) => {
        capturedReply = text;
        capturedOptions = options;
      }
    };

    // Run middleware first
    let nextCalled = false;
    await mockBot.middleware(ctx, async () => {
      nextCalled = true;
      await handler(ctx);
    });

    assert.equal(nextCalled, true);
    assert.ok(capturedReply?.includes("Abid"));
    assert.equal(capturedOptions?.parse_mode, "HTML");
    assert.ok(capturedOptions?.reply_markup?.inline_keyboard);
  });

  it("should block /start for unauthorized user via middleware", async () => {
    let capturedReply = null;
    const registeredHandlers = new Map();
    const mockBot = {
      context: {},
      use(fn) {
        this.middleware = fn;
      },
      command(cmd, handler) {
        registeredHandlers.set(cmd, handler);
      },
      on() {}
    };

    createBot({
      botToken: "123456:mock_token",
      allowedIds: new Set([1001]),
      customBotInstance: mockBot
    });

    const handler = registeredHandlers.get("start");

    const ctx = {
      from: { id: 9999, first_name: "Hacker" },
      chat: { id: 9999, type: "private" },
      reply: async (text) => {
        capturedReply = text;
      }
    };

    let nextCalled = false;
    await mockBot.middleware(ctx, async () => {
      nextCalled = true;
      await handler(ctx);
    });

    assert.equal(nextCalled, false, "Handler must not be executed for unauthorized user");
    assert.ok(capturedReply?.includes("Akses ditolak"));
  });
});
