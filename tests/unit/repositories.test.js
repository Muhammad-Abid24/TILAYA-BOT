import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories.js";

describe("SQLite Persistence & Repositories (T04)", () => {
  let db;
  let repos;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
  });

  describe("Migrations", () => {
    it("should record migration version in schema_migrations", () => {
      const row = db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
      assert.ok(row);
      assert.equal(row.version, 1);
    });

    it("should be idempotent and not fail when run twice", () => {
      assert.doesNotThrow(() => {
        runMigrations(db);
      });
    });
  });

  describe("Batches & Addresses", () => {
    it("should create and update batch", () => {
      const batch = repos.batches.createBatch({
        id: "b1",
        userId: 1001,
        requested: 5,
        selectedTypes: [1, 2]
      });

      assert.equal(batch.id, "b1");
      assert.equal(batch.requested, 5);
      assert.equal(batch.status, "in_progress");

      const updated = repos.batches.updateBatch({
        id: "b1",
        userId: 1001,
        received: 5,
        status: "completed"
      });
      assert.equal(updated, true);

      const latest = repos.batches.getLatestBatch(1001);
      assert.equal(latest.id, "b1");
      assert.equal(latest.status, "completed");
      assert.equal(latest.received, 5);
      assert.deepEqual(latest.selectedTypes, [1, 2]);
    });

    it("should enforce uniqueness per batch and email", () => {
      repos.batches.createBatch({
        id: "b1",
        userId: 1001,
        requested: 3,
        selectedTypes: [1]
      });

      const count = repos.addresses.saveBatchAddresses({
        batchId: "b1",
        userId: 1001,
        addresses: [
          { email: "user@domain.com", typeId: 1 },
          { email: "user@domain.com", typeId: 1 }, // duplicate in same batch
          { email: "other@domain.com", typeId: 1 }
        ]
      });

      assert.equal(count, 2, "Duplicate within batch should be ignored");
      const list = repos.addresses.getBatchAddresses("b1", 1001);
      assert.equal(list.length, 2);
    });
  });

  describe("User Data Isolation", () => {
    it("should completely isolate batches and addresses between users", () => {
      // User 1001 creates batch
      repos.batches.createBatch({
        id: "b_u1",
        userId: 1001,
        requested: 2,
        selectedTypes: [1]
      });
      repos.addresses.saveBatchAddresses({
        batchId: "b_u1",
        userId: 1001,
        addresses: [{ email: "user1@domain.com", typeId: 1 }]
      });

      // User 1002 checks
      assert.equal(repos.batches.getLatestBatch(1002), null);
      assert.equal(repos.batches.getBatch("b_u1", 1002), null);
      assert.equal(repos.addresses.getBatchAddresses("b_u1", 1002).length, 0);
      assert.equal(repos.addresses.hasUserAddress(1002, "user1@domain.com"), false);
      assert.equal(repos.addresses.hasUserAddress(1001, "user1@domain.com"), true);
    });

    it("should isolate inbox snapshots and messages between users", () => {
      repos.inboxSnapshots.createSnapshot({
        id: "snap_u1",
        userId: 1001,
        email: "user1@domain.com",
        ttlMs: 60000,
        messages: [
          {
            ordinal: 1,
            messageId: "msg_secret_1",
            sender: "sender@domain.com",
            subject: "Confidential OTP"
          }
        ]
      });

      // User 1001 can access
      const u1Snap = repos.inboxSnapshots.getSnapshot("snap_u1", 1001);
      assert.ok(u1Snap);
      assert.equal(u1Snap.messages.length, 1);
      const u1Msg = repos.inboxSnapshots.getMessageByOrdinal("snap_u1", 1, 1001);
      assert.equal(u1Msg.messageId, "msg_secret_1");

      // User 1002 CANNOT access
      const u2Snap = repos.inboxSnapshots.getSnapshot("snap_u1", 1002);
      assert.equal(u2Snap, null);
      const u2Msg = repos.inboxSnapshots.getMessageByOrdinal("snap_u1", 1, 1002);
      assert.equal(u2Msg, null);
    });
  });

  describe("Transactional /done (clearUserData)", () => {
    it("should wipe all data for the requesting user while preserving other users data", () => {
      // Setup data for User 1001
      repos.batches.createBatch({ id: "b1", userId: 1001, requested: 1, selectedTypes: [1] });
      repos.addresses.saveBatchAddresses({
        batchId: "b1",
        userId: 1001,
        addresses: [{ email: "u1@test.com", typeId: 1 }]
      });
      repos.inboxSnapshots.createSnapshot({
        id: "s1",
        userId: 1001,
        email: "u1@test.com",
        messages: [{ ordinal: 1, messageId: "m1", sender: "a", subject: "b" }]
      });
      repos.wizardSessions.saveSession({
        id: "w1",
        userId: 1001,
        chatId: 1001,
        state: "SELECT_TYPES",
        payload: { count: 1 },
        expiresAt: Date.now() + 60000
      });

      // Setup data for User 1002
      repos.batches.createBatch({ id: "b2", userId: 1002, requested: 1, selectedTypes: [2] });
      repos.addresses.saveBatchAddresses({
        batchId: "b2",
        userId: 1002,
        addresses: [{ email: "u2@test.com", typeId: 2 }]
      });

      // Clear User 1001 data
      const res = repos.userCleaner.clearUserData(1001);
      assert.equal(res.success, true);

      // Verify User 1001 data is gone
      assert.equal(repos.batches.getLatestBatch(1001), null);
      assert.equal(repos.addresses.getBatchAddresses("b1", 1001).length, 0);
      assert.equal(repos.addresses.hasUserAddress(1001, "u1@test.com"), false);
      assert.equal(repos.inboxSnapshots.getSnapshot("s1", 1001), null);
      assert.equal(repos.wizardSessions.getSession("w1"), null);

      // Verify User 1002 data is completely intact
      const u2Batch = repos.batches.getLatestBatch(1002);
      assert.ok(u2Batch);
      assert.equal(u2Batch.id, "b2");
      assert.equal(repos.addresses.hasUserAddress(1002, "u2@test.com"), true);
    });
  });

  describe("Disk Persistence & Restart", () => {
    it("should retain history across database connection restarts", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tilaya-db-test-"));
      const dbPath = path.join(tempDir, "test.db");

      try {
        // Open connection 1
        const db1 = createDatabase(dbPath);
        runMigrations(db1);
        const repos1 = createRepositories(db1);

        repos1.batches.createBatch({
          id: "restart_batch",
          userId: 555,
          requested: 2,
          selectedTypes: [1, 8]
        });
        repos1.batches.updateBatch({
          id: "restart_batch",
          userId: 555,
          received: 2,
          status: "completed"
        });
        repos1.addresses.saveBatchAddresses({
          batchId: "restart_batch",
          userId: 555,
          addresses: [
            { email: "persist1@test.com", typeId: 1 },
            { email: "persist2@test.com", typeId: 8 }
          ]
        });

        db1.close();

        // Open connection 2 (simulating bot restart)
        const db2 = createDatabase(dbPath);
        runMigrations(db2);
        const repos2 = createRepositories(db2);

        const latest = repos2.batches.getLatestBatch(555);
        assert.ok(latest);
        assert.equal(latest.id, "restart_batch");
        assert.equal(latest.status, "completed");

        const addrs = repos2.addresses.getBatchAddresses("restart_batch", 555);
        assert.equal(addrs.length, 2);
        assert.equal(addrs[0].email, "persist1@test.com");
        assert.equal(addrs[1].email, "persist2@test.com");

        db2.close();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Wizard Sessions", () => {
    it("should save, get, and delete sessions", () => {
      repos.wizardSessions.saveSession({
        id: "sess_xyz",
        userId: 1001,
        chatId: 1001,
        state: "SELECT_TYPES",
        payload: { selectedTypes: [1, 2] },
        expiresAt: Date.now() + 60000
      });

      const sess = repos.wizardSessions.getSession("sess_xyz");
      assert.ok(sess);
      assert.equal(sess.state, "SELECT_TYPES");
      assert.deepEqual(sess.payload.selectedTypes, [1, 2]);

      repos.wizardSessions.deleteSession("sess_xyz");
      assert.equal(repos.wizardSessions.getSession("sess_xyz"), null);
    });

    it("should clean expired wizard sessions and snapshots", () => {
      repos.wizardSessions.saveSession({
        id: "expired_sess",
        userId: 1001,
        chatId: 1001,
        state: "SELECT_TYPES",
        payload: {},
        expiresAt: Date.now() - 1000 // Expired
      });

      const cleaned = repos.wizardSessions.cleanExpiredSessions();
      assert.equal(cleaned, 1);
      assert.equal(repos.wizardSessions.getSession("expired_sess"), null);
    });
  });
});

