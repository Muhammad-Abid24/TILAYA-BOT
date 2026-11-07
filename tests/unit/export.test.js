import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createExportService, formatExportFilename } from "../../src/services/exportService.js";
import { handleExportAction } from "../../src/bot/handlers/export.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories.js";

describe("Export Service & Handlers (T08)", () => {
  let db;
  let repos;
  let exportService;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
    exportService = createExportService({ repos });
  });

  describe("formatExportFilename", () => {
    it("should format filename as tempmail-YYYYMMDD-HHMMSS.txt", () => {
      const fixedDate = new Date(2026, 10, 8, 14, 30, 45); // Nov 8, 2026, 14:30:45
      const filename = formatExportFilename(fixedDate);
      assert.equal(filename, "tempmail-20261108-143045.txt");
    });
  });

  describe("exportLatestBatch", () => {
    it("should export only the latest batch for the user in valid UTF-8 .txt format", () => {
      // Create first batch (older)
      repos.batches.createBatch({ id: "b1", userId: 1001, requested: 1, selectedTypes: [1], createdAt: 1000 });
      repos.batches.updateBatch({ id: "b1", userId: 1001, received: 1, status: "completed" });
      repos.addresses.saveBatchAddresses({
        batchId: "b1",
        userId: 1001,
        addresses: [{ email: "old@example.com", typeId: 1 }]
      });

      // Create second batch (latest)
      repos.batches.createBatch({ id: "b2", userId: 1001, requested: 2, selectedTypes: [1, 2], createdAt: 2000 });
      repos.batches.updateBatch({ id: "b2", userId: 1001, received: 2, status: "completed" });
      repos.addresses.saveBatchAddresses({
        batchId: "b2",
        userId: 1001,
        addresses: [
          { email: "latest1@example.com", typeId: 1 },
          { email: "latest2@example.com", typeId: 2 }
        ]
      });

      const res = exportService.exportLatestBatch(1001);
      assert.equal(res.success, true);
      assert.equal(res.batchId, "b2");
      assert.equal(res.count, 2);

      const contentStr = res.content.toString("utf-8");
      assert.ok(contentStr.includes("latest1@example.com"));
      assert.ok(contentStr.includes("latest2@example.com"));
      assert.ok(!contentStr.includes("old@example.com"), "Must only export the latest batch");
      assert.equal(contentStr, "latest1@example.com\nlatest2@example.com\n");
    });

    it("should return NO_BATCH if user has never generated emails", () => {
      const res = exportService.exportLatestBatch(9999);
      assert.equal(res.success, false);
      assert.equal(res.reason, "NO_BATCH");
    });

    it("should strictly isolate exports between users (AC: tidak bocor ke user lain)", () => {
      // User 1001 data
      repos.batches.createBatch({ id: "u1_b", userId: 1001, requested: 1, selectedTypes: [1] });
      repos.batches.updateBatch({ id: "u1_b", userId: 1001, received: 1, status: "completed" });
      repos.addresses.saveBatchAddresses({
        batchId: "u1_b",
        userId: 1001,
        addresses: [{ email: "private_user1@secret.com", typeId: 1 }]
      });

      // User 1002 data
      repos.batches.createBatch({ id: "u2_b", userId: 1002, requested: 1, selectedTypes: [1] });
      repos.batches.updateBatch({ id: "u2_b", userId: 1002, received: 1, status: "completed" });
      repos.addresses.saveBatchAddresses({
        batchId: "u2_b",
        userId: 1002,
        addresses: [{ email: "private_user2@secret.com", typeId: 1 }]
      });

      // Export for user 1001
      const res1 = exportService.exportLatestBatch(1001);
      assert.equal(res1.success, true);
      const str1 = res1.content.toString("utf-8");
      assert.ok(str1.includes("private_user1@secret.com"));
      assert.ok(!str1.includes("private_user2@secret.com"));

      // Export for user 1002
      const res2 = exportService.exportLatestBatch(1002);
      assert.equal(res2.success, true);
      const str2 = res2.content.toString("utf-8");
      assert.ok(str2.includes("private_user2@secret.com"));
      assert.ok(!str2.includes("private_user1@secret.com"));
    });
  });

  describe("handleExportAction", () => {
    it("should reply with informative instructions when no batch exists (AC: tanpa batch diberi pesan informatif)", async () => {
      let repliedText = "";
      const ctx = {
        from: { id: 777 },
        services: { exportService },
        reply: async (text) => {
          repliedText = text;
        }
      };

      await handleExportAction(ctx);
      assert.ok(repliedText.includes("Belum ada riwayat email"));
      assert.ok(repliedText.includes("/get"));
      assert.ok(repliedText.includes("/bulk"));
    });

    it("should send document when valid batch exists", async () => {
      repos.batches.createBatch({ id: "b_doc", userId: 888, requested: 1, selectedTypes: [1] });
      repos.batches.updateBatch({ id: "b_doc", userId: 888, received: 1, status: "completed" });
      repos.addresses.saveBatchAddresses({
        batchId: "b_doc",
        userId: 888,
        addresses: [{ email: "export_me@domain.com", typeId: 1 }]
      });

      let sentDocument = null;
      let sentOptions = null;
      const ctx = {
        from: { id: 888 },
        services: { exportService },
        replyWithDocument: async (doc, options) => {
          sentDocument = doc;
          sentOptions = options;
        }
      };

      await handleExportAction(ctx);
      assert.ok(sentDocument);
      assert.ok(sentDocument.filename.startsWith("tempmail-"));
      assert.ok(sentDocument.filename.endsWith(".txt"));
      assert.equal(sentDocument.source.toString("utf-8"), "export_me@domain.com\n");
      assert.ok(sentOptions.caption.includes("1 alamat"));
    });
  });
});
