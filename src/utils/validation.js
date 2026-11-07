import { ValidationError } from "./errors.js";

const VALID_EMAIL_TYPES = Object.freeze([1, 2, 3, 8]);
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Validates email count (1 to 50).
 *
 * @param {any} count
 * @returns {number}
 */
export function validateCount(count) {
  const num = typeof count === "string" ? Number(count.trim()) : Number(count);
  if (!Number.isInteger(num) || num < 1 || num > 50) {
    throw new ValidationError("Jumlah harus berupa bilangan bulat antara 1 dan 50.");
  }
  return num;
}

/**
 * Validates selected type IDs array.
 * Must be non-empty subset of [1, 2, 3, 8].
 *
 * @param {any} types
 * @returns {number[]}
 */
export function validateTypeIds(types) {
  if (!Array.isArray(types) || types.length === 0) {
    throw new ValidationError("Minimal satu tipe email harus dipilih.");
  }

  const validated = [];
  for (const t of types) {
    const num = Number(t);
    if (!VALID_EMAIL_TYPES.includes(num)) {
      throw new ValidationError(`Tipe email tidak valid: ${t}`);
    }
    if (!validated.includes(num)) {
      validated.push(num);
    }
  }

  return validated;
}

/**
 * Validates an email address.
 *
 * @param {string} email
 * @returns {string}
 */
export function validateEmail(email) {
  if (typeof email !== "string") {
    throw new ValidationError("Alamat email wajib diisi.");
  }
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) {
    throw new ValidationError("Panjang alamat email tidak valid.");
  }
  if (!EMAIL_REGEX.test(trimmed)) {
    throw new ValidationError("Format alamat email tidak valid.");
  }
  return trimmed.toLowerCase();
}

