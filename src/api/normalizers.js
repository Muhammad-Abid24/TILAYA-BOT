import { UpstreamApiError } from "../utils/errors.js";

/**
 * Strips HTML tags and decodes common HTML entities for safe text presentation.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalizes response of /api/generate-email
 *
 * @param {any} res
 * @returns {{ email: string, type?: number }}
 */
export function normalizeGenerateEmail(res) {
  if (!res || typeof res !== "object") {
    throw new UpstreamApiError("Invalid upstream response: expected object");
  }

  if (res.status && res.status !== "success") {
    throw new UpstreamApiError(res.message || "Failed to generate email from upstream", res);
  }

  const rawEmail = res.email || res.data?.email || (typeof res.data === "string" ? res.data : null);
  if (!rawEmail || typeof rawEmail !== "string") {
    throw new UpstreamApiError("Missing email address in upstream response", res);
  }

  const type = res.type || res.data?.type || undefined;
  return {
    email: rawEmail.trim().toLowerCase(),
    type: type !== undefined ? Number(type) : undefined
  };
}

/**
 * Normalizes response of /api/generate-bulk-email
 *
 * @param {any} res
 * @returns {string[]} Array of unique email addresses
 */
export function normalizeGenerateBulkEmail(res) {
  if (!res || typeof res !== "object") {
    throw new UpstreamApiError("Invalid upstream response: expected object");
  }

  if (res.status && res.status !== "success") {
    throw new UpstreamApiError(res.message || "Failed to generate bulk emails from upstream", res);
  }

  let items = [];
  if (Array.isArray(res.data)) {
    items = res.data;
  } else if (Array.isArray(res.emails)) {
    items = res.emails;
  } else if (Array.isArray(res)) {
    items = res;
  } else if (res.data && typeof res.data === "object") {
    items = Object.values(res.data);
  }

  const emails = [];
  const seen = new Set();

  for (const item of items) {
    let emailStr = "";
    if (typeof item === "string") {
      emailStr = item;
    } else if (item && typeof item === "object" && typeof item.email === "string") {
      emailStr = item.email;
    }

    const trimmed = emailStr.trim().toLowerCase();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      emails.push(trimmed);
    }
  }

  return emails;
}

/**
 * Normalizes response of /api/message-list
 *
 * @param {any} res
 * @returns {Array<{ id: string, sender: string, subject: string, date: string }>}
 */
export function normalizeMessageList(res) {
  if (!res || typeof res !== "object") {
    throw new UpstreamApiError("Invalid upstream response: expected object");
  }

  if (res.status && res.status !== "success") {
    throw new UpstreamApiError(res.message || "Failed to fetch message list from upstream", res);
  }

  let rawList = [];
  if (Array.isArray(res.data)) {
    rawList = res.data;
  } else if (Array.isArray(res.messages)) {
    rawList = res.messages;
  } else if (Array.isArray(res)) {
    rawList = res;
  }

  return rawList.map((msg, index) => {
    const id = String(msg.id || msg.message_id || msg._id || index);
    const sender = String(msg.from || msg.sender || "(Pengirim tidak diketahui)").trim();
    const subject = String(msg.subject || "(Tanpa subjek)").trim();
    const date = String(msg.date || msg.created_at || msg.time || "").trim();

    return { id, sender, subject, date };
  });
}

/**
 * Normalizes response of /api/message/{id}
 *
 * @param {any} res
 * @returns {{ id: string, sender: string, subject: string, date: string, bodyText: string }}
 */
export function normalizeMessageDetail(res) {
  if (!res || typeof res !== "object") {
    throw new UpstreamApiError("Invalid upstream response: expected object");
  }

  if (res.status && res.status !== "success") {
    throw new UpstreamApiError(res.message || "Failed to fetch message details from upstream", res);
  }

  const data = res.data && typeof res.data === "object" ? res.data : res;

  const id = String(data.id || data.message_id || "");
  const sender = String(data.from || data.sender || "(Pengirim tidak diketahui)").trim();
  const subject = String(data.subject || "(Tanpa subjek)").trim();
  const date = String(data.date || data.created_at || "").trim();

  let bodyText = "";
  if (typeof data.body_text === "string" && data.body_text.trim().length > 0) {
    bodyText = data.body_text.trim();
  } else if (typeof data.text === "string" && data.text.trim().length > 0) {
    bodyText = data.text.trim();
  } else if (typeof data.body_html === "string" && data.body_html.trim().length > 0) {
    bodyText = stripHtml(data.body_html);
  } else if (typeof data.html === "string" && data.html.trim().length > 0) {
    bodyText = stripHtml(data.html);
  } else if (typeof data.body === "string" && data.body.trim().length > 0) {
    bodyText = stripHtml(data.body);
  }

  return { id, sender, subject, date, bodyText };
}

/**
 * Normalizes response of /api/extend-email
 *
 * @param {any} res
 * @returns {{ success: boolean, message: string, expiresAt: string | null }}
 */
export function normalizeExtendEmail(res) {
  if (!res || typeof res !== "object") {
    throw new UpstreamApiError("Invalid upstream response: expected object");
  }

  const isSuccess = res.status === "success" || res.success === true;
  if (!isSuccess) {
    throw new UpstreamApiError(res.message || "Gagal memperpanjang email upstream", res);
  }

  const message = typeof res.message === "string" ? res.message : "Email berhasil diperpanjang";
  const expiresAt = res.expires_at || res.data?.expires_at || null;

  return {
    success: true,
    message,
    expiresAt: expiresAt ? String(expiresAt) : null
  };
}

