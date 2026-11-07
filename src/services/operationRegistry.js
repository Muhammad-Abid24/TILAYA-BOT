import { OperationCancelledError } from "../utils/errors.js";

/**
 * Registry to track exactly one active network operation per user.
 * Ensures commands do not silently clobber existing long-running operations.
 */
export function createOperationRegistry() {
  /** @type {Map<number, { type: string, controller: AbortController, startedAt: number }>} */
  const activeOps = new Map();

  return {
    /**
     * Checks if a user currently has an active operation.
     *
     * @param {number} userId
     * @returns {boolean}
     */
    hasActiveOperation(userId) {
      return activeOps.has(userId);
    },

    /**
     * Retrieves the active operation details for a user.
     *
     * @param {number} userId
     */
    getActiveOperation(userId) {
      return activeOps.get(userId) || null;
    },

    /**
     * Starts a new operation for a user.
     * Throws an error if an operation is already active for this user.
     *
     * @param {number} userId
     * @param {string} type - Operation type identifier, e.g. 'generate', 'inbox', 'extend'
     * @returns {{ controller: AbortController, signal: AbortSignal }}
     */
    startOperation(userId, type) {
      if (activeOps.has(userId)) {
        throw new Error(
          "Anda memiliki operasi aktif yang sedang berjalan. Gunakan /stop untuk membatalkannya terlebih dahulu."
        );
      }

      const controller = new AbortController();
      activeOps.set(userId, {
        type,
        controller,
        startedAt: Date.now()
      });

      return {
        controller,
        signal: controller.signal
      };
    },

    /**
     * Stops/aborts any active operation for a user.
     *
     * @param {number} userId
     * @param {string} [reason="Cancelled by user via /stop"]
     * @returns {boolean} Whether an active operation was aborted
     */
    stopOperation(userId, reason = "Cancelled by user via /stop") {
      const op = activeOps.get(userId);
      if (!op) return false;

      op.controller.abort(new OperationCancelledError(reason));
      activeOps.delete(userId);
      return true;
    },

    /**
     * Clears an operation upon completion.
     *
     * @param {number} userId
     */
    clearOperation(userId) {
      activeOps.delete(userId);
    }
  };
}
