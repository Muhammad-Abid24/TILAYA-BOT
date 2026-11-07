/**
 * Generates safe timestamp string: YYYYMMDD-HHMMSS
 *
 * @param {Date | number} [dateInput]
 * @returns {string}
 */
export function formatExportFilename(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const pad = (n) => String(n).padStart(2, "0");

  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());

  return `tempmail-${year}${month}${day}-${hours}${minutes}${seconds}.txt`;
}

/**
 * Service to export user's latest generated email batch.
 */
export function createExportService({ repos }) {
  return {
    /**
     * Retrieves and formats the latest batch of emails for a user as UTF-8 .txt buffer.
     * Does NOT generate new emails or contact upstream API.
     *
     * @param {number} userId
     * @returns {{
     *   success: boolean,
     *   reason?: string,
     *   filename?: string,
     *   content?: Buffer,
     *   count?: number,
     *   batchId?: string
     * }}
     */
    exportLatestBatch(userId) {
      const latestBatch = repos.batches.getLatestBatch(userId);
      if (!latestBatch || latestBatch.received === 0) {
        return {
          success: false,
          reason: "NO_BATCH"
        };
      }

      const addresses = repos.addresses.getBatchAddresses(latestBatch.id, userId);
      if (!addresses || addresses.length === 0) {
        return {
          success: false,
          reason: "NO_ADDRESSES"
        };
      }

      const emails = addresses.map((a) => a.email);
      // One email per line, UTF-8
      const textContent = emails.join("\n") + "\n";
      const buffer = Buffer.from(textContent, "utf-8");
      const filename = formatExportFilename(latestBatch.createdAt);

      return {
        success: true,
        filename,
        content: buffer,
        count: emails.length,
        batchId: latestBatch.id
      };
    }
  };
}
