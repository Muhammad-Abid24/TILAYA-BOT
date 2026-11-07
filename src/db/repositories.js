/**
 * Repositories for data persistence and user isolation in SQLite.
 */

export function createRepositories(db) {
  return {
    batches: {
      /**
       * Creates a new generated batch record.
       */
      createBatch({ id, userId, requested, selectedTypes, createdAt = Date.now() }) {
        const stmt = db.prepare(`
          INSERT INTO generated_batches (
            id, user_id, created_at, requested, received, selected_types_json, status, errors_json
          ) VALUES (?, ?, ?, ?, 0, ?, 'in_progress', NULL)
        `);
        stmt.run(id, userId, createdAt, requested, JSON.stringify(selectedTypes));
        return {
          id,
          userId,
          createdAt,
          requested,
          received: 0,
          selectedTypes,
          status: "in_progress",
          errors: null
        };
      },

      /**
       * Updates batch result upon completion or partial error.
       */
      updateBatch({ id, userId, received, status, errors = null }) {
        const stmt = db.prepare(`
          UPDATE generated_batches 
          SET received = ?, status = ?, errors_json = ?
          WHERE id = ? AND user_id = ?
        `);
        const result = stmt.run(
          received,
          status,
          errors ? JSON.stringify(errors) : null,
          id,
          userId
        );
        return result.changes > 0;
      },

      /**
       * Gets the latest batch for a user.
       */
      getLatestBatch(userId) {
        const row = db
          .prepare(
            `
            SELECT id, user_id, created_at, requested, received, selected_types_json, status, errors_json
            FROM generated_batches
            WHERE user_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
          `
          )
          .get(userId);

        if (!row) return null;

        return {
          id: row.id,
          userId: row.user_id,
          createdAt: row.created_at,
          requested: row.requested,
          received: row.received,
          selectedTypes: JSON.parse(row.selected_types_json),
          status: row.status,
          errors: row.errors_json ? JSON.parse(row.errors_json) : null
        };
      },

      /**
       * Gets a batch by ID and userId.
       */
      getBatch(id, userId) {
        const row = db
          .prepare(
            `
            SELECT id, user_id, created_at, requested, received, selected_types_json, status, errors_json
            FROM generated_batches
            WHERE id = ? AND user_id = ?
          `
          )
          .get(id, userId);

        if (!row) return null;

        return {
          id: row.id,
          userId: row.user_id,
          createdAt: row.created_at,
          requested: row.requested,
          received: row.received,
          selectedTypes: JSON.parse(row.selected_types_json),
          status: row.status,
          errors: row.errors_json ? JSON.parse(row.errors_json) : null
        };
      }
    },

    addresses: {
      /**
       * Saves multiple generated addresses in a single transaction.
       */
      saveBatchAddresses({ batchId, userId, addresses }) {
        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO generated_addresses (
            id, batch_id, user_id, email, type_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);

        const tx = db.transaction((items) => {
          const now = Date.now();
          let count = 0;
          for (const item of items) {
            const addrId = item.id || `${batchId}_${count}_${Date.now()}`;
            const res = insertStmt.run(
              addrId,
              batchId,
              userId,
              item.email.toLowerCase(),
              item.typeId || null,
              now
            );
            if (res.changes > 0) count++;
          }
          return count;
        });

        return tx(addresses);
      },

      /**
       * Gets addresses for a specific batch, scoped to userId.
       */
      getBatchAddresses(batchId, userId) {
        const rows = db
          .prepare(
            `
            SELECT id, batch_id, user_id, email, type_id, created_at
            FROM generated_addresses
            WHERE batch_id = ? AND user_id = ?
            ORDER BY created_at ASC
          `
          )
          .all(batchId, userId);

        return rows.map((r) => ({
          id: r.id,
          batchId: r.batch_id,
          userId: r.user_id,
          email: r.email,
          typeId: r.type_id,
          createdAt: r.created_at
        }));
      },

      /**
       * Checks if an email is owned by the user.
       */
      hasUserAddress(userId, email) {
        const row = db
          .prepare(
            `
            SELECT 1 FROM generated_addresses
            WHERE user_id = ? AND email = ?
            LIMIT 1
          `
          )
          .get(userId, email.toLowerCase());

        return Boolean(row);
      },

      /**
       * Gets recent unique addresses generated by the user.
       */
      getRecentUserAddresses(userId, limit = 10) {
        const rows = db
          .prepare(
            `
            SELECT DISTINCT email, created_at
            FROM generated_addresses
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          `
          )
          .all(userId, limit);

        return rows.map((r) => r.email);
      }
    },

    inboxSnapshots: {
      /**
       * Saves an inbox snapshot with message list in a single transaction.
       */
      createSnapshot({ id, userId, email, ttlMs = 600000, messages = [] }) {
        const now = Date.now();
        const expiresAt = now + ttlMs;

        const insertSnapshot = db.prepare(`
          INSERT INTO inbox_snapshots (id, user_id, email, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `);

        const insertMsg = db.prepare(`
          INSERT INTO inbox_snapshot_messages (
            snapshot_id, ordinal, message_id, sender, subject, received_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);

        const tx = db.transaction(() => {
          insertSnapshot.run(id, userId, email.toLowerCase(), now, expiresAt);
          for (const m of messages) {
            insertMsg.run(
              id,
              m.ordinal,
              String(m.messageId),
              m.sender,
              m.subject,
              m.receivedAt || null
            );
          }
        });

        tx();
        return { id, userId, email, createdAt: now, expiresAt, count: messages.length };
      },

      /**
       * Retrieves a snapshot and its message list.
       */
      getSnapshot(id, userId) {
        const snap = db
          .prepare(
            `
            SELECT id, user_id, email, created_at, expires_at
            FROM inbox_snapshots
            WHERE id = ? AND user_id = ?
          `
          )
          .get(id, userId);

        if (!snap) return null;

        const messages = db
          .prepare(
            `
            SELECT ordinal, message_id, sender, subject, received_at
            FROM inbox_snapshot_messages
            WHERE snapshot_id = ?
            ORDER BY ordinal ASC
          `
          )
          .all(id);

        return {
          id: snap.id,
          userId: snap.user_id,
          email: snap.email,
          createdAt: snap.created_at,
          expiresAt: snap.expires_at,
          messages: messages.map((m) => ({
            ordinal: m.ordinal,
            messageId: m.message_id,
            sender: m.sender,
            subject: m.subject,
            receivedAt: m.received_at
          }))
        };
      },

      /**
       * Looks up the real upstream message ID by ordinal number for a snapshot.
       */
      getMessageByOrdinal(snapshotId, ordinal, userId) {
        const row = db
          .prepare(
            `
            SELECT m.message_id, m.sender, m.subject, s.email
            FROM inbox_snapshot_messages m
            JOIN inbox_snapshots s ON s.id = m.snapshot_id
            WHERE m.snapshot_id = ? AND m.ordinal = ? AND s.user_id = ?
          `
          )
          .get(snapshotId, ordinal, userId);

        if (!row) return null;

        return {
          messageId: row.message_id,
          sender: row.sender,
          subject: row.subject,
          email: row.email
        };
      },

      /**
       * Cleans up expired snapshots.
       */
      cleanExpiredSnapshots() {
        const res = db
          .prepare("DELETE FROM inbox_snapshots WHERE expires_at <= ?")
          .run(Date.now());
        return res.changes;
      }
    },

    wizardSessions: {
      /**
       * Saves or updates a wizard session.
       */
      saveSession({ id, userId, chatId, state, payload, expiresAt }) {
        const stmt = db.prepare(`
          INSERT INTO wizard_sessions (id, user_id, chat_id, state, payload_json, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            state = excluded.state,
            payload_json = excluded.payload_json,
            expires_at = excluded.expires_at
        `);
        stmt.run(id, userId, chatId, state, JSON.stringify(payload), expiresAt);
        return { id, userId, chatId, state, payload, expiresAt };
      },

      /**
       * Gets a wizard session by ID.
       */
      getSession(id) {
        const row = db
          .prepare(
            `
            SELECT id, user_id, chat_id, state, payload_json, expires_at
            FROM wizard_sessions
            WHERE id = ?
          `
          )
          .get(id);

        if (!row) return null;

        return {
          id: row.id,
          userId: row.user_id,
          chatId: row.chat_id,
          state: row.state,
          payload: JSON.parse(row.payload_json),
          expiresAt: row.expires_at
        };
      },

      /**
       * Deletes a wizard session by ID.
       */
      deleteSession(id) {
        const res = db.prepare("DELETE FROM wizard_sessions WHERE id = ?").run(id);
        return res.changes > 0;
      },

      /**
       * Cleans up expired sessions.
       */
      cleanExpiredSessions() {
        const res = db
          .prepare("DELETE FROM wizard_sessions WHERE expires_at <= ?")
          .run(Date.now());
        return res.changes;
      }
    },

    userCleaner: {
      /**
       * Clears ALL data for a user in a single atomic transaction.
       * (batches, addresses, snapshots, messages, wizard sessions)
       */
      clearUserData(userId) {
        const tx = db.transaction(() => {
          // Delete messages linked to snapshots of this user
          db.prepare(
            `
            DELETE FROM inbox_snapshot_messages 
            WHERE snapshot_id IN (SELECT id FROM inbox_snapshots WHERE user_id = ?)
          `
          ).run(userId);

          // Delete inbox snapshots
          db.prepare("DELETE FROM inbox_snapshots WHERE user_id = ?").run(userId);

          // Delete addresses
          db.prepare("DELETE FROM generated_addresses WHERE user_id = ?").run(userId);

          // Delete batches
          db.prepare("DELETE FROM generated_batches WHERE user_id = ?").run(userId);

          // Delete wizard sessions
          db.prepare("DELETE FROM wizard_sessions WHERE user_id = ?").run(userId);

          return { success: true, userId };
        });

        return tx();
      }
    }
  };
}

