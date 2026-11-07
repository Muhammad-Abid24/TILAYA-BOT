import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Initializes and configures an SQLite database connection.
 * Sets WAL mode, foreign keys, and secure file permissions (0600).
 *
 * @param {string} dbPath - File path or ':memory:'
 * @param {object} [options]
 * @returns {Database.Database}
 */
export function createDatabase(dbPath, options = {}) {
  const isMemory = dbPath === ":memory:";

  if (!isMemory) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  const db = new Database(dbPath, options);

  // Secure file permission 0600 on created db file
  if (!isMemory && fs.existsSync(dbPath)) {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // Ignore if chmod is not supported by environment
    }
  }

  // Pragmas for performance and data integrity
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  return db;
}

