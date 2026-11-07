import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createInboxService,
  renderInboxPage,
  renderMessageDetail
} from "../../src/services/inboxService.js";
import { handleInboxCallback } from "../../src/bot/handlers/inbox.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories.js";
import { AuthorizationError, ValidationError } from "../../src/utils/errors.js";

describe("Inbox Service & Handlers (T09)", () => {
  let db;
  let repos;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
  });

  describe("Ownership Validation & getInbox", () => {
    it("should reject email not owned by the user (AC: validasi ownership)", async () => {
      const mockApiClient = {
        async getMessageList() {
          return [];
        }
      };

      const inboxService = createInboxService({ apiClient: mockApiClient, repos });

      await assert.rejects(
        async () => {
          await inboxService.getInbox({
            userId: 1001,
            email: "foreign@example.com"
          });
        },
        (err) => {
          assert.ok(err instanceof AuthorizationError);
          assert.ok(err.message.includes("Akses ditolak"));
          return true;
        }
      );
    });

    it("should reject invalid email format", async () => {
      const inboxService = createInboxService({ apiClient: {}, repos });

      await assert.rejects(
        async () => {
          await inboxService.getInbox({
            userId: 1001,
            email: "not-an-email"
          });
        },
        (err) => {
          assert.ok(err instanceof ValidationError);
          return true;
        }
      );
    });

    it("should fetch messages and save snapshot with ordinal-to-messageId mapping", async () => {
      // Seed address for user 1001
      repos.batches.createBatch({ id: "b1", userId: 1001, requested: 1, selectedTypes: [1] });
      repos.addresses.saveBatchAddresses({
        batchId: "b1",
        userId: 1001,
        addresses: [{ email: "mymail@domain.com", typeId: 1 }]
      });

      const mockApiClient = {
        async getMessageList({ email }) {
          assert.equal(email, "mymail@domain.com");
          return [
            { id: "upstream_id_101", sender: "Service A", subject: "Welcome", date: "10:00" },
            { id: "upstream_id_202", sender: "Service B", subject: "OTP Code", date: "10:05" }
          ];
        }
      };

      const inboxService = createInboxService({ apiClient: mockApiClient, repos });
      const inboxData = await inboxService.getInbox({
        userId: 1001,
        email: "mymail@domain.com"
      });

      assert.ok(inboxData.snapshotId);
      assert.equal(inboxData.totalMessages, 2);
      assert.equal(inboxData.messages[0].ordinal, 1);
      assert.equal(inboxData.messages[0].messageId, "upstream_id_101");
      assert.equal(inboxData.messages[1].ordinal, 2);
      assert.equal(inboxData.messages[1].messageId, "upstream_id_202");

      // Verify in DB
      const snap = repos.inboxSnapshots.getSnapshot(inboxData.snapshotId, 1001);
      assert.ok(snap);
      assert.equal(snap.messages.length, 2);
    });
  });

  describe("Ordinal Stability (AC: urutan berubah tidak menyebabkan salah pesan)", () => {
    it("should bind read button to exact upstream message ID via snapshot ordinal", async () => {
      // Seed address
      repos.batches.createBatch({ id: "b1", userId: 1001, requested: 1, selectedTypes: [1] });
      repos.addresses.saveBatchAddresses({
        batchId: "b1",
        userId: 1001,
        addresses: [{ email: "mymail@domain.com", typeId: 1 }]
      });

      let requestedMessageId = "";
      const mockApiClient = {
        async getMessageList() {
          return [
            { id: "first_msg_id", sender: "A", subject: "Sub 1" },
            { id: "second_msg_id", sender: "B", subject: "Sub 2" }
          ];
        },
        async getMessage({ id }) {
          requestedMessageId = id;
          return {
            id,
            sender: "A",
            subject: "Sub 1",
            bodyText: "Content of first message"
          };
        }
      };

      const inboxService = createInboxService({ apiClient: mockApiClient, repos });
      const inboxData = await inboxService.getInbox({
        userId: 1001,
        email: "mymail@domain.com"
      });

      // Reading ordinal 1 MUST look up "first_msg_id"
      const readResult = await inboxService.readMessage({
        userId: 1001,
        snapshotId: inboxData.snapshotId,
        ordinal: 1
      });

      assert.equal(requestedMessageId, "first_msg_id");
      assert.equal(readResult.messageId, "first_msg_id");
      assert.equal(readResult.bodyText, "Content of first message");
    });
  });

  describe("Safe Rendering (AC: HTML tidak dieksekusi)", () => {
    it("should escape special characters in message detail to avoid HTML execution", () => {
      const unsafeDetail = {
        sender: "<admin@malicious.com>",
        subject: "<script>alert('xss')</script>",
        date: "2026-11-08",
        bodyText: "Your OTP is 123456 <img src=x onerror=alert(1)>"
      };

      const rendered = renderMessageDetail({
        snapshotId: "snap123",
        detail: unsafeDetail
      });

      assert.ok(!rendered.text.includes("<script>"));
      assert.ok(rendered.text.includes("&lt;script&gt;"));
      assert.ok(rendered.text.includes("&lt;admin@malicious.com&gt;"));
      assert.ok(rendered.text.includes("&lt;img src=x onerror=alert(1)&gt;"));
    });

    it("should safely truncate message body exceeding Telegram limits", () => {
      const longBody = "A".repeat(4000);
      const rendered = renderMessageDetail({
        snapshotId: "snap123",
        detail: {
          sender: "system",
          subject: "long message",
          bodyText: longBody
        }
      });

      assert.ok(rendered.text.length < 4000);
      assert.ok(rendered.text.includes("dipotong karena melebihi batas"));
    });
  });

  describe("Empty Inbox & Pagination Rendering", () => {
    it("should render empty inbox view with refresh button (AC: empty inbox)", () => {
      const rendered = renderInboxPage({
        snapshotId: "snap_empty",
        email: "empty@domain.com",
        messages: []
      });

      assert.ok(rendered.text.includes("Kotak Masuk Kosong"));
      assert.ok(rendered.reply_markup.inline_keyboard[0][0].text.includes("Muat Ulang"));
    });

    it("should paginate messages with 5 items per page and navigation buttons", () => {
      const messages = [];
      for (let i = 1; i <= 12; i++) {
        messages.push({
          ordinal: i,
          sender: `Sender ${i}`,
          subject: `Subject ${i}`,
          receivedAt: "2026-11-08"
        });
      }

      // Page 1
      const page1 = renderInboxPage({ snapshotId: "snap_pg", email: "test@domain.com", messages, page: 1 });
      assert.ok(page1.text.includes("Halaman 1/3"));
      assert.ok(page1.text.includes("[1] Dari:"));
      assert.ok(page1.text.includes("[5] Dari:"));
      assert.ok(!page1.text.includes("[6] Dari:"));

      // Page 2
      const page2 = renderInboxPage({ snapshotId: "snap_pg", email: "test@domain.com", messages, page: 2 });
      assert.ok(page2.text.includes("Halaman 2/3"));
      assert.ok(page2.text.includes("[6] Dari:"));
      assert.ok(page2.text.includes("[10] Dari:"));
      assert.ok(!page2.text.includes("[11] Dari:"));
    });
  });

  describe("Inbox Callbacks (AC: callback stale teruji)", () => {
    it("should reject stale or non-existent snapshot callback with alert", async () => {
      let answeredText = "";
      let answeredAlert = false;

      const ctx = {
        from: { id: 1001 },
        callbackQuery: { data: "inbox:stale_snap_id:p:1" },
        services: { repos, inboxService: {} },
        answerCbQuery: async (text, options) => {
          answeredText = text;
          answeredAlert = Boolean(options?.show_alert);
        }
      };

      const handled = await handleInboxCallback(ctx);
      assert.equal(handled, true);
      assert.ok(answeredText.includes("kedaluwarsa atau tidak valid"));
      assert.equal(answeredAlert, true);
    });
  });
});

