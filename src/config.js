import dotenv from "dotenv";
import { ConfigError } from "./utils/errors.js";

// Load .env file if present
dotenv.config();

/**
 * Validates and normalizes environment configuration.
 * Never leaks sensitive values (e.g. BOT_TOKEN) in thrown errors.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, any>}
 */
export function loadConfig(env = process.env) {
  const errors = [];

  // BOT_TOKEN validation
  const botToken = env.BOT_TOKEN?.trim();
  if (!botToken) {
    errors.push("BOT_TOKEN is required");
  } else if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    // Redacted error message: never interpolate botToken
    errors.push("BOT_TOKEN is invalid (expected format: <number>:<string>)");
  }

  // ALLOWED_TELEGRAM_IDS validation
  const rawAllowedIds = env.ALLOWED_TELEGRAM_IDS?.trim();
  const allowedIds = new Set();
  if (!rawAllowedIds) {
    errors.push("ALLOWED_TELEGRAM_IDS is required");
  } else {
    const parts = rawAllowedIds.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) {
      errors.push("ALLOWED_TELEGRAM_IDS cannot be empty");
    } else {
      for (const idStr of parts) {
        if (!/^\d+$/.test(idStr)) {
          errors.push(`ALLOWED_TELEGRAM_IDS contains non-numeric ID: '${idStr}'`);
        } else {
          allowedIds.add(Number(idStr));
        }
      }
    }
  }

  // TEMPMAIL_BASE_URL validation
  let normalizedBaseUrl = "";
  const rawBaseUrl = env.TEMPMAIL_BASE_URL?.trim();
  if (!rawBaseUrl) {
    errors.push("TEMPMAIL_BASE_URL is required");
  } else {
    try {
      const parsedUrl = new URL(rawBaseUrl);
      const isHttps = parsedUrl.protocol === "https:";
      const isLocalhost =
        parsedUrl.protocol === "http:" &&
        (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");

      if (!isHttps && !isLocalhost) {
        errors.push("TEMPMAIL_BASE_URL must use https:// (or http:// for localhost/127.0.0.1)");
      } else {
        // Strip trailing slash
        normalizedBaseUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, "");
      }
    } catch {
      errors.push("TEMPMAIL_BASE_URL is not a valid URL");
    }
  }

  // SQLITE_PATH validation
  const sqlitePath = env.SQLITE_PATH?.trim() || "./data/tilaya.db";

  // API_BATCH_SIZE (1 to 50)
  const rawBatchSize = env.API_BATCH_SIZE !== undefined && env.API_BATCH_SIZE !== ""
    ? Number(env.API_BATCH_SIZE)
    : 50;
  if (!Number.isInteger(rawBatchSize) || rawBatchSize < 1 || rawBatchSize > 50) {
    errors.push("API_BATCH_SIZE must be an integer between 1 and 50");
  }

  // BULK_DELAY_MS (>= 0)
  const rawBulkDelay = env.BULK_DELAY_MS !== undefined && env.BULK_DELAY_MS !== ""
    ? Number(env.BULK_DELAY_MS)
    : 1000;
  if (!Number.isInteger(rawBulkDelay) || rawBulkDelay < 0) {
    errors.push("BULK_DELAY_MS must be an integer >= 0");
  }

  // POLL_TIMEOUT_MS (> 0)
  const rawPollTimeout = env.POLL_TIMEOUT_MS !== undefined && env.POLL_TIMEOUT_MS !== ""
    ? Number(env.POLL_TIMEOUT_MS)
    : 75000;
  if (!Number.isInteger(rawPollTimeout) || rawPollTimeout <= 0) {
    errors.push("POLL_TIMEOUT_MS must be an integer > 0");
  }

  // POLL_INTERVAL_MS (> 0)
  const rawPollInterval = env.POLL_INTERVAL_MS !== undefined && env.POLL_INTERVAL_MS !== ""
    ? Number(env.POLL_INTERVAL_MS)
    : 5000;
  if (!Number.isInteger(rawPollInterval) || rawPollInterval <= 0) {
    errors.push("POLL_INTERVAL_MS must be an integer > 0");
  }

  if (errors.length > 0) {
    throw new ConfigError(`Configuration validation failed:\n- ${errors.join("\n- ")}`);
  }

  return Object.freeze({
    BOT_TOKEN: botToken,
    ALLOWED_TELEGRAM_IDS: allowedIds,
    TEMPMAIL_BASE_URL: normalizedBaseUrl,
    SQLITE_PATH: sqlitePath,
    API_BATCH_SIZE: rawBatchSize,
    BULK_DELAY_MS: rawBulkDelay,
    POLL_TIMEOUT_MS: rawPollTimeout,
    POLL_INTERVAL_MS: rawPollInterval
  });
}

