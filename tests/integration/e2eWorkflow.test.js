import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories.js";
import { createOperationRegistry } from "../../src/services/operationRegistry.js";
import { createEmailService } from "../../src/services/emailService.js";
import { createExportService } from "../../src/services/exportService.js";
import { createInboxService } from "../../src/services/inboxService.js";
import { createExtendService } from "../../src/services/extendService.js";
import { createBot } from "../../src/bot/createBot.js";

describe("End-to-End Workflow & Security Integration Test (T14)", () => {
  it("should complete the full lifecycle: /start -> /get 5 -> toggle 2 types -> generate -> /export -> /inbox -> read -> /extend -> /done", async () => {
    // 1. Setup real SQLite DB and Repositories
    const db = createDatabase(":memory:");
    runMigrations(db);
    const repos = createRepositories(db);
    const operationRegistry = createOperationRegistry();

    // 2. Setup mock upstream API Client
    const generatedStore = new Set();
    const mockMessages = [
      {
        id: "msg_upstream_001",
        sender: "security@google.com",
        subject: "Verification Code",
        date: "2026-11-08 12:00:00",
        bodyText: "Your secure OTP code is 456789. Do not share it."
      }
    ];

    const apiClient = {
      async generateEmail({ ids: _ids }) {
        const email = `email_${generatedStore.size + 1}@domain.com`;
        generatedStore.add(email);
        return { email, type: 1 };
      },
      async generateBulkEmail({ ids: _ids, count }) {
        const batch = [];
        for (let i = 0; i < count; i++) {
          const email = `bulk_${generatedStore.size + 1}@domain.com`;
          generatedStore.add(email);
          batch.push(email);
        }
        return batch;
      },
      async getMessageList({ email: _email }) {
        return mockMessages;
      },
      async getMessage({ id }) {
        const found = mockMessages.find((m) => m.id === id);
        return found || { id, sender: "unknown", subject: "none", bodyText: "empty" };
      },
      async extendEmail({ email: _email }) {
        return {
          success: true,
          message: "Email extended for 24 hours",
          expiresAt: "2026-11-09T12:00:00Z"
        };
      }
    };

    // 3. Setup real business services
    const emailService = createEmailService({ apiClient, repos, batchSize: 50, bulkDelayMs: 2 });
    const exportService = createExportService({ repos });
    const inboxService = createInboxService({ apiClient, repos });
    const extendService = createExtendService({ apiClient, repos });

    // 4. Setup mock bot router to track registered middleware, commands, on handlers
    const registeredMiddlewares = [];
    const registeredCommands = new Map();
    const registeredOn = new Map();

    const mockBot = {
      context: {},
      use(fn) {
        registeredMiddlewares.push(fn);
      },
      command(cmd, handler) {
        registeredCommands.set(cmd, handler);
      },
      on(event, handler) {
        registeredOn.set(event, handler);
      }
    };

    const ALLOWED_USER_ID = 1001;

    createBot({
      botToken: "123456:mock_token",
      allowedIds: new Set([ALLOWED_USER_ID]),
      services: {
        repos,
        operationRegistry,
        emailService,
        exportService,
        inboxService,
        extendService,
        apiClient
      },
      customBotInstance: mockBot
    });

    // Helper to simulate executing a command with middleware pipeline
    async function executeCommand(cmdName, messageText, userId = ALLOWED_USER_ID, chatId = ALLOWED_USER_ID) {
      let repliedText = null;
      let repliedMarkup = null;
      let sentDocument = null;

      const ctx = {
        from: { id: userId, first_name: "Tester" },
        chat: { id: chatId, type: "private" },
        message: { text: messageText },
        telegram: {
          editMessageText: async (_cId, _mId, _inlineId, text, options) => {
            repliedText = text;
            repliedMarkup = options?.reply_markup;
          }
        },
        services: mockBot.context.services,
        reply: async (text, options) => {
          repliedText = text;
          repliedMarkup = options?.reply_markup;
          return { message_id: 100 };
        },
        replyWithDocument: async (doc, options) => {
          sentDocument = doc;
          repliedText = options?.caption;
        }
      };

      const handler = registeredCommands.get(cmdName);
      assert.ok(handler, `Command /${cmdName} must be registered`);

      // Run through auth middleware
      for (const mw of registeredMiddlewares) {
        let calledNext = false;
        await mw(ctx, async () => {
          calledNext = true;
        });
        if (!calledNext) {
          // Middleware rejected request
          return { ctx, repliedText, repliedMarkup, sentDocument, allowed: false };
        }
      }

      await handler(ctx);
      return { ctx, repliedText, repliedMarkup, sentDocument, allowed: true };
    }

    // Helper to simulate clicking an inline button (callback_query)
    async function executeCallback(callbackData, userId = ALLOWED_USER_ID, chatId = ALLOWED_USER_ID) {
      let answeredText = null;
      let answeredAlert = false;
      let editedText = null;
      let editedMarkup = null;

      const ctx = {
        from: { id: userId },
        chat: { id: chatId, type: "private" },
        callbackQuery: { data: callbackData },
        services: mockBot.context.services,
        answerCbQuery: async (text, options) => {
          answeredText = text;
          answeredAlert = Boolean(options?.show_alert);
        },
        editMessageText: async (text, options) => {
          editedText = text;
          editedMarkup = options?.reply_markup;
        },
        reply: async (text) => {
          editedText = text;
        }
      };

      // Run through auth middleware
      for (const mw of registeredMiddlewares) {
        let calledNext = false;
        await mw(ctx, async () => {
          calledNext = true;
        });
        if (!calledNext) {
          return { ctx, answeredText, answeredAlert, editedText, allowed: false };
        }
      }

      const cbHandler = registeredOn.get("callback_query");
      assert.ok(cbHandler, "Callback query handler must be registered");
      await cbHandler(ctx, async () => {});

      return { ctx, answeredText, answeredAlert, editedText, editedMarkup, allowed: true };
    }

    // =========================================================================
    // STEP 1: /start
    // =========================================================================
    const startRes = await executeCommand("start", "/start");
    assert.equal(startRes.allowed, true);
    assert.ok(startRes.repliedText.includes("TILAYA"));
    assert.ok(startRes.repliedMarkup?.inline_keyboard);

    // =========================================================================
    // STEP 2: /get 5 -> Launch Type Wizard
    // =========================================================================
    const getRes = await executeCommand("get", "/get 5");
    assert.equal(getRes.allowed, true);
    assert.ok(getRes.repliedText.includes("5 alamat"));
    assert.ok(getRes.repliedMarkup?.inline_keyboard);

    // Extract session ID from callback buttons
    const genBtnData = getRes.repliedMarkup.inline_keyboard
      .flat()
      .find((b) => b.callback_data.startsWith("w:") && b.callback_data.endsWith(":gen"))
      ?.callback_data;
    assert.ok(genBtnData, "Wizard generate button must exist");
    const wizardSessionId = genBtnData.split(":")[1];

    // =========================================================================
    // STEP 3: Toggle 2 types in wizard: Type 1 (Domain) & Type 8 (GoogleMail)
    // =========================================================================
    // Toggle Type 1
    const toggle1 = await executeCallback(`w:${wizardSessionId}:t:1`);
    assert.equal(toggle1.allowed, true);
    // Toggle Type 8
    const toggle8 = await executeCallback(`w:${wizardSessionId}:t:8`);
    assert.equal(toggle8.allowed, true);

    const updatedWizardSess = repos.wizardSessions.getSession(wizardSessionId);
    assert.deepEqual(updatedWizardSess.payload.selectedTypes.sort(), [1, 8]);

    // =========================================================================
    // STEP 4: Generate emails
    // =========================================================================
    const genCallbackRes = await executeCallback(`w:${wizardSessionId}:gen`);
    assert.equal(genCallbackRes.allowed, true);
    assert.ok(genCallbackRes.editedText.includes("Berhasil Membuat 5 Email"));

    // Verify 5 addresses exist in database
    const latestBatch = repos.batches.getLatestBatch(ALLOWED_USER_ID);
    assert.ok(latestBatch);
    assert.equal(latestBatch.received, 5);
    const savedAddresses = repos.addresses.getBatchAddresses(latestBatch.id, ALLOWED_USER_ID);
    assert.equal(savedAddresses.length, 5);
    const targetEmail = savedAddresses[0].email;

    // =========================================================================
    // STEP 5: /export
    // =========================================================================
    const exportRes = await executeCommand("export", "/export");
    assert.equal(exportRes.allowed, true);
    assert.ok(exportRes.sentDocument);
    assert.ok(exportRes.sentDocument.filename.startsWith("tempmail-"));
    const exportedText = exportRes.sentDocument.source.toString("utf-8");
    for (const addr of savedAddresses) {
      assert.ok(exportedText.includes(addr.email));
    }

    // =========================================================================
    // STEP 6: /inbox targetEmail
    // =========================================================================
    const inboxRes = await executeCommand("inbox", `/inbox ${targetEmail}`);
    assert.equal(inboxRes.allowed, true);
    assert.ok(inboxRes.repliedText.includes("Kotak Masuk"));
    assert.ok(inboxRes.repliedText.includes(targetEmail));
    assert.ok(inboxRes.repliedMarkup?.inline_keyboard);

    // Extract inbox snapshot ID from read button
    const readBtnData = inboxRes.repliedMarkup.inline_keyboard
      .flat()
      .find((b) => b.callback_data.startsWith("inbox:") && b.callback_data.includes(":r:"))
      ?.callback_data;
    assert.ok(readBtnData, "Inbox read button must exist");
    const inboxSnapshotId = readBtnData.split(":")[1];

    // =========================================================================
    // STEP 7: Read message detail
    // =========================================================================
    const readRes = await executeCallback(`inbox:${inboxSnapshotId}:r:1`);
    assert.equal(readRes.allowed, true);
    assert.ok(readRes.editedText.includes("Detail Pesan"));
    assert.ok(readRes.editedText.includes("456789")); // OTP body
    assert.ok(readRes.editedMarkup.inline_keyboard[0][0].text.includes("Kembali"));

    // =========================================================================
    // STEP 8: /extend targetEmail
    // =========================================================================
    const extendRes = await executeCommand("extend", `/extend ${targetEmail}`);
    assert.equal(extendRes.allowed, true);
    assert.ok(extendRes.repliedText.includes("Konfirmasi Perpanjangan"));

    const extendBtnData = extendRes.repliedMarkup.inline_keyboard[0][0].callback_data;
    const extendSessionId = extendBtnData.split(":")[1];

    // Click Confirm
    const extendConfirmRes = await executeCallback(`ext:${extendSessionId}:confirm`);
    assert.equal(extendConfirmRes.allowed, true);
    assert.ok(extendConfirmRes.editedText.includes("Email Berhasil Diperpanjang"));

    // =========================================================================
    // STEP 9: /done (Purge User Data)
    // =========================================================================
    const doneRes = await executeCommand("done", "/done");
    assert.equal(doneRes.allowed, true);
    assert.ok(doneRes.repliedText.includes("Konfirmasi Pembersihan"));

    const doneBtnData = doneRes.repliedMarkup.inline_keyboard[0][0].callback_data;
    const doneSessionId = doneBtnData.split(":")[1];

    // Click Confirm Purge
    const doneConfirmRes = await executeCallback(`done:${doneSessionId}:confirm`);
    assert.equal(doneConfirmRes.allowed, true);
    assert.ok(doneConfirmRes.editedText.includes("Berhasil Dihapus"));

    // Verify /export after /done is EMPTY
    const exportAfterDone = await executeCommand("export", "/export");
    assert.ok(exportAfterDone.repliedText.includes("Belum ada riwayat"));
    assert.equal(repos.batches.getLatestBatch(ALLOWED_USER_ID), null);

    // =========================================================================
    // STEP 10: Security Invariants & Unauthorized User Access
    // =========================================================================
    const UNAUTHORIZED_ID = 9999;
    const unauthCmd = await executeCommand("start", "/start", UNAUTHORIZED_ID);
    assert.equal(unauthCmd.allowed, false);
    assert.ok(unauthCmd.repliedText.includes("Akses ditolak"));

    const unauthCallback = await executeCallback(`w:any:gen`, UNAUTHORIZED_ID);
    assert.equal(unauthCallback.allowed, false);
    assert.ok(unauthCallback.answeredText.includes("Akses ditolak"));
  });
});

