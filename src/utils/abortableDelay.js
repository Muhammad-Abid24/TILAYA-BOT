import { OperationCancelledError } from "./errors.js";

/**
 * Delays for a given duration in milliseconds, abortable via AbortSignal.
 *
 * @param {number} ms - Milliseconds to sleep.
 * @param {AbortSignal} [signal] - Optional abort signal.
 * @returns {Promise<void>}
 */
export function abortableDelay(ms, signal) {
  if (signal?.aborted) {
    if (signal.reason instanceof OperationCancelledError) {
      return Promise.reject(signal.reason);
    }
    return Promise.reject(new OperationCancelledError("Operation was cancelled"));
  }

  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let timer = null;

    const onAbort = () => {
      if (timer) clearTimeout(timer);
      const reason = signal.reason instanceof Error
        ? signal.reason
        : new OperationCancelledError("Operation was cancelled");
      reject(reason);
    };

    timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
