import { loadConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { runMigrations } from "./db/migrations.js";
import { createRepositories } from "./db/repositories.js";
import { createOperationRegistry } from "./services/operationRegistry.js";
import { createTempMailClient } from "./api/tempmailClient.js";
import { createEmailService } from "./services/emailService.js";
import { createExportService } from "./services/exportService.js";
import { createInboxService } from "./services/inboxService.js";
import { createExtendService } from "./services/extendService.js";
import { createBot } from "./bot/createBot.js";

/**
 * Main application bootstrap function.
 */
export async function bootstrap() {
  // 1. Load and strictly validate environment configuration
  const config = loadConfig();

  // 2. Initialize SQLite database & apply migrations
  const db = createDatabase(config.SQLITE_PATH);
  runMigrations(db);

  // 3. Initialize repositories & operation registry
  const repos = createRepositories(db);
  const operationRegistry = createOperationRegistry();

  // 4. Initialize TempMail API client & business services
  const apiClient = createTempMailClient({
    baseUrl: config.TEMPMAIL_BASE_URL,
    bulkDelayMs: config.BULK_DELAY_MS
  });

  const emailService = createEmailService({
    apiClient,
    repos,
    batchSize: config.API_BATCH_SIZE,
    bulkDelayMs: config.BULK_DELAY_MS
  });

  const exportService = createExportService({ repos });
  const inboxService = createInboxService({ apiClient, repos });
  const extendService = createExtendService({ apiClient, repos });

  // 5. Create bot instance with middleware and handlers
  const bot = createBot({
    botToken: config.BOT_TOKEN,
    allowedIds: config.ALLOWED_TELEGRAM_IDS,
    services: {
      repos,
      operationRegistry,
      apiClient,
      emailService,
      exportService,
      inboxService,
      extendService
    }
  });

  // 6. Graceful shutdown handler
  let isShuttingDown = false;
  const gracefulShutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[TILAYA] Received ${signal}. Initiating graceful shutdown...`);

    try {
      bot.stop(signal);
    } catch {
      // Ignore if bot was not yet started
    }

    try {
      db.close();
      console.log("[TILAYA] Database connection closed cleanly.");
    } catch (err) {
      console.error(`[TILAYA] Error closing database: ${err.message}`);
    }

    console.log("[TILAYA] Shutdown complete.");
    process.exit(0);
  };

  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // 7. Start Telegram long polling (strictly single-instance)
  console.log(`[TILAYA] Starting bot in long polling mode...`);
  console.log(`[TILAYA] Authorized users: ${config.ALLOWED_TELEGRAM_IDS.size} ID(s)`);
  console.log(`[TILAYA] Upstream base URL: ${config.TEMPMAIL_BASE_URL}`);

  await bot.launch({
    dropPendingUpdates: true
  });
  console.log("[TILAYA] Bot is running and listening for Telegram updates.");

  return { bot, db };
}

// Run if directly executed
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  bootstrap().catch((err) => {
    console.error(`[TILAYA] Fatal startup failure: ${err.message}`);
    process.exit(1);
  });
}
