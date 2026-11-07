import { validateEmail } from "../utils/validation.js";
import { AuthorizationError, ValidationError } from "../utils/errors.js";

/**
 * Service managing email extension with ownership checks and upstream API calls.
 */
export function createExtendService({ apiClient, repos }) {
  return {
    /**
     * Gets user's recently generated unique addresses for selection menu.
     *
     * @param {number} userId
     * @param {number} [limit=5]
     * @returns {string[]}
     */
    getUserRecentEmails(userId, limit = 5) {
      return repos.addresses.getRecentUserAddresses(userId, limit);
    },

    /**
     * Validates that the email is well-formatted and owned by the requesting user.
     *
     * @param {object} params
     * @param {number} params.userId
     * @param {string} params.email
     * @returns {string} Normalized email
     */
    validateOwnership({ userId, email }) {
      if (!email || typeof email !== "string") {
        throw new ValidationError("Alamat email wajib ditentukan.");
      }

      const validatedEmail = validateEmail(email);
      const isOwned = repos.addresses.hasUserAddress(userId, validatedEmail);

      if (!isOwned) {
        throw new AuthorizationError(
          "Alamat email tidak ditemukan dalam riwayat bot Anda atau bukan milik Anda."
        );
      }

      return validatedEmail;
    },

    /**
     * Extends the email lifetime via upstream API after ownership verification.
     *
     * @param {object} params
     * @param {number} params.userId
     * @param {string} params.email
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ success: boolean, message: string, expiresAt: string | null }>}
     */
    async executeExtend({ userId, email, signal }) {
      const validatedEmail = this.validateOwnership({ userId, email });

      const result = await apiClient.extendEmail({
        email: validatedEmail,
        signal
      });

      return result;
    }
  };
}

