import { validateEmail } from "../utils/validation.js";
import { AuthorizationError } from "../utils/errors.js";
import { escapeHtml } from "../utils/formatting.js";

export const INBOX_PAGE_SIZE = 5;

/**
 * Service managing inbox retrieval, snapshotting, and message reading with strict ownership.
 */
export function createInboxService({ apiClient, repos }) {
  return {
    /**
     * Retrieves inbox for an email address, verifies user ownership, and creates a local snapshot.
     *
     * @param {object} params
     * @param {number} params.userId
     * @param {string} params.email
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{
     *   snapshotId: string,
     *   email: string,
     *   totalMessages: number,
     *   messages: Array<{ ordinal: number, messageId: string, sender: string, subject: string, receivedAt: string }>
     * }>}
     */
    async getInbox({ userId, email, signal }) {
      const validatedEmail = validateEmail(email);

      // Verify ownership: user must own this address in DB
      const isOwned = repos.addresses.hasUserAddress(userId, validatedEmail);
      if (!isOwned) {
        throw new AuthorizationError(
          "Akses ditolak: Anda hanya dapat membuka kotak masuk untuk alamat email milik Anda sendiri."
        );
      }

      const rawMessages = await apiClient.getMessageList({
        email: validatedEmail,
        limit: 50,
        signal
      });

      const snapshotId = `snap_${Date.now()}_${userId}`;
      const mappedMessages = rawMessages.map((msg, index) => ({
        ordinal: index + 1,
        messageId: String(msg.id),
        sender: msg.sender || "(Pengirim tidak diketahui)",
        subject: msg.subject || "(Tanpa subjek)",
        receivedAt: msg.date || ""
      }));

      // Persist snapshot with mapped ordinals (DO NOT persist email bodies)
      repos.inboxSnapshots.createSnapshot({
        id: snapshotId,
        userId,
        email: validatedEmail,
        ttlMs: 10 * 60 * 1000, // 10 minutes
        messages: mappedMessages
      });

      return {
        snapshotId,
        email: validatedEmail,
        totalMessages: mappedMessages.length,
        messages: mappedMessages
      };
    },

    /**
     * Reads a message by looking up its ordinal in the user's snapshot.
     * Guarantees that order changes upstream never cause reading the wrong message.
     *
     * @param {object} params
     * @param {number} params.userId
     * @param {string} params.snapshotId
     * @param {number} params.ordinal
     * @param {AbortSignal} [params.signal]
     */
    async readMessage({ userId, snapshotId, ordinal, signal }) {
      const mapped = repos.inboxSnapshots.getMessageByOrdinal(
        snapshotId,
        Number(ordinal),
        userId
      );

      if (!mapped) {
        return null;
      }

      // Fetch message body from upstream API (never cached locally)
      const detail = await apiClient.getMessage({
        id: mapped.messageId,
        signal
      });

      return {
        messageId: mapped.messageId,
        email: mapped.email,
        sender: detail.sender || mapped.sender,
        subject: detail.subject || mapped.subject,
        date: detail.date || "",
        bodyText: detail.bodyText || "(Pesan kosong)"
      };
    }
  };
}

/**
 * Formats inbox list view and inline keyboard with pagination.
 *
 * @param {object} params
 * @param {string} params.snapshotId
 * @param {string} params.email
 * @param {Array<{ ordinal: number, sender: string, subject: string, receivedAt: string }>} params.messages
 * @param {number} [params.page=1]
 * @returns {{ text: string, reply_markup: object }}
 */
