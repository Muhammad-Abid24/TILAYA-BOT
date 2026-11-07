import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createOperationRegistry } from "../../src/services/operationRegistry.js";
import { createEmailService } from "../../src/services/emailService.js";
import { registerStopHandler } from "../../src/bot/handlers/stop.js";
import { sendHttpRequest } from "../../src/api/httpClient.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories.js";
import { OperationCancelledError } from "../../src/utils/errors.js";

describe("/stop Handler & Cancellation Mechanism (T12)", () => {
  let db;
  let repos;
  let registry;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
    registry = createOperationRegistry();
  });

  describe("Fast Cancellation (AC: test slow fetch dibatalkan cepat)", () => {
    it("should abort a slow fetch immediately when stopOperation is triggered", async () => {
      const op = registry.startOperation(1001, "slow_fetch");

      let fetchStarted = false;
      let fetchFinished = false;

      const slowMockFetch = async (_, { signal }) => {
        fetchStarted = true;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            fetchFinished = true;
            resolve(new Response(JSON.stringify({ ok: true })));
          }, 3000); // 3 seconds slow network

          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        });
      };

      const startTime = Date.now();

      // Trigger /stop after 20ms
      setTimeout(() => {
        registry.stopOperation(1001, "Stopped via /stop");
      }, 20);

      await assert.rejects(
        async () => {
          await sendHttpRequest("http://localhost/test", {
            fetchFn: slowMockFetch,
            signal: op.signal,
            timeoutMs: 10000
          });
        },
        (err) => {
          assert.ok(err instanceof OperationCancelledError);
          return true;
        }
      );

      const elapsed = Date.now() - startTime;
      assert.equal(fetchStarted, true);
      assert.equal(fetchFinished, false, "Slow fetch must not finish");
      assert.ok(elapsed < 200, `Aborted quickly in ${elapsed}ms (expected < 200ms)`);
      assert.equal(registry.hasActiveOperation(1001), false);
    });
  });

  describe("No Additional Batches After Stop (AC: tidak ada batch tambahan sesudah stop)", () => {
    it("should abort email generation loop and prevent subsequent batch calls", async () => {
      let callCount = 0;
      const op = registry.startOperation(1001, "generate");

      const mockApiClient = {
        async generateEmail({ signal }) {
          callCount++;
          registry.stopOperation(1001);
          if (signal?.aborted) {
            throw new OperationCancelledError("Aborted");
          }
          return { email: "addr1@test.com", type: 1 };
        },
        async generateBulkEmail({ signal }) {
          callCount++;
          registry.stopOperation(1001);
          if (signal?.aborted) {
            throw new OperationCancelledError("Aborted");
          }
          return ["addr1@test.com"];
        }
      };

      const emailService = createEmailService({
        apiClient: mockApiClient,
        repos,
        batchSize: 1,
        bulkDelayMs: 20
      });

      await assert.rejects(
        async () => {
          await emailService.generateEmails({
            userId: 1001,
            count: 5,
            selectedTypes: [1],
            signal: op.signal
          });
        },
        (err) => {
          assert.ok(err instanceof OperationCancelledError);
          return true;
        }
      );

      assert.equal(callCount, 1, "Must not trigger subsequent batch requests after stop");
    });
  });

  describe("Preserve Historical Data (AC: tidak menghapus histori lama)", () => {
    it("should preserve prior batches and addresses when /stop is executed", async () => {
      // Seed existing history for user 1001
      repos.batches.createBatch({ id: "hist_batch", userId: 1001, requested: 2, selectedTypes: [1] });
      repos.batches.updateBatch({ id: "hist_batch", userId: 1001, received: 2, status: "completed" });
      repos.addresses.saveBatchAddresses({
        batchId: "hist_batch",
        userId: 1001,
        addresses: [
          { email: "hist1@domain.com", typeId: 1 },
          { email: "hist2@domain.com", typeId: 1 }
        ]
      });

      // Start an active operation and stop it
      registry.startOperation(1001, "active_op");

      let stopReply = "";
      const stopCtx = {
        from: { id: 1001 },
        services: { operationRegistry: registry, repos },
        reply: async (text) => {
          stopReply = text;
        }
      };

      const registeredCommands = new Map();
      const mockBot = {
        command: (cmd, handler) => registeredCommands.set(cmd, handler)
      };
      registerStopHandler(mockBot);

      await registeredCommands.get("stop")(stopCtx);
      assert.ok(stopReply.includes("Operasi Berhasil Dibatalkan"));

      // Verify historical data is untouched
      const hist = repos.batches.getLatestBatch(1001);
      assert.ok(hist);
      assert.equal(hist.id, "hist_batch");
      assert.equal(repos.addresses.hasUserAddress(1001, "hist1@domain.com"), true);
      assert.equal(repos.addresses.hasUserAddress(1001, "hist2@domain.com"), true);
    });
  });

  describe("Bot Responsiveness After Stop (AC: bot tetap merespons /start)", () => {
    it("should allow starting new operations after /stop", async () => {
      registry.startOperation(1001, "op1");
      assert.equal(registry.hasActiveOperation(1001), true);

      // Execute /stop
      registry.stopOperation(1001);
      assert.equal(registry.hasActiveOperation(1001), false);

      // User can immediately start new operation without being blocked
      assert.doesNotThrow(() => {
        registry.startOperation(1001, "new_op");
      });
      assert.equal(registry.hasActiveOperation(1001), true);
    });

    it("should reply informatively when /stop is called with no active operations", async () => {
      let replyText = "";
      const ctx = {
        from: { id: 1001 },
        services: { operationRegistry: registry, repos },
        reply: async (text) => {
          replyText = text;
        }
      };

      const registeredCommands = new Map();
      const mockBot = {
        command: (cmd, handler) => registeredCommands.set(cmd, handler)
      };
      registerStopHandler(mockBot);

      await registeredCommands.get("stop")(ctx);
      assert.ok(replyText.includes("Tidak ada operasi aktif"));
    });
  });
});
