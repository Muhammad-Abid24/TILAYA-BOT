import { sendHttpRequest } from "./httpClient.js";
import {
  normalizeGenerateEmail,
  normalizeGenerateBulkEmail,
  normalizeMessageList,
  normalizeMessageDetail,
  normalizeExtendEmail
} from "./normalizers.js";
import { validateEmail, validateTypeIds, validateCount } from "../utils/validation.js";

/**
 * TempMail Upstream API Client factory.
 *
 * @param {object} options
 * @param {string} options.baseUrl - Normalized base URL without trailing slash.
 * @param {typeof fetch} [options.fetchFn] - Injectable fetch implementation.
 * @param {number} [options.defaultTimeoutMs=30000] - Default timeout for normal requests.
 * @param {number} [options.bulkDelayMs=1000] - Delay between retries/batches.
 * @param {number} [options.maxRetries=2] - Max retries for transient HTTP errors.
 */
export function createTempMailClient(options) {
  const {
    baseUrl,
    fetchFn = globalThis.fetch,
    defaultTimeoutMs = 30000,
    bulkDelayMs = 1000,
    maxRetries = 2
  } = options;

  if (!baseUrl) {
    throw new Error("baseUrl is required for TempMailClient");
  }

  const cleanBaseUrl = baseUrl.replace(/\/+$/, "");

  return {
    /**
     * Generates a single email with given type IDs.
     * POST /api/generate-email { ids: number[] }
     *
     * @param {object} params
     * @param {number[]} params.ids
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ email: string, type?: number }>}
     */
    async generateEmail({ ids, signal }) {
      const validatedIds = validateTypeIds(ids);
      const data = await sendHttpRequest(`${cleanBaseUrl}/api/generate-email`, {
        method: "POST",
        body: { ids: validatedIds },
        timeoutMs: defaultTimeoutMs,
        signal,
        maxRetries,
        retryDelayMs: bulkDelayMs,
        fetchFn
      });
      return normalizeGenerateEmail(data);
    },

    /**
     * Generates bulk emails with given type IDs and count.
     * POST /api/generate-bulk-email { ids: number[], count: number }
     *
     * @param {object} params
     * @param {number[]} params.ids
     * @param {number} params.count
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<string[]>} Array of unique email strings
     */
    async generateBulkEmail({ ids, count, signal }) {
      const validatedIds = validateTypeIds(ids);
      const validatedCount = validateCount(count);
      const data = await sendHttpRequest(`${cleanBaseUrl}/api/generate-bulk-email`, {
        method: "POST",
        body: { ids: validatedIds, count: validatedCount },
        timeoutMs: 60000, // Bulk operations allowed up to 60s per ARCHITECTURE
        signal,
        maxRetries,
        retryDelayMs: bulkDelayMs,
        fetchFn
      });
      return normalizeGenerateBulkEmail(data);
    },

    /**
     * Retrieves messages for an email address.
     * POST /api/message-list { email: string, limit: number }
     *
     * @param {object} params
     * @param {string} params.email
     * @param {number} [params.limit=20]
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<Array<{ id: string, sender: string, subject: string, date: string }>>}
     */
    async getMessageList({ email, limit = 20, signal }) {
      const validatedEmail = validateEmail(email);
      const data = await sendHttpRequest(`${cleanBaseUrl}/api/message-list`, {
        method: "POST",
        body: { email: validatedEmail, limit: Number(limit) || 20 },
        timeoutMs: defaultTimeoutMs,
        signal,
        maxRetries,
        retryDelayMs: bulkDelayMs,
        fetchFn
      });
      return normalizeMessageList(data);
    },

    /**
     * Retrieves detail of a single message by ID.
     * GET /api/message/{id}
     *
     * @param {object} params
     * @param {string} params.id
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ id: string, sender: string, subject: string, date: string, bodyText: string }>}
     */
    async getMessage({ id, signal }) {
      if (!id) {
        throw new Error("Message ID is required");
      }
      const data = await sendHttpRequest(
        `${cleanBaseUrl}/api/message/${encodeURIComponent(String(id))}`,
        {
          method: "GET",
          timeoutMs: defaultTimeoutMs,
          signal,
          maxRetries,
          retryDelayMs: bulkDelayMs,
          fetchFn
        }
      );
      return normalizeMessageDetail(data);
    },

    /**
     * Extends validity of an email.
     * POST /api/extend-email { email: string }
     *
     * @param {object} params
     * @param {string} params.email
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ success: boolean, message: string, expiresAt: string | null }>}
     */
    async extendEmail({ email, signal }) {
      const validatedEmail = validateEmail(email);
      const data = await sendHttpRequest(`${cleanBaseUrl}/api/extend-email`, {
        method: "POST",
        body: { email: validatedEmail },
        timeoutMs: defaultTimeoutMs,
        signal,
        maxRetries,
        retryDelayMs: bulkDelayMs,
        fetchFn
      });
      return normalizeExtendEmail(data);
    },

    /**
     * Deletes a message by ID upstream (if supported).
     * DELETE /api/delete-message/{id}
     *
     * @param {object} params
     * @param {string} params.id
     * @param {AbortSignal} [params.signal]
     */
    async deleteMessage({ id, signal }) {
      if (!id) {
        throw new Error("Message ID is required");
      }
      return sendHttpRequest(
        `${cleanBaseUrl}/api/delete-message/${encodeURIComponent(String(id))}`,
        {
          method: "DELETE",
          timeoutMs: defaultTimeoutMs,
          signal,
          maxRetries,
          retryDelayMs: bulkDelayMs,
          fetchFn
        }
      );
    }
  };
}

