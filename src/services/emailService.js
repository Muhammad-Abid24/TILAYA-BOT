import { validateCount, validateTypeIds } from "../utils/validation.js";
import { abortableDelay } from "../utils/abortableDelay.js";
import { OperationCancelledError } from "../utils/errors.js";

/**
 * Service orchestrating email generation with deduplication, retries, and persistence.
 */
export function createEmailService({
  apiClient,
  repos,
  batchSize = 50,
  bulkDelayMs = 1000
}) {
  return {
    /**
     * Executes generation of N emails across selected types with deduplication and up to 5 attempts.
     *
     * @param {object} params
     * @param {number} params.userId
     * @param {number} params.count
     * @param {number[]} params.selectedTypes
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{
     *   batchId: string,
     *   requested: number,
     *   received: number,
     *   addresses: Array<{ id: string, email: string, typeId?: number }>,
     *   status: 'completed' | 'partial' | 'failed',
     *   attempts: number,
     *   errors: string[]
     * }>}
     */
    async generateEmails({ userId, count, selectedTypes, signal }) {
      const validatedCount = validateCount(count);
      const validatedTypes = validateTypeIds(selectedTypes);

      const batchId = `b_${Date.now()}_${userId}`;
      const clampedBatchSize = Math.max(1, Math.min(50, Number(batchSize) || 50));

      // 1. Initialize batch record in DB
      repos.batches.createBatch({
        id: batchId,
        userId,
        requested: validatedCount,
        selectedTypes: validatedTypes
      });

      /** @type {Map<string, { id: string, email: string, typeId?: number }>} */
      const uniqueEmailsMap = new Map();
      const errors = [];
      let attempts = 0;
      const MAX_ATTEMPTS = 5;

      while (uniqueEmailsMap.size < validatedCount && attempts < MAX_ATTEMPTS) {
        if (signal?.aborted) {
          throw new OperationCancelledError("Email generation cancelled");
        }

        attempts++;
        const remaining = validatedCount - uniqueEmailsMap.size;
        const countToFetch = Math.min(remaining, clampedBatchSize);

        try {
          if (countToFetch === 1 && validatedTypes.length === 1) {
            // Single email generation
            const res = await apiClient.generateEmail({
              ids: validatedTypes,
              signal
            });
            const key = res.email.toLowerCase();
            if (!uniqueEmailsMap.has(key)) {
              uniqueEmailsMap.set(key, {
                id: `${batchId}_${uniqueEmailsMap.size + 1}`,
                email: res.email,
                typeId: res.type || validatedTypes[0]
              });
            }
          } else {
            // Bulk email generation
            const emails = await apiClient.generateBulkEmail({
              ids: validatedTypes,
              count: countToFetch,
              signal
            });

            for (const emailStr of emails) {
              const key = emailStr.toLowerCase();
              if (!uniqueEmailsMap.has(key)) {
                uniqueEmailsMap.set(key, {
                  id: `${batchId}_${uniqueEmailsMap.size + 1}`,
                  email: emailStr,
                  typeId: validatedTypes[0]
                });
              }
              if (uniqueEmailsMap.size >= validatedCount) break;
            }
          }
        } catch (err) {
          if (signal?.aborted) {
            throw new OperationCancelledError("Email generation cancelled");
          }
          errors.push(`Attempt ${attempts}: ${err.message}`);
        }

        // Delay between attempts if we still need more and attempts remain
        if (uniqueEmailsMap.size < validatedCount && attempts < MAX_ATTEMPTS) {
          try {
            await abortableDelay(bulkDelayMs, signal);
          } catch {
            if (signal?.aborted) {
              throw new OperationCancelledError("Email generation cancelled");
            }
          }
        }
      }

      const received = uniqueEmailsMap.size;
      const addresses = Array.from(uniqueEmailsMap.values());

      let status = "failed";
      if (received === validatedCount) {
        status = "completed";
      } else if (received > 0) {
        status = "partial";
      }

      // 2. Save all generated addresses into DB
      if (addresses.length > 0) {
        repos.addresses.saveBatchAddresses({
          batchId,
          userId,
          addresses
        });
      }

      // 3. Update final batch status in DB
      repos.batches.updateBatch({
        id: batchId,
        userId,
        received,
        status,
        errors: errors.length > 0 ? errors : null
      });

      return {
        batchId,
        requested: validatedCount,
        received,
        addresses,
        status,
        attempts,
        errors
      };
    }
  };
}
