import {
  HttpError,
  RequestTimeoutError,
  OperationCancelledError
} from "../utils/errors.js";
import { abortableDelay } from "../utils/abortableDelay.js";

const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Checks if an HTTP status code or error is transient (eligible for retry).
 *
 * @param {number | Error} statusOrError
 * @returns {boolean}
 */
export function isTransient(statusOrError) {
  if (typeof statusOrError === "number") {
    return TRANSIENT_STATUS_CODES.has(statusOrError);
  }
  if (statusOrError instanceof RequestTimeoutError) {
    return true;
  }
  if (statusOrError instanceof HttpError) {
    return statusOrError.isTransient;
  }
  // Generic network errors (TypeError: fetch failed) are transient
  if (statusOrError?.name === "TypeError" || statusOrError?.code === "ECONNRESET") {
    return true;
  }
  return false;
}

/**
 * Parses the Retry-After header value in seconds.
 *
 * @param {string | null} headerVal
 * @returns {number | null} Delay in milliseconds or null
 */
function parseRetryAfter(headerVal) {
  if (!headerVal) return null;
  const trimmed = headerVal.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    // Clamp to maximum 10 seconds to avoid blocking indefinitely
    return Math.min(seconds * 1000, 10000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(0, Math.min(diff, 10000));
  }
  return null;
}

/**
 * Executes an HTTP request with timeout, abort signal, safe JSON parsing, and retry for transient errors.
 *
 * @param {string} url
 * @param {object} options
 * @param {string} [options.method="GET"]
 * @param {Record<string, string>} [options.headers]
 * @param {any} [options.body]
 * @param {number} [options.timeoutMs=30000]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.maxRetries=0]
 * @param {number} [options.retryDelayMs=1000]
 * @param {typeof fetch} [options.fetchFn]
 * @returns {Promise<any>}
 */
export async function sendHttpRequest(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = 30000,
    signal: externalSignal,
    maxRetries = 0,
    retryDelayMs = 1000,
    fetchFn = globalThis.fetch
  } = options;

  if (externalSignal?.aborted) {
    if (externalSignal.reason instanceof OperationCancelledError) {
      throw externalSignal.reason;
    }
    throw new OperationCancelledError("Request cancelled before start");
  }

  let attempt = 0;

  while (true) {
    attempt++;
    const controller = new AbortController();
    let timeoutId = null;
    let didTimeout = false;

    // Handle external abort signal
    const onExternalAbort = () => {
      controller.abort(
        externalSignal.reason instanceof Error
          ? externalSignal.reason
          : new OperationCancelledError("Operation cancelled")
      );
    };

    if (externalSignal) {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        didTimeout = true;
        controller.abort(new RequestTimeoutError(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    try {
      const requestHeaders = { ...headers };
      let serializedBody = body;

      if (body !== null && typeof body === "object" && !(body instanceof Uint8Array)) {
        if (!requestHeaders["Content-Type"]) {
          requestHeaders["Content-Type"] = "application/json";
        }
        serializedBody = JSON.stringify(body);
      }

      const response = await fetchFn(url, {
        method,
        headers: requestHeaders,
        body: serializedBody,
        signal: controller.signal
      });

      // Clear timeout and listeners immediately after headers/body start
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }

      // Read response body safely
      const responseText = await response.text();
      let parsedData = null;
      if (responseText.length > 0) {
        try {
          parsedData = JSON.parse(responseText);
        } catch {
          // If response is not valid JSON
          parsedData = responseText;
        }
      }

      if (!response.ok) {
        const transient = isTransient(response.status);
        const error = new HttpError(
          `HTTP ${response.status} ${response.statusText}`,
          response.status,
          response.statusText,
          parsedData,
          transient
        );

        if (transient && attempt <= maxRetries) {
          // Check Retry-After header
          const retryAfterMs = parseRetryAfter(response.headers?.get("retry-after"));
          const waitTime = retryAfterMs !== null ? retryAfterMs : retryDelayMs;
          await abortableDelay(waitTime, externalSignal);
          continue; // Retry loop
        }

        throw error;
      }

      // Check if response is non-JSON when JSON was expected
      if (typeof parsedData !== "object" || parsedData === null) {
        throw new HttpError(
          "Invalid response format: expected JSON object from server",
          response.status,
          response.statusText,
          parsedData,
          false
        );
      }

      return parsedData;
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }

      // External cancellation takes top priority
      if (externalSignal?.aborted) {
        if (externalSignal.reason instanceof OperationCancelledError) {
          throw externalSignal.reason;
        }
        throw new OperationCancelledError(
          externalSignal.reason?.message || "Operation cancelled"
        );
      }

      if (didTimeout || err instanceof RequestTimeoutError) {
        if (attempt <= maxRetries) {
          await abortableDelay(retryDelayMs, externalSignal);
          continue;
        }
        throw new RequestTimeoutError(`Request timed out after ${timeoutMs}ms`);
      }

      // Check transient for generic network errors
      if (isTransient(err) && attempt <= maxRetries) {
        await abortableDelay(retryDelayMs, externalSignal);
        continue;
      }

      throw err;
    }
  }
}
