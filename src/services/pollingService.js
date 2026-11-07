import { validateEmail } from "../utils/validation.js";
import { abortableDelay } from "../utils/abortableDelay.js";
import { MessageWaitTimeoutError, OperationCancelledError } from "../utils/errors.js";

/**
 * Waits for a new incoming email message against an initial baseline snapshot of message IDs.
 * Strictly internal service (no user-facing /wait command on MVP).
 *
 * @param {object} options
 * @param {string} options.email - Target email address
 * @param {any} options.apiClient - TempMail API client
 * @param {number} [options.timeoutMs=75000] - Total deadline in milliseconds (default 75s)
 * @param {number} [options.intervalMs=5000] - Polling interval in milliseconds (default 5s)
 * @param {(msg: any) => boolean} [options.predicate] - Optional filter function
 * @param {AbortSignal} [options.signal] - Abort signal for cancellation
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.delayFn=abortableDelay] - Injectable delay
 * @returns {Promise<{
 *   message: { id: string, sender: string, subject: string, date: string },
 *   newMessages: Array<{ id: string, sender: string, subject: string, date: string }>,
 *   elapsedMs: number
 * }>}
 */
export async function waitForNewMessage(options) {
  const {
    email,
    apiClient,
    timeoutMs = 75000,
    intervalMs = 5000,
    predicate = null,
    signal,
    delayFn = abortableDelay
  } = options;

  const validatedEmail = validateEmail(email);

  if (signal?.aborted) {
    throw new OperationCancelledError("Message polling cancelled before start");
  }

  // 1. Establish baseline snapshot of message IDs
  const baselineList = await apiClient.getMessageList({
    email: validatedEmail,
    limit: 50,
    signal
  });

  const baselineIds = new Set(baselineList.map((m) => String(m.id)));
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  // 2. Poll every intervalMs until a new message appears or deadline is reached
  while (true) {
    if (signal?.aborted) {
      throw new OperationCancelledError("Waiting for message cancelled by user (/stop)");
    }

    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) {
      throw new MessageWaitTimeoutError(
        `Waiting for new message timed out after ${timeoutMs}ms`
      );
    }

    // Wait for next polling tick (abortable)
    const sleepDuration = Math.min(intervalMs, remainingTime);
    await delayFn(sleepDuration, signal);

    if (signal?.aborted) {
      throw new OperationCancelledError("Waiting for message cancelled by user (/stop)");
    }

    // Fetch current message list
    const currentList = await apiClient.getMessageList({
      email: validatedEmail,
      limit: 50,
      signal
    });

    // Detect new messages not present in baseline snapshot
    const newMessages = [];
    for (const msg of currentList) {
      const idStr = String(msg.id);
      if (!baselineIds.has(idStr)) {
        if (!predicate || predicate(msg)) {
          newMessages.push(msg);
        }
      }
    }

    if (newMessages.length > 0) {
      return {
        message: newMessages[0],
        newMessages,
        elapsedMs: Date.now() - startTime
      };
    }

    if (Date.now() >= deadline) {
      throw new MessageWaitTimeoutError(
        `Waiting for new message timed out after ${timeoutMs}ms`
      );
    }
  }
}

