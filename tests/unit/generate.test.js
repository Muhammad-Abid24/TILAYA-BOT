import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseGetCount } from "../../src/bot/handlers/get.js";
import { createEmailService } from "../../src/services/emailService.js";
import { createOperationRegistry } from "../../src/services/operationRegistry.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories.js";

describe("Email Generation Service & Handlers (T07)", () => {
  let db;
  let repos;
  let registry;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
    registry = createOperationRegistry();
  });

  describe("parseGetCount validation (AC: 0, negatif, pecahan, NaN, >50 ditolak)", () => {
    it("should accept valid counts from 1 to 50", () => {
      assert.deepEqual(parseGetCount(""), { valid: true, count: 1 });
      assert.deepEqual(parseGetCount(undefined), { valid: true, count: 1 });
      assert.deepEqual(parseGetCount("1"), { valid: true, count: 1 });
      assert.deepEqual(parseGetCount("25"), { valid: true, count: 25 });
      assert.deepEqual(parseGetCount("50"), { valid: true, count: 50 });
    });

    it("should reject 0", () => {
      const res = parseGetCount("0");
      assert.equal(res.valid, false);
      assert.ok(res.error.includes("Batas"));
    });

    it("should reject negative numbers", () => {
      const res = parseGetCount("-5");
      assert.equal(res.valid, false);
      assert.ok(res.error.includes("angka bulat"));
    });

    it("should reject decimal/floating numbers", () => {
      const res = parseGetCount("2.5");
      assert.equal(res.valid, false);
      assert.ok(res.error.includes("angka bulat"));
    });

    it("should reject NaN and text strings", () => {
      const res = parseGetCount("abc");
      assert.equal(res.valid, false);
      assert.ok(res.error.includes("angka bulat"));
    });

    it("should reject numbers greater than 50", () => {
      const res = parseGetCount("51");
      assert.equal(res.valid, false);
      assert.ok(res.error.includes("Batas"));

      const res100 = parseGetCount("100");
      assert.equal(res100.valid, false);
    });
  });

  describe("Operation Registry (AC: satu active operation/user)", () => {
    it("should enforce exactly one active operation per user", () => {
      assert.equal(registry.hasActiveOperation(1001), false);

      const op1 = registry.startOperation(1001, "generate");
      assert.ok(op1.signal);
      assert.equal(registry.hasActiveOperation(1001), true);

      // Starting a second operation for user 1001 should throw
      assert.throws(
        () => registry.startOperation(1001, "generate"),
        /operasi aktif/
      );

      // User 1002 can start their operation independently
      assert.equal(registry.hasActiveOperation(1002), false);
      const op2 = registry.startOperation(1002, "generate");
      assert.ok(op2.signal);

      // Clearing frees up the lock
      registry.clearOperation(1001);
      assert.equal(registry.hasActiveOperation(1001), false);
      assert.doesNotThrow(() => registry.startOperation(1001, "inbox"));
    });
  });

  describe("emailService.generateEmails", () => {
    it("should generate exact requested count with deduplication when upstream returns duplicates", async () => {
      let callCount = 0;
      // Mock API returning some duplicate emails across calls
      const mockApiClient = {
        async generateBulkEmail({ count }) {
          callCount++;
          if (callCount === 1) {
            // Returns 3 emails, 1 duplicate
            return ["alice@test.com", "bob@test.com", "alice@test.com"];
          }
          // Second call returns distinct remaining
          return ["charlie@test.com", "david@test.com", "eve@test.com"].slice(0, count);
        }
      };

      const emailService = createEmailService({
        apiClient: mockApiClient,
        repos,
        batchSize: 5,
        bulkDelayMs: 5
      });

      const result = await emailService.generateEmails({
        userId: 1001,
        count: 5,
        selectedTypes: [1]
      });

      assert.equal(result.status, "completed");
      assert.equal(result.requested, 5);
      assert.equal(result.received, 5);
      assert.equal(result.addresses.length, 5);

      // Verify all 5 are unique in DB
      const dbAddrs = repos.addresses.getBatchAddresses(result.batchId, 1001);
      assert.equal(dbAddrs.length, 5);
      const uniqueDbEmails = new Set(dbAddrs.map((a) => a.email.toLowerCase()));
      assert.equal(uniqueDbEmails.size, 5);
    });

    it("should handle partial success after 5 max attempts and save partial records", async () => {
      let attempts = 0;
      const mockApiClient = {
        async generateBulkEmail() {
          attempts++;
          if (attempts === 1) {
            return ["only1@test.com", "only2@test.com"];
          }
          // Subsequent calls fail
          throw new Error("Upstream server rate limit");
        }
      };

      const emailService = createEmailService({
        apiClient: mockApiClient,
        repos,
        batchSize: 5,
        bulkDelayMs: 2
      });

      const result = await emailService.generateEmails({
        userId: 1001,
        count: 5,
        selectedTypes: [1]
      });

      assert.equal(result.status, "partial");
      assert.equal(result.requested, 5);
      assert.equal(result.received, 2);
      assert.equal(result.attempts, 5, "Must attempt up to 5 times");
      assert.ok(result.errors.length > 0);

      // Verify partial records were saved in DB
      const latestBatch = repos.batches.getLatestBatch(1001);
      assert.equal(latestBatch.status, "partial");
      assert.equal(latestBatch.received, 2);
      assert.equal(repos.addresses.hasUserAddress(1001, "only1@test.com"), true);
      assert.equal(repos.addresses.hasUserAddress(1001, "only2@test.com"), true);
    });

    it("should handle complete failure if all 5 attempts fail", async () => {
      const mockApiClient = {
        async generateBulkEmail() {
          throw new Error("Internal Server Error 500");
        }
      };

      const emailService = createEmailService({
        apiClient: mockApiClient,
        repos,
        batchSize: 5,
        bulkDelayMs: 2
      });

      const result = await emailService.generateEmails({
        userId: 1001,
        count: 3,
        selectedTypes: [1]
      });

      assert.equal(result.status, "failed");
      assert.equal(result.received, 0);
      assert.equal(result.attempts, 5);

      const latestBatch = repos.batches.getLatestBatch(1001);
      assert.equal(latestBatch.status, "failed");
      assert.equal(latestBatch.received, 0);
    });
  });
});

