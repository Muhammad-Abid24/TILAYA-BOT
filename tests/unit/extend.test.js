import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createExtendService } from "../../src/services/extendService.js";
import { handleExtendCallback } from "../../src/bot/handlers/extend.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories.js";
import { AuthorizationError, ValidationError } from "../../src/utils/errors.js";

describe("Email Extension Service & Handlers (T10)", () => {
  let db;
  let repos;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
  });

  describe("Ownership Validation (AC: email milik user lain ditolak)", () => {
    it("should allow email owned by the user", () => {
      repos.batches.createBatch({ id: "b1", userId: 1001, requested: 1, selectedTypes: [1] });
      repos.addresses.saveBatchAddresses({
        batchId: "b1",
        userId: 1001,
        addresses: [{ email: "my_email@domain.com", typeId: 1 }]
      });

      const extendService = createExtendService({ apiClient: {}, repos });
      const validated = extendService.validateOwnership({
        userId: 1001,
        email: "my_email@domain.com"
      });

      assert.equal(validated, "my_email@domain.com");
    });

    it("should reject email owned by another user", () => {
      repos.batches.createBatch({ id: "b2", userId: 1002, requested: 1, selectedTypes: [1] });
      repos.addresses.saveBatchAddresses({
        batchId: "b2",
        userId: 1002,
        addresses: [{ email: "user2_secret@domain.com", typeId: 1 }]
      });

      const extendService = createExtendService({ apiClient: {}, repos });

      assert.throws(
        () => {
          extendService.validateOwnership({
            userId: 1001, // User 1001 attempting to extend User 1002's email
            email: "user2_secret@domain.com"
          });
        },
        (err) => {
          assert.ok(err instanceof AuthorizationError);
          assert.ok(err.message.includes("bukan milik Anda"));
          return true;
        }
      );
    });

    it("should reject unrecorded or invalid emails", () => {
      const extendService = createExtendService({ apiClient: {}, repos });

      assert.throws(
        () => extendService.validateOwnership({ userId: 1001, email: "invalid-email" }),
        (err) => err instanceof ValidationError
      );

      assert.throws(
        () => extendService.validateOwnership({ userId: 1001, email: "unrecorded@domain.com" }),
        (err) => err instanceof AuthorizationError
      );
    });
  });

  describe("executeExtend (AC: sukses hanya jika status success, kegagalan API ditampilkan)", () => {
    it("should succeed only when upstream API returns success", async () => {
      repos.batches.createBatch({ id: "b1", userId: 1001, requested: 1, selectedTypes: [1] });
      repos.addresses.saveBatchAddresses({
        batchId: "b1",
        userId: 1001,
        addresses: [{ email: "active@domain.com", typeId: 1 }]
      });

      let requestedEmail = "";
      const mockApiClient = {
        async extendEmail({ email }) {
          requestedEmail = email;
          return {
            success: true,
            message: "Email diperpanjang hingga 24 jam",
            expiresAt: "2026-11-09T10:00:00Z"
          };
        }
      };

      const extendService = createExtendService({ apiClient: mockApiClient, repos });
      const result = await extendService.executeExtend({
        userId: 1001,
        email: "active@domain.com"
      });

      assert.equal(requestedEmail, "active@domain.com");
      assert.equal(result.success, true);
      assert.equal(result.message, "Email diperpanjang hingga 24 jam");
      assert.equal(result.expiresAt, "2026-11-09T10:00:00Z");
    });

    it("should throw and expose API failure message when upstream rejects extension", async () => {
      repos.batches.createBatch({ id: "b1", userId: 1001, requested: 1, selectedTypes: [1] });
      repos.addresses.saveBatchAddresses({
        batchId: "b1",
        userId: 1001,
        addresses: [{ email: "expired@domain.com", typeId: 1 }]
      });

      const mockApiClient = {
        async extendEmail() {
          throw new Error("Email sudah lewat batas perpanjangan");
        }
      };

      const extendService = createExtendService({ apiClient: mockApiClient, repos });

      await assert.rejects(
        async () => {
          await extendService.executeExtend({
            userId: 1001,
            email: "expired@domain.com"
          });
        },
        (err) => {
          assert.ok(err.message.includes("Email sudah lewat batas"));
          return true;
        }
      );
    });
  });

  describe("handleExtendCallback (Interactive Confirmation)", () => {
    it("should handle interactive selection and transition to confirmation", async () => {
      repos.wizardSessions.saveSession({
        id: "ext_sess1",
        userId: 1001,
        chatId: 1001,
        state: "EXTEND_SELECT",
        payload: { recentEmails: ["recent1@domain.com", "recent2@domain.com"] },
        expiresAt: Date.now() + 60000
      });

      let editedText = "";
      let editedMarkup = null;

      const ctx = {
        from: { id: 1001 },
        chat: { id: 1001 },
        callbackQuery: { data: "ext:sess1:sel:0" },
        services: { repos, extendService: {} },
        answerCbQuery: async () => {},
        editMessageText: async (text, options) => {
          editedText = text;
          editedMarkup = options?.reply_markup;
        }
      };

      const handled = await handleExtendCallback(ctx);
      assert.equal(handled, true);
      assert.ok(editedText.includes("recent1@domain.com"));
      assert.ok(editedText.includes("Konfirmasi Perpanjangan"));
      assert.ok(editedMarkup.inline_keyboard[0][0].text.includes("Ya, Perpanjang"));

      // Verify session updated to EXTEND_CONFIRM
      const updatedSess = repos.wizardSessions.getSession("ext_sess1");
      assert.equal(updatedSess.state, "EXTEND_CONFIRM");
      assert.equal(updatedSess.payload.email, "recent1@domain.com");
    });

    it("should execute extension on confirm callback", async () => {
      repos.wizardSessions.saveSession({
        id: "ext_sess2",
        userId: 1001,
        chatId: 1001,
        state: "EXTEND_CONFIRM",
        payload: { email: "confirm@domain.com" },
        expiresAt: Date.now() + 60000
      });

      let editedText = "";
      const mockExtendService = {
        async executeExtend({ email: _email }) {
          return {
            success: true,
            message: "Berhasil diperpanjang",
            expiresAt: "Besok"
          };
        }
      };

      const ctx = {
        from: { id: 1001 },
        chat: { id: 1001 },
        callbackQuery: { data: "ext:sess2:confirm" },
        services: {
          repos,
          extendService: mockExtendService,
          operationRegistry: {
            hasActiveOperation: () => false,
            startOperation: () => ({ signal: null }),
            clearOperation: () => {}
          }
        },
        answerCbQuery: async () => {},
        editMessageText: async (text) => {
          editedText = text;
        }
      };

      const handled = await handleExtendCallback(ctx);
      assert.equal(handled, true);
      assert.ok(editedText.includes("Email Berhasil Diperpanjang"));
      assert.ok(editedText.includes("confirm@domain.com"));

      // Session should be deleted
      assert.equal(repos.wizardSessions.getSession("ext_sess2"), null);
    });

    it("should reject cancel callback and clean session", async () => {
      repos.wizardSessions.saveSession({
        id: "ext_sess3",
        userId: 1001,
        chatId: 1001,
        state: "EXTEND_CONFIRM",
        payload: { email: "cancel@domain.com" },
        expiresAt: Date.now() + 60000
      });

      let editedText = "";
      const ctx = {
        from: { id: 1001 },
        chat: { id: 1001 },
        callbackQuery: { data: "ext:sess3:cancel" },
        services: { repos, extendService: {} },
        answerCbQuery: async () => {},
        editMessageText: async (text) => {
          editedText = text;
        }
      };

      const handled = await handleExtendCallback(ctx);
      assert.equal(handled, true);
      assert.ok(editedText.includes("dibatalkan"));
      assert.equal(repos.wizardSessions.getSession("ext_sess3"), null);
    });

    it("should prevent callback hijack by another user", async () => {
      repos.wizardSessions.saveSession({
        id: "ext_hijack",
        userId: 1001, // Owner is 1001
        chatId: 1001,
        state: "EXTEND_CONFIRM",
        payload: { email: "owner@domain.com" },
        expiresAt: Date.now() + 60000
      });

      let alertText = "";
      const ctx = {
        from: { id: 9999 }, // Attacker
        chat: { id: 9999 },
        callbackQuery: { data: "ext:hijack:confirm" },
        services: { repos, extendService: {} },
        answerCbQuery: async (text) => {
          alertText = text;
        }
      };

      const handled = await handleExtendCallback(ctx);
      assert.equal(handled, true);
      assert.ok(alertText.includes("Akses ditolak"));
    });
  });
});
