export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

export function contactKeyboard(label) {
  return {
    keyboard: [[{ text: label, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

export const removeKeyboard = { remove_keyboard: true };

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function telegramRequest(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  let data;
  try { data = await res.json(); }
  catch { data = { ok: false, description: `HTTP ${res.status}` }; }
  return { res, data };
}

export async function tg(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");

  let currentPayload = { ...payload };
  let { res, data } = await telegramRequest(env, method, currentPayload);

  // Telegram can migrate a normal group to a supergroup and invalidate the old
  // chat id. When that happens Telegram returns migrate_to_chat_id. Retry once
  // automatically so support tickets still reach the operator group.
  const migratedChatId = data?.parameters?.migrate_to_chat_id;
  if ((!res.ok || !data.ok) && migratedChatId && currentPayload.chat_id != null) {
    console.warn("Telegram chat migrated; retrying", {
      method,
      from: String(currentPayload.chat_id),
      to: String(migratedChatId)
    });
    currentPayload = { ...currentPayload, chat_id: migratedChatId };
    ({ res, data } = await telegramRequest(env, method, currentPayload));
  }

  if (!res.ok || !data.ok) {
    const chatInfo = currentPayload.chat_id != null ? `; chat_id=${currentPayload.chat_id}` : "";
    throw new Error(`Telegram ${method} failed: ${data?.description || res.status}${chatInfo}`);
  }
  return data.result;
}

export function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}

export function editMessage(env, chatId, messageId, text, extra = {}) {
  return tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}

export function sendPhoto(env, chatId, photo, caption = "", extra = {}) {
  return tg(env, "sendPhoto", {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: "HTML",
    ...extra
  });
}

export function editCaption(env, chatId, messageId, caption, extra = {}) {
  return tg(env, "editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
    ...extra
  });
}

export function sendChatAction(env, chatId, action = "typing") {
  return tg(env, "sendChatAction", {
    chat_id: chatId,
    action
  });
}

export async function answerCallback(env, callbackQueryId, text) {
  try {
    return await tg(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      show_alert: false
    });
  } catch (error) {
    // Callback acknowledgements can expire or be attempted twice. Never let that
    // break the actual button action / webhook flow.
    console.warn("answerCallbackQuery ignored", String(error));
    return null;
  }
}

export function editReplyMarkup(env, chatId, messageId, replyMarkup = { inline_keyboard: [] }) {
  return tg(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup
  });
}

export function copyMessage(env, toChatId, fromChatId, messageId) {
  return tg(env, "copyMessage", {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId
  });
}
