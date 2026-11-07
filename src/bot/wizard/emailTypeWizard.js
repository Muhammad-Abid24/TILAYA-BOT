import crypto from "node:crypto";

export const WIZARD_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const EMAIL_TYPE_CONFIG = Object.freeze([
  { id: 1, label: "Domain" },
  { id: 2, label: "+Gmail" },
  { id: 3, label: ".Gmail" },
  { id: 8, label: "GoogleMail" }
]);

/**
 * Generates an opaque short session ID.
 *
 * @returns {string}
 */
export function generateSessionId() {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * Builds the text message for the email type selection wizard.
 *
 * @param {object} params
 * @param {number} params.count
 * @param {number[]} params.selectedTypes
 * @returns {string}
 */
export function renderWizardText({ count, selectedTypes }) {
  const selectedCount = selectedTypes.length;
  let statusText = "";

  if (selectedCount === 0) {
    statusText = "⚠️ <i>Belum ada tipe yang dipilih. Silakan aktifkan minimal satu tipe.</i>";
  } else {
    const labels = EMAIL_TYPE_CONFIG
      .filter((t) => selectedTypes.includes(t.id))
      .map((t) => `<b>${t.label}</b>`)
      .join(", ");
    statusText = `✅ Tipe aktif: ${labels}`;
  }

  return (
    `🎯 <b>Pilih Tipe Email (${count} alamat)</b>\n\n` +
    `Tekan tombol di bawah untuk mengaktifkan/menonaktifkan tipe email yang diinginkan:\n\n` +
    `${statusText}\n\n` +
    `<i>Sesi wizard berlaku selama 10 menit.</i>`
  );
}

/**
 * Builds the inline keyboard for the email type selection wizard.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {number[]} params.selectedTypes
 * @returns {object}
 */
export function renderWizardKeyboard({ sessionId, selectedTypes }) {
  const selectedSet = new Set(selectedTypes);

  // 4 toggle buttons in 2 rows of 2
  const toggleButtons = EMAIL_TYPE_CONFIG.map((type) => {
    const isSelected = selectedSet.has(type.id);
    const indicator = isSelected ? "🟢 [ON]" : "⚪ [OFF]";
    return {
      text: `${indicator} ${type.label}`,
      callback_data: `w:${sessionId}:t:${type.id}`
    };
  });

  const keyboardRows = [
    [toggleButtons[0], toggleButtons[1]],
    [toggleButtons[2], toggleButtons[3]]
  ];

  // Action row: Generate (enabled indicator) and Cancel
  const canGenerate = selectedSet.size > 0;
  const genButtonText = canGenerate ? "✨ Generate Sekarang" : "🔒 Generate (Pilih Tipe)";

  keyboardRows.push([
    { text: genButtonText, callback_data: `w:${sessionId}:gen` },
    { text: "❌ Batal", callback_data: `w:${sessionId}:cancel` }
  ]);

  return {
    inline_keyboard: keyboardRows
  };
}

/**
 * Starts a new wizard session in the database and sends the initial wizard message.
 *
 * @param {object} params
 * @param {any} params.ctx - Telegraf context
 * @param {number} params.count - Number of emails to generate
 * @param {any} params.wizardRepo - Wizard sessions repository
 * @returns {Promise<string>} Created session ID
 */
export async function startEmailTypeWizard({ ctx, count, wizardRepo }) {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const sessionId = generateSessionId();
  const expiresAt = Date.now() + WIZARD_TTL_MS;

  const initialPayload = {
    count,
    selectedTypes: [] // All default OFF
  };

  wizardRepo.saveSession({
    id: sessionId,
    userId,
    chatId,
    state: "SELECT_TYPES",
    payload: initialPayload,
    expiresAt
  });

  const text = renderWizardText({ count, selectedTypes: [] });
  const markup = renderWizardKeyboard({ sessionId, selectedTypes: [] });

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: markup
  });

  return sessionId;
}

/**
 * Handles wizard button callback interactions.
 *
 * @param {object} params
 * @param {any} params.ctx - Telegraf context (must have callbackQuery)
 * @param {any} params.wizardRepo - Wizard sessions repository
 * @param {(payload: { count: number, selectedTypes: number[], sessionId: string }) => Promise<void>} [params.onGenerate]
 * @returns {Promise<boolean>} Whether the action was handled
 */
export async function handleWizardCallback({ ctx, wizardRepo, onGenerate }) {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("w:")) {
    return false;
  }

  const parts = data.split(":");
  const sessionId = parts[1];
  const action = parts[2];
  const targetId = parts[3] ? Number(parts[3]) : null;

  const session = wizardRepo.getSession(sessionId);

  // 1. Session existence check
  if (!session) {
    await ctx.answerCbQuery("Sesi wizard tidak ditemukan atau telah berakhir.", {
      show_alert: true
    });
    return true;
  }

  // 2. Ownership check
  if (session.userId !== ctx.from?.id || session.chatId !== ctx.chat?.id) {
    await ctx.answerCbQuery("Akses ditolak: Anda bukan pemilik sesi wizard ini.", {
      show_alert: true
    });
    return true;
  }

  // 3. Expiration check
  if (session.expiresAt <= Date.now()) {
    wizardRepo.deleteSession(sessionId);
    await ctx.answerCbQuery("Sesi wizard telah kedaluwarsa. Silakan ulangi.", {
      show_alert: true
    });
    return true;
  }

  // 4. Handle Cancel
  if (action === "cancel") {
    wizardRepo.deleteSession(sessionId);
    await ctx.answerCbQuery("Pembuatan email dibatalkan.");
    try {
      await ctx.editMessageText("❌ <i>Pembuatan email dibatalkan.</i>", {
        parse_mode: "HTML"
      });
    } catch {
      // Ignore if message could not be edited
    }
    return true;
  }

  // 5. Handle Toggle
  if (action === "t" && targetId) {
    const payload = session.payload || { count: 1, selectedTypes: [] };
    const currentTypes = new Set(payload.selectedTypes || []);

    if (currentTypes.has(targetId)) {
      currentTypes.delete(targetId);
    } else {
      currentTypes.add(targetId);
    }

    const updatedTypes = Array.from(currentTypes);
    payload.selectedTypes = updatedTypes;

    wizardRepo.saveSession({
      id: sessionId,
      userId: session.userId,
      chatId: session.chatId,
      state: "SELECT_TYPES",
      payload,
      expiresAt: session.expiresAt
    });

    await ctx.answerCbQuery();

    const newText = renderWizardText({
      count: payload.count,
      selectedTypes: updatedTypes
    });
    const newKeyboard = renderWizardKeyboard({
      sessionId,
      selectedTypes: updatedTypes
    });

    try {
      await ctx.editMessageText(newText, {
        parse_mode: "HTML",
        reply_markup: newKeyboard
      });
    } catch {
      // Ignore identical content edit error
    }
    return true;
  }

  // 6. Handle Generate
  if (action === "gen") {
    const payload = session.payload || { count: 1, selectedTypes: [] };
    const selectedTypes = payload.selectedTypes || [];

    if (selectedTypes.length === 0) {
      await ctx.answerCbQuery("Pilih minimal satu tipe email terlebih dahulu!", {
        show_alert: true
      });
      return true;
    }

    await ctx.answerCbQuery("Memproses pembuatan email...");

    if (typeof onGenerate === "function") {
      await onGenerate({
        sessionId,
        count: payload.count,
        selectedTypes
      });
    }

    return true;
  }

  return false;
}

