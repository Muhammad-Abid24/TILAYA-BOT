import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initiateDoneConfirmation, handleDoneCallback } from "../../src/bot/handlers/done.js";
import { createExportService } from "../../src/services/exportService.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories.js";

describe("/done Handler & Transactional Cleanup (T11)", () => {
  let db;
  let repos;
  let exportService;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
    exportService = createExportService({ repos });
  });

  describe("initiateDoneConfirmation", () => {
    it("should present confirmation message with confirmation buttons and save session", async () => {
      let repliedText = "";
      let repliedMarkup = null;

      const ctx = {
        from: { id: 1001 },
        chat: { id: 1001 },
        services: { repos },
        reply: async (text, options) => {
          repliedText = text;
          repliedMarkup = options?.reply_markup;
        }
      };

      await initiateDoneConfirmation(ctx);
      assert.ok(repliedText.includes("Konfirmasi Pembersihan"));
      assert.ok(repliedMarkup.inline_keyboard[0][0].text.includes("Hapus Semua"));
      assert.ok(repliedMarkup.inline_keyboard[0][1].text.includes("Batal"));
    });
  });

  describe("handleDoneCallback (AC: cancel tidak menghapus, confirm hanya menghapus user itu, export sesudah done kosong)", () => {
    it("should NOT delete any data when cancelled (AC: cancel tidak menghapus)", async () => {
      // Seed user data
      repos.batches.createBatch({ id: "b1", userId: 1001, requested: 1, selectedTypes: [1] });
      repos.batches.updateBatch({ id: "b1", userId: 1001, received: 1, status: "completed" });
      repos.addresses.saveBatchAddresses({
        batchId: "b1",
        userId: 1001,
        addresses: [{ email: "preserve@test.com", typeId: 1 }]
      });

      repos.wizardSessions.saveSession({
        id: "done_cancel_sess",
        userId: 1001,
        chatId: 1001,
        state: "DONE_CONFIRM",
        payload: {},
        expiresAt: Date.now() + 60000
      });

      let editedText = "";
      const ctx = {
        from: { id: 1001 },
        chat: { id: 1001 },
        callbackQuery: { data: "done:cancel_sess:cancel" },
        services: { repos },
        answerCbQuery: async () => {},
        editMessageText: async (text) => {
          editedText = text;
        }
      };

      const handled = await handleDoneCallback(ctx);
      assert.equal(handled, true);
      assert.ok(editedText.includes("dibatalkan"));

      // Verify all data is completely preserved
      assert.ok(repos.batches.getLatestBatch(1001));
      assert.equal(repos.addresses.hasUserAddress(1001, "preserve@test.com"), true);
      assert.equal(repos.wizardSessions.getSession("done_cancel_sess"), null);
    });

    it("should delete only requesting user data, preserve other users, and make export empty (AC: confirm, export kosong, isolasi)", async () => {
      // Setup User 1001 data
      repos.batches.createBatch({ id: "b_u1", userId: 1001, requested: 2, selectedTypes: [1] });
      repos.batches.updateBatch({ id: "b_u1", userId: 1001, received: 2, status: "completed" });
      repos.addresses.saveBatchAddresses({
        batchId: "b_u1",
        userId: 1001,
        addresses: [
          { email: "user1_a@domain.com", typeId: 1 },
          { email: "user1_b@domain.com", typeId: 1 }
        ]
      });
      repos.inboxSnapshots.createSnapshot({
        id: "snap_u1",
        userId: 1001,
        email: "user1_a@domain.com",
        messages: [{ ordinal: 1, messageId: "m1", sender: "s", subject: "sub" }]
      });

      // Setup User 1002 data
      repos.batches.createBatch({ id: "b_u2", userId: 1002, requested: 1, selectedTypes: [2] });
      repos.batches.updateBatch({ id: "b_u2", userId: 1002, received: 1, status: "completed" });
      repos.addresses.saveBatchAddresses({
        batchId: "b_u2",
        userId: 1002,
        addresses: [{ email: "user2_safe@domain.com", typeId: 2 }]
      });

      // User 1001 starts /done confirm
      repos.wizardSessions.saveSession({
        id: "done_confirm_sess",
        userId: 1001,
        chatId: 1001,
        state: "DONE_CONFIRM",
        payload: {},
        expiresAt: Date.now() + 60000
      });

      let operationAborted = false;
      let upstreamDeleteCalled = false;
      const mockOperationRegistry = {
        stopOperation: (uId) => {
          if (uId === 1001) operationAborted = true;
        }
      };

      // Mock upstream API client to verify NO DELETE calls happen (AC: tidak memanggil DELETE upstream)
      const mockApiClient = {
        deleteMessage: () => {
          upstreamDeleteCalled = true;
        }
      };

      let editedText = "";
      const ctx = {
        from: { id: 1001 },
        chat: { id: 1001 },
        callbackQuery: { data: "done:confirm_sess:confirm" },
        services: {
          repos,
          operationRegistry: mockOperationRegistry,
          apiClient: mockApiClient
        },
        answerCbQuery: async () => {},
        editMessageText: async (text) => {
          editedText = text;
        }
      };

      const handled = await handleDoneCallback(ctx);
      assert.equal(handled, true);
      assert.ok(editedText.includes("Berhasil Dihapus"));

      // 1. Active operations aborted
      assert.equal(operationAborted, true);

      // 2. No upstream delete called (AC: tidak memanggil DELETE upstream)
      assert.equal(upstreamDeleteCalled, false);

      // 3. User 1001 data is 100% wiped
      assert.equal(repos.batches.getLatestBatch(1001), null);
      assert.equal(repos.addresses.getBatchAddresses("b_u1", 1001).length, 0);
      assert.equal(repos.addresses.hasUserAddress(1001, "user1_a@domain.com"), false);
      assert.equal(repos.inboxSnapshots.getSnapshot("snap_u1", 1001), null);

      // 4. Export after done is empty (AC: export sesudah done kosong)
      const exportRes = exportService.exportLatestBatch(1001);
      assert.equal(exportRes.success, false);
      assert.equal(exportRes.reason, "NO_BATCH");

      // 5. User 1002 data is completely intact (AC: confirm hanya menghapus data user itu)
      const u2Batch = repos.batches.getLatestBatch(1002);
      assert.ok(u2Batch);
      assert.equal(u2Batch.id, "b_u2");
      assert.equal(repos.addresses.hasUserAddress(1002, "user2_safe@domain.com"), true);
      const u2Export = exportService.exportLatestBatch(1002);
      assert.equal(u2Export.success, true);
      assert.ok(u2Export.content.toString("utf-8").includes("user2_safe@domain.com"));
    });

    it("should prevent cross-user callback hijacking on /done", async () => {
      repos.wizardSessions.saveSession({
        id: "done_hijack",
        userId: 1001, // Owner is 1001
        chatId: 1001,
        state: "DONE_CONFIRM",
        payload: {},
        expiresAt: Date.now() + 60000
      });

      let alertText = "";
      const ctx = {
        from: { id: 9999 }, // Attacker
        chat: { id: 9999 },
        callbackQuery: { data: "done:hijack:confirm" },
        services: { repos },
        answerCbQuery: async (text) => {
          alertText = text;
        }
      };

      const handled = await handleDoneCallback(ctx);
      assert.equal(handled, true);
      assert.ok(alertText.includes("Akses ditolak"));
    });
  });
});

