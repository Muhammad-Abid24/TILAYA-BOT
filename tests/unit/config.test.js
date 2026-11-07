import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.js";
import { ConfigError } from "../../src/utils/errors.js";

const VALID_ENV = {
  BOT_TOKEN: "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_123",
  ALLOWED_TELEGRAM_IDS: "123456789, 987654321",
  TEMPMAIL_BASE_URL: "https://api.tempmail.example.com/",
  SQLITE_PATH: "./data/test.db",
  API_BATCH_SIZE: "25",
  BULK_DELAY_MS: "500",
  POLL_TIMEOUT_MS: "60000",
  POLL_INTERVAL_MS: "3000"
};

describe("Configuration Loader & Validator (T01)", () => {
  it("should load valid configuration successfully with normalized fields", () => {
    const config = loadConfig(VALID_ENV);

    assert.equal(config.BOT_TOKEN, VALID_ENV.BOT_TOKEN);
    assert.ok(config.ALLOWED_TELEGRAM_IDS.has(123456789));
    assert.ok(config.ALLOWED_TELEGRAM_IDS.has(987654321));
    assert.equal(config.ALLOWED_TELEGRAM_IDS.size, 2);
    // Trailing slash removed
    assert.equal(config.TEMPMAIL_BASE_URL, "https://api.tempmail.example.com");
    assert.equal(config.SQLITE_PATH, "./data/test.db");
    assert.equal(config.API_BATCH_SIZE, 25);
    assert.equal(config.BULK_DELAY_MS, 500);
    assert.equal(config.POLL_TIMEOUT_MS, 60000);
    assert.equal(config.POLL_INTERVAL_MS, 3000);
  });

  it("should apply defaults for optional numeric configs", () => {
    const minimalEnv = {
      BOT_TOKEN: "123456789:ValidTokenString",
      ALLOWED_TELEGRAM_IDS: "12345",
      TEMPMAIL_BASE_URL: "https://api.tempmail.example.com"
    };
    const config = loadConfig(minimalEnv);

    assert.equal(config.SQLITE_PATH, "./data/tilaya.db");
    assert.equal(config.API_BATCH_SIZE, 50);
    assert.equal(config.BULK_DELAY_MS, 1000);
    assert.equal(config.POLL_TIMEOUT_MS, 75000);
    assert.equal(config.POLL_INTERVAL_MS, 5000);
  });

  it("should allow http://localhost or http://127.0.0.1 for local dev/testing", () => {
    const localEnv = {
      ...VALID_ENV,
      TEMPMAIL_BASE_URL: "http://localhost:8080/api/"
    };
    const config = loadConfig(localEnv);
    assert.equal(config.TEMPMAIL_BASE_URL, "http://localhost:8080/api");

    const ipEnv = {
      ...VALID_ENV,
      TEMPMAIL_BASE_URL: "http://127.0.0.1:3000"
    };
    const configIp = loadConfig(ipEnv);
    assert.equal(configIp.TEMPMAIL_BASE_URL, "http://127.0.0.1:3000");
  });

  it("should throw ConfigError and NEVER leak secret token in error message", () => {
    const secretToken = "SECRET_TOKEN_DO_NOT_LEAK";
    const invalidEnv = {
      ...VALID_ENV,
      BOT_TOKEN: secretToken // Missing colon numeric prefix
    };

    assert.throws(
      () => loadConfig(invalidEnv),
      (err) => {
        assert.ok(err instanceof ConfigError);
        // Ensure the secret token value is NOT included in the error message
        assert.ok(!err.message.includes(secretToken), "Error message leaked BOT_TOKEN");
        assert.ok(err.message.includes("BOT_TOKEN is invalid"));
        return true;
      }
    );
  });

  it("should fail when BOT_TOKEN is missing", () => {
    const invalidEnv = { ...VALID_ENV, BOT_TOKEN: "" };
    assert.throws(
      () => loadConfig(invalidEnv),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("BOT_TOKEN is required"));
        return true;
      }
    );
  });

  it("should fail when ALLOWED_TELEGRAM_IDS is missing or contains non-numeric values", () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, ALLOWED_TELEGRAM_IDS: "" }),
      (err) => err instanceof ConfigError && err.message.includes("ALLOWED_TELEGRAM_IDS is required")
    );

    assert.throws(
      () => loadConfig({ ...VALID_ENV, ALLOWED_TELEGRAM_IDS: "123,abc,456" }),
      (err) => err instanceof ConfigError && err.message.includes("non-numeric ID: 'abc'")
    );
  });

  it("should fail when TEMPMAIL_BASE_URL is invalid or uses insecure http for remote host", () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, TEMPMAIL_BASE_URL: "http://insecure-remote.com" }),
      (err) =>
        err instanceof ConfigError &&
        err.message.includes("must use https://")
    );

    assert.throws(
      () => loadConfig({ ...VALID_ENV, TEMPMAIL_BASE_URL: "not-a-valid-url" }),
      (err) => err instanceof ConfigError && err.message.includes("not a valid URL")
    );
  });

  it("should fail when numeric boundaries are violated", () => {
    // API_BATCH_SIZE < 1 or > 50
    assert.throws(
      () => loadConfig({ ...VALID_ENV, API_BATCH_SIZE: "0" }),
      (err) => err instanceof ConfigError && err.message.includes("API_BATCH_SIZE")
    );
    assert.throws(
      () => loadConfig({ ...VALID_ENV, API_BATCH_SIZE: "51" }),
      (err) => err instanceof ConfigError && err.message.includes("API_BATCH_SIZE")
    );

    // BULK_DELAY_MS < 0
    assert.throws(
      () => loadConfig({ ...VALID_ENV, BULK_DELAY_MS: "-1" }),
      (err) => err instanceof ConfigError && err.message.includes("BULK_DELAY_MS")
    );

    // POLL_TIMEOUT_MS <= 0
    assert.throws(
      () => loadConfig({ ...VALID_ENV, POLL_TIMEOUT_MS: "0" }),
      (err) => err instanceof ConfigError && err.message.includes("POLL_TIMEOUT_MS")
    );

    // POLL_INTERVAL_MS <= 0
    assert.throws(
      () => loadConfig({ ...VALID_ENV, POLL_INTERVAL_MS: "0" }),
      (err) => err instanceof ConfigError && err.message.includes("POLL_INTERVAL_MS")
    );
  });
});

