import { loadConfig } from "./config.js";

function main() {
  try {
    const config = loadConfig();
    console.log(`[TILAYA] Configuration valid. Database path: ${config.SQLITE_PATH}`);
  } catch (error) {
    console.error(`[TILAYA] Fatal startup error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main();
}

