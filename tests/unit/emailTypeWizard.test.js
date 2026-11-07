import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_TYPE_CONFIG,
  renderWizardText,
  renderWizardKeyboard,
  startEmailTypeWizard,
  handleWizardCallback,
  WIZARD_TTL_MS
} from "../../src/bot/wizard/emailTypeWizard.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories.js";

describe("Multi-Select Email Type Wizard (T06)", () => {
  let db;
  let repos;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
  });

  describe("Rendering & Mapping", () => {
    it("should map types strictly to [1, 2, 3, 8]", () => {
      const ids = EMAIL_TYPE_CONFIG.map((t) => t.id);
      assert.deepEqual(ids, [1, 2, 3, 8]);
      assert.equal(EMAIL_TYPE_CONFIG.find((t) => t.id === 1)?.label, "Domain");
      assert.equal(EMAIL_TYPE_CONFIG.find((t) => t.id === 2)?.label, "+Gmail");
      assert.equal(EMAIL_TYPE_CONFIG.find((t) => t.id === 3)?.label, ".Gmail");
      assert.equal(EMAIL_TYPE_CONFIG.find((t) => t.id === 8)?.label, "GoogleMail");
    });

    it("should render keyboard with all types OFF by default and locked generate button", () => {
      const text = renderWizardText({ count: 3, selectedTypes: [] });
      assert.ok(text.includes("3 alamat"));
      assert.ok(text.includes("Belum ada tipe"));

      const kb = renderWizardKeyboard({ sessionId: "sess1", selectedTypes: [] });
      const flat = kb.inline_keyboard.flat();

      const typeButtons = flat.filter((b) => b.callback_data.includes(":t:"));
      assert.equal(typeButtons.length, 4);
      for (const btn of typeButtons) {
        assert.ok(btn.text.includes("[OFF]"));
      }

      const genBtn = flat.find((b) => b.callback_data.endsWith(":gen"));
      assert.ok(genBtn.text.includes("Pilih Tipe"));
    });

    it("should render ON indicator and unlock generate button when types are selected", () => {
      const kb = renderWizardKeyboard({ sessionId: "sess1", selectedTypes: [1, 8] });
      const flat = kb.inline_keyboard.flat();

      const domainBtn = flat.find((b) => b.callback_data === "w:sess1:t:1");
      const googleMailBtn = flat.find((b) => b.callback_data === "w:sess1:t:8");
      const plusGmailBtn = flat.find((b) => b.callback_data === "w:sess1:t:2");

      assert.ok(domainBtn.text.includes("[ON]"));
      assert.ok(googleMailBtn.text.includes("[ON]"));
      assert.ok(plusGmailBtn.text.includes("[OFF]"));

      const genBtn = flat.find((b) => b.callback_data.endsWith(":gen"));
      assert.ok(genBtn.text.includes("Generate Sekarang"));
    });
  });

  describe("startEmailTypeWizard", () => {
    it("should initialize wizard session with 10-minute TTL in DB and send message", async () => {
      let replyCalled = false;
      let repliedText = "";
      let repliedMarkup = null;

      const ctx = {
        from: { id: 1001 },
        chat: { id: 1001 },
        reply: async (text, options) => {
          replyCalled = true;
          repliedText = text;
          repliedMarkup = options?.reply_markup;
        }
      };

      const startTime = Date.now();
      const sessionId = await startEmailTypeWizard({
        ctx,
        count: 5,
        wizardRepo: repos.wizardSessions
      });

      assert.ok(sessionId);
      assert.equal(replyCalled, true);
      assert.ok(repliedText.includes("5 alamat"));
      assert.ok(repliedMarkup?.inline_keyboard);

      const session = repos.wizardSessions.getSession(sessionId);
      assert.ok(session);
      assert.equal(session.userId, 1001);
      assert.equal(session.payload.count, 5);
      assert.deepEqual(session.payload.selectedTypes, []);
      assert.ok(session.expiresAt >= startTime + WIZARD_TTL_MS - 500);
    });
  });

  describe("handleWizardCallback", () => {
    function createCallbackCtx({
      userId = 1001,
      chatId = 1001,
      callbackData = ""
    } = {}) {
      let answeredText = null;
      let answeredAlert = false;
      let editedText = null;

      const ctx = {
        from: { id: userId },
        chat: { id: chatId },
        callbackQuery: { data: callbackData },
        answerCbQuery: async (text, options) => {
          answeredText = text;
          answeredAlert = Boolean(options?.show_alert);
        },
        editMessageText: async (text) => {
          editedText = text;
        },
        getAnsweredText: () => answeredText,
        getAnsweredAlert: () => answeredAlert,
        getEditedText: () => editedText
      };

      return ctx;
    }

    it("should toggle selection from OFF to ON and back to OFF", async () => {
      repos.wizardSessions.saveSession({
        id: "sess_toggle",
        userId: 1001,
        chatId: 1001,
        state: "SELECT_TYPES",
        payload: { count: 3, selectedTypes: [] },
        expiresAt: Date.now() + 60000
      });

      // 1. Toggle ID 1 ON
      const ctx1 = createCallbackCtx({
        callbackData: "w:sess_toggle:t:1"
      });
      const handled1 = await handleWizardCallback({
        ctx: ctx1,
        wizardRepo: repos.wizardSessions
      });

      assert.equal(handled1, true);
      let session = repos.wizardSessions.getSession("sess_toggle");
      assert.deepEqual(session.payload.selectedTypes, [1]);
      assert.ok(ctx1.getEditedText()?.includes("Domain"));

      // 2. Toggle ID 8 ON (Multi-select)
      const ctx2 = createCallbackCtx({
        callbackData: "w:sess_toggle:t:8"
      });
      await handleWizardCallback({
        ctx: ctx2,
        wizardRepo: repos.wizardSessions
      });

      session = repos.wizardSessions.getSession("sess_toggle");
      assert.deepEqual(session.payload.selectedTypes.sort(), [1, 8]);

      // 3. Toggle ID 1 OFF
      const ctx3 = createCallbackCtx({
        callbackData: "w:sess_toggle:t:1"
      });
      await handleWizardCallback({
        ctx: ctx3,
        wizardRepo: repos.wizardSessions
      });

      session = repos.wizardSessions.getSession("sess_toggle");
      assert.deepEqual(session.payload.selectedTypes, [8]);
    });

    it("should reject Generate when 0 types are selected and alert user", async () => {
      repos.wizardSessions.saveSession({
        id: "sess_zero",
        userId: 1001,
        chatId: 1001,
        state: "SELECT_TYPES",
        payload: { count: 1, selectedTypes: [] },
        expiresAt: Date.now() + 60000
      });

      let genTriggered = false;
      const ctx = createCallbackCtx({ callbackData: "w:sess_zero:gen" });

      const handled = await handleWizardCallback({
        ctx,
        wizardRepo: repos.wizardSessions,
        onGenerate: async () => {
          genTriggered = true;
        }
      });

      assert.equal(handled, true);
      assert.equal(genTriggered, false);
      assert.ok(ctx.getAnsweredText()?.includes("minimal satu tipe"));
      assert.equal(ctx.getAnsweredAlert(), true);
    });

    it("should allow Generate when types are selected and call onGenerate", async () => {
      repos.wizardSessions.saveSession({
        id: "sess_valid",
        userId: 1001,
        chatId: 1001,
        state: "SELECT_TYPES",
        payload: { count: 10, selectedTypes: [1, 2] },
        expiresAt: Date.now() + 60000
      });

      let generatedPayload = null;
      const ctx = createCallbackCtx({ callbackData: "w:sess_valid:gen" });

      const handled = await handleWizardCallback({
        ctx,
        wizardRepo: repos.wizardSessions,
        onGenerate: async (p) => {
          generatedPayload = p;
        }
      });

      assert.equal(handled, true);
      assert.ok(generatedPayload);
      assert.equal(generatedPayload.count, 10);
      assert.deepEqual(generatedPayload.selectedTypes, [1, 2]);
    });

    it("should handle Cancel by deleting session and editing message", async () => {
      repos.wizardSessions.saveSession({
        id: "sess_cancel",
        userId: 1001,
        chatId: 1001,
        state: "SELECT_TYPES",
        payload: { count: 1, selectedTypes: [1] },
        expiresAt: Date.now() + 60000
      });

      const ctx = createCallbackCtx({ callbackData: "w:sess_cancel:cancel" });
      const handled = await handleWizardCallback({
        ctx,
        wizardRepo: repos.wizardSessions
      });

      assert.equal(handled, true);
      assert.equal(repos.wizardSessions.getSession("sess_cancel"), null);
      assert.ok(ctx.getEditedText()?.includes("dibatalkan"));
    });

    it("should reject callbacks for non-existent sessions with alert", async () => {
      const ctx = createCallbackCtx({ callbackData: "w:nonexistent:gen" });
      const handled = await handleWizardCallback({
        ctx,
        wizardRepo: repos.wizardSessions
      });

      assert.equal(handled, true);
      assert.ok(ctx.getAnsweredText()?.includes("tidak ditemukan"));
      assert.equal(ctx.getAnsweredAlert(), true);
    });

    it("should prevent callback hijacking by another user", async () => {
      repos.wizardSessions.saveSession({
        id: "sess_hijack",
        userId: 1001, // Owner is 1001
        chatId: 1001,
        state: "SELECT_TYPES",
        payload: { count: 1, selectedTypes: [1] },
        expiresAt: Date.now() + 60000
      });

      const ctx = createCallbackCtx({
        userId: 9999, // Attacker
        chatId: 9999,
        callbackData: "w:sess_hijack:gen"
      });

      const handled = await handleWizardCallback({
        ctx,
        wizardRepo: repos.wizardSessions
      });

      assert.equal(handled, true);
      assert.ok(ctx.getAnsweredText()?.includes("Akses ditolak"));
      assert.equal(ctx.getAnsweredAlert(), true);
    });

    it("should reject expired sessions with alert and clean up from DB", async () => {
      repos.wizardSessions.saveSession({
        id: "sess_expired",
        userId: 1001,
        chatId: 1001,
        state: "SELECT_TYPES",
        payload: { count: 1, selectedTypes: [1] },
        expiresAt: Date.now() - 5000 // Expired 5s ago
      });

      const ctx = createCallbackCtx({ callbackData: "w:sess_expired:gen" });
      const handled = await handleWizardCallback({
        ctx,
        wizardRepo: repos.wizardSessions
      });

      assert.equal(handled, true);
      assert.ok(ctx.getAnsweredText()?.includes("kedaluwarsa"));
      assert.equal(ctx.getAnsweredAlert(), true);
      assert.equal(repos.wizardSessions.getSession("sess_expired"), null);
    });
  });
});