export function renderInboxPage({ snapshotId, email, messages, page = 1 }) {
  const total = messages.length;
  if (total === 0) {
    return {
      text: `📭 <b>Kotak Masuk Kosong</b>\n\nAlamat: <code>${escapeHtml(email)}</code>\nBelum ada pesan masuk saat ini.`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Muat Ulang", callback_data: `inbox:${snapshotId}:refresh` }]
        ]
      }
    };
  }

  const totalPages = Math.ceil(total / INBOX_PAGE_SIZE);
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * INBOX_PAGE_SIZE;
  const pageMessages = messages.slice(startIndex, startIndex + INBOX_PAGE_SIZE);

  let text =
    `📬 <b>Kotak Masuk:</b> <code>${escapeHtml(email)}</code>\n` +
    `Total: <b>${total}</b> pesan (Halaman ${currentPage}/${totalPages})\n\n`;

  for (const msg of pageMessages) {
    text +=
      `<b>[${msg.ordinal}] Dari:</b> ${escapeHtml(msg.sender)}\n` +
      `   <b>Subjek:</b> ${escapeHtml(msg.subject)}\n` +
      `   <b>Waktu:</b> ${escapeHtml(msg.receivedAt || "-")}\n\n`;
  }

  text += `<i>Tekan tombol [Baca No] di bawah untuk membuka isi pesan.</i>`;

  // Row of read buttons for the current page
  const readButtons = pageMessages.map((msg) => ({
    text: `📖 Baca ${msg.ordinal}`,
    callback_data: `inbox:${snapshotId}:r:${msg.ordinal}`
  }));

  const inlineKeyboard = [];
  // Split read buttons into rows of up to 3 buttons
  for (let i = 0; i < readButtons.length; i += 3) {
    inlineKeyboard.push(readButtons.slice(i, i + 3));
  }

  // Pagination navigation row
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({
      text: "◀ Sebelumnya",
      callback_data: `inbox:${snapshotId}:p:${currentPage - 1}`
    });
  }
  if (totalPages > 1) {
    navRow.push({
      text: `📄 ${currentPage}/${totalPages}`,
      callback_data: `inbox:${snapshotId}:p:${currentPage}`
    });
  }
  if (currentPage < totalPages) {
    navRow.push({
      text: "Selanjutnya ▶",
      callback_data: `inbox:${snapshotId}:p:${currentPage + 1}`
    });
  }
  if (navRow.length > 0) {
    inlineKeyboard.push(navRow);
  }

  // Action row: Refresh
  inlineKeyboard.push([
    { text: "🔄 Muat Ulang", callback_data: `inbox:${snapshotId}:refresh` }
  ]);

  return {
    text,
    reply_markup: { inline_keyboard: inlineKeyboard }
  };
}

/**
 * Formats message detail view with safe character truncation for Telegram limits.
 *
 * @param {object} params
 * @param {string} params.snapshotId
 * @param {object} params.detail
 * @param {number} [params.returnPage=1]
 * @returns {{ text: string, reply_markup: object }}
 */
export function renderMessageDetail({ snapshotId, detail, returnPage = 1 }) {
  const maxBodyLength = 3200; // Safe limit under Telegram 4096 cap
  let body = detail.bodyText || "";
  let isTruncated = false;

  if (body.length > maxBodyLength) {
    body = body.slice(0, maxBodyLength);
    isTruncated = true;
  }

  const safeSender = escapeHtml(detail.sender);
  const safeSubject = escapeHtml(detail.subject);
  const safeDate = escapeHtml(detail.date || "-");
  const safeBody = escapeHtml(body);

  let text =
    `✉️ <b>Detail Pesan</b>\n` +
    `<b>Dari:</b> ${safeSender}\n` +
    `<b>Subjek:</b> ${safeSubject}\n` +
    `<b>Waktu:</b> ${safeDate}\n` +
    `----------------------------------------\n\n` +
    `<pre>${safeBody}</pre>`;

  if (isTruncated) {
    text += `\n\n⚠️ <i>[Isi pesan dipotong karena melebihi batas panjang Telegram]</i>`;
  }

  const replyMarkup = {
    inline_keyboard: [
      [
        {
          text: "◀ Kembali ke Daftar Pesan",
          callback_data: `inbox:${snapshotId}:p:${returnPage}`
        }
      ]
    ]
  };

  return { text, reply_markup: replyMarkup };
}
