import app from "./index.js";
import { MEDIA, URLS } from "./config.js";
import {
  addTicketMessage,
  claimUpdate,
  clearState,
  createTicket,
  getTicket,
  getTicketBySupportMessage,
  getUser,
  parseStateData,
  releaseUpdate,
  savePhone,
  setLanguage,
  setState,
  setSupportMessageId,
  upsertUser
} from "./db.js";
import {
  answerCallback,
  contactKeyboard,
  escapeHtml,
  inlineKeyboard,
  removeKeyboard,
  sendChatAction,
  sendMessage,
  sendPhoto
} from "./telegram.js";

const VERSION = "2.2.0";
const L = (lang, uz, ru) => lang === "ru" ? ru : uz;

const languageKeyboard = () => inlineKeyboard([[
  { text: "🇺🇿 O‘zbekcha", callback_data: "lang:uz" },
  { text: "🇷🇺 Русский", callback_data: "lang:ru" }
]]);

const homeKeyboard = lang => inlineKeyboard([
  [
    { text: L(lang, "📶 Tariflar", "📶 Тарифы"), callback_data: "menu:tariffs" },
    { text: L(lang, "🛠 Texnik yordam", "🛠 Техподдержка"), callback_data: "menu:support" }
  ],
  [
    { text: L(lang, "🏢 Bo‘limlar", "🏢 Отделы"), callback_data: "menu:departments" },
    { text: L(lang, "🔌 Ulanish", "🔌 Подключение"), callback_data: "menu:connect" }
  ],
  [
    { text: L(lang, "🎁 Aksiyalar", "🎁 Акции"), callback_data: "menu:promo" },
    { text: L(lang, "🎫 Murojaatlarim", "🎫 Мои обращения"), callback_data: "menu:tickets" }
  ],
  [
    { text: L(lang, "👤 Shaxsiy kabinet", "👤 Личный кабинет"), callback_data: "menu:cabinet" },
    { text: L(lang, "☎️ Aloqa", "☎️ Контакты"), callback_data: "menu:contacts" }
  ],
  [
    { text: L(lang, "⚡ Tezlik testi", "⚡ Тест скорости"), url: URLS.speed },
    { text: "❓ FAQ", url: URLS.faq }
  ],
  [{ text: L(lang, "🌐 Til", "🌐 Язык"), callback_data: "menu:language" }]
]);

const departmentKeyboard = lang => inlineKeyboard([
  [{ text: L(lang, "🛠 Texnik yordam", "🛠 Техподдержка"), callback_data: "dept:tech" }],
  [{ text: L(lang, "👥 Abonent bo‘limi", "👥 Абонентский отдел"), callback_data: "dept:subscriber" }],
  [{ text: L(lang, "💳 Buxgalteriya", "💳 Бухгалтерия"), callback_data: "dept:accounting" }],
  [{ text: L(lang, "⬅️ Bosh menyu", "⬅️ Главное меню"), callback_data: "menu:home" }]
]);

function departmentMeta(dept, lang) {
  return ({
    tech: { icon: "🛠", title: L(lang, "Texnik yordam", "Техническая поддержка"), category: "other", priority: "normal" },
    subscriber: { icon: "👥", title: L(lang, "Abonent bo‘limi", "Абонентский отдел"), category: "other", priority: "low" },
    accounting: { icon: "💳", title: L(lang, "Buxgalteriya", "Бухгалтерия"), category: "billing", priority: "normal" }
  })[dept] || { icon: "🛠", title: L(lang, "Texnik yordam", "Техническая поддержка"), category: "other", priority: "normal" };
}

function normalizePhoneLoose(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 9) digits = `998${digits}`;
  if (digits.length === 10 && digits.startsWith("0")) digits = `998${digits.slice(1)}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
}

function priorityFor(category, description = "") {
  const text = String(description).toLowerCase();
  if (/\blos\b|qizil|красн|avari|авари|uzil|обрыв/.test(text)) return "high";
  if (category === "no_internet") return "high";
  if (category === "connection") return "low";
  return "normal";
}

async function claim(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  return claimUpdate(env, updateId);
}

async function showHome(env, chatId, lang) {
  const caption = L(
    lang,
    "⚡️ <b>FiberNet yordam markazi</b>\n\nInternet, Wi‑Fi, IPTV, tariflar, to‘lovlar va barcha bo‘limlar — bir joyda.\n\n👇 Kerakli bo‘limni tanlang:",
    "⚡️ <b>Центр помощи FiberNet</b>\n\nИнтернет, Wi‑Fi, IPTV, тарифы, платежи и все отделы — в одном месте.\n\n👇 Выберите нужный раздел:"
  );
  try {
    await sendChatAction(env, chatId, "upload_photo");
    return await sendPhoto(env, chatId, MEDIA.homeBanner, caption, { reply_markup: homeKeyboard(lang) });
  } catch {
    return sendMessage(env, chatId, caption, { reply_markup: homeKeyboard(lang) });
  }
}

async function notifyTicket(env, ticketNo, user, data, category, description, department = null) {
  if (!env.SUPPORT_CHAT_ID) return;
  const lang = user.language || "uz";
  const dept = department ? departmentMeta(department, lang) : null;
  const title = dept ? `${dept.icon} ${dept.title}` : `🎫 ${L(lang, "Texnik murojaat", "Техническое обращение")}`;
  const text = [
    `<b>${escapeHtml(title)} · ${escapeHtml(ticketNo)}</b>`,
    "━━━━━━━━━━━━━━",
    `👤 Telegram: <code>${user.telegram_id}</code>`,
    user.username ? `🔗 @${escapeHtml(user.username)}` : null,
    `📞 ${escapeHtml(data.phone || user.phone || "—")}`,
    `📍 ${escapeHtml(data.address || "—")}`,
    `🔐 Login: <code>${escapeHtml(data.accountLogin || "—")}</code>`,
    `🧩 ${escapeHtml(category)}`,
    "",
    `📝 <b>${L(lang, "Murojaat", "Обращение")}:</b>`,
    escapeHtml(description),
    "",
    `💬 ${L(lang, "Shu xabarga Reply qilsangiz, javob abonentga boradi.", "Ответьте Reply на это сообщение — ответ уйдёт абоненту.")}`
  ].filter(Boolean).join("\n");
  const sent = await sendMessage(env, env.SUPPORT_CHAT_ID, text, {
    reply_markup: inlineKeyboard([[{ text: "✅ Ticketni yopish", callback_data: `admin:close:${ticketNo}` }]])
  });
  await setSupportMessageId(env, ticketNo, sent.message_id);
}

async function createAndSendTicket(env, user, data, category, description, department = null) {
  const diagnostic = data.diagnostic ? `${L(user.language || "uz", "Diagnostika", "Диагностика")}: ${data.diagnostic}\n\n` : "";
  const full = `${diagnostic}${description}`.trim();
  const ticketNo = await createTicket(env, {
    telegramId: user.telegram_id,
    category,
    description: full,
    accountLogin: data.accountLogin,
    address: data.address,
    phone: data.phone || user.phone,
    priority: department ? departmentMeta(department, user.language || "uz").priority : priorityFor(category, full)
  });
  await clearState(env, user.telegram_id);
  await notifyTicket(env, ticketNo, user, data, category, full, department);
  return ticketNo;
}

async function handleCoreState(env, msg, user) {
  const state = user?.state || "";
  const lang = user?.language || "uz";
  const chatId = msg.chat.id;
  const data = parseStateData(user);

  if (state === "ticket_phone") {
    const phone = normalizePhoneLoose(msg.contact?.phone_number || msg.text || "");
    if (!phone) {
      await sendMessage(env, chatId, L(lang,
        "⚠️ Raqamni aniqlab bo‘lmadi. Kontakt tugmasini bosing yoki +998901234567 ko‘rinishida yozing.",
        "⚠️ Не удалось определить номер. Нажмите кнопку контакта или введите +998901234567."
      ), { reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер")) });
      return true;
    }
    data.phone = phone;
    await savePhone(env, user.telegram_id, phone);
    await setState(env, user.telegram_id, "ticket_description", data);
    await sendMessage(env, chatId, L(lang,
      "📝 <b>Muammoni yozing</b>\n\nErkin yozishingiz mumkin. Masalan: <i>internet ishlamayapti</i> yoki <i>Wi‑Fi uzilib qolmoqda</i>.",
      "📝 <b>Опишите проблему</b>\n\nПишите свободно. Например: <i>не работает интернет</i> или <i>Wi‑Fi постоянно отключается</i>."
    ), { reply_markup: removeKeyboard });
    return true;
  }

  if (state === "ticket_description") {
    const description = String(msg.text || "").trim();
    if (!description) {
      await sendMessage(env, chatId, L(lang, "✍️ Muammoni matn bilan yozing.", "✍️ Напишите проблему текстом."));
      return true;
    }
    const category = data.category || "other";
    const ticketNo = await createAndSendTicket(env, user, data, category, description.slice(0, 2000));
    await sendMessage(env, chatId, L(lang,
      `✅ <b>Murojaat yuborildi</b>\n\n🎫 ID: <code>${ticketNo}</code>\nOperator javobi shu bot orqali keladi.`,
      `✅ <b>Обращение отправлено</b>\n\n🎫 ID: <code>${ticketNo}</code>\nОтвет оператора придёт в этот бот.`
    ), { reply_markup: homeKeyboard(lang) });
    return true;
  }

  if (state === "connect_phone") {
    const phone = normalizePhoneLoose(msg.contact?.phone_number || msg.text || "");
    if (!phone) {
      await sendMessage(env, chatId, L(lang, "⚠️ Telefon raqamni qayta yuboring.", "⚠️ Отправьте номер телефона ещё раз."), {
        reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер"))
      });
      return true;
    }
    data.phone = phone;
    await savePhone(env, user.telegram_id, phone);
    const description = L(lang, "Yangi ulanish uchun ariza", "Заявка на новое подключение");
    const ticketNo = await createAndSendTicket(env, user, data, "connection", description);
    await sendMessage(env, chatId, L(lang,
      `✅ <b>Ulanish arizasi qabul qilindi</b>\n\n🎫 ID: <code>${ticketNo}</code>\nOperator siz bilan bog‘lanadi.`,
      `✅ <b>Заявка на подключение принята</b>\n\n🎫 ID: <code>${ticketNo}</code>\nОператор свяжется с вами.`
    ), { reply_markup: homeKeyboard(lang) });
    return true;
  }

  return false;
}

async function departmentStateFlow(env, msg, user) {
  if (!user?.state?.startsWith("dept_")) return false;
  const lang = user.language || "uz";
  const data = parseStateData(user);
  const chatId = msg.chat.id;
  const meta = departmentMeta(data.dept, lang);

  if (user.state === "dept_account") {
    if (!msg.text) return true;
    data.accountLogin = msg.text.trim() === "-" ? null : msg.text.trim().slice(0, 80);
    await setState(env, user.telegram_id, "dept_address", data);
    await sendMessage(env, chatId, L(lang, "📍 Xizmat manzilini yozing:", "📍 Укажите адрес услуги:"));
    return true;
  }

  if (user.state === "dept_address") {
    if (!msg.text) return true;
    data.address = msg.text.trim().slice(0, 300);
    await setState(env, user.telegram_id, "dept_phone", data);
    await sendMessage(env, chatId, L(lang, "📞 Telefon raqamingizni yuboring:", "📞 Отправьте номер телефона:"), {
      reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер"))
    });
    return true;
  }

  if (user.state === "dept_phone") {
    const phone = normalizePhoneLoose(msg.contact?.phone_number || msg.text || "");
    if (!phone) {
      await sendMessage(env, chatId, L(lang, "⚠️ Raqamni qayta yuboring.", "⚠️ Отправьте номер ещё раз."), {
        reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер"))
      });
      return true;
    }
    data.phone = phone;
    await savePhone(env, user.telegram_id, phone);
    await setState(env, user.telegram_id, "dept_description", data);
    await sendMessage(env, chatId, `${meta.icon} <b>${escapeHtml(meta.title)}</b>\n\n${L(lang, "✍️ Murojaatingizni yozing:", "✍️ Напишите ваше обращение:")}`, { reply_markup: removeKeyboard });
    return true;
  }

  if (user.state === "dept_description") {
    const description = String(msg.text || "").trim();
    if (!description) return true;
    const ticketNo = await createAndSendTicket(env, user, data, meta.category, description.slice(0, 2000), data.dept);
    await sendMessage(env, chatId, L(lang,
      `✅ <b>Murojaat yuborildi</b>\n\n🎫 ID: <code>${ticketNo}</code>\n${meta.icon} ${escapeHtml(meta.title)}`,
      `✅ <b>Обращение отправлено</b>\n\n🎫 ID: <code>${ticketNo}</code>\n${meta.icon} ${escapeHtml(meta.title)}`
    ), { reply_markup: homeKeyboard(lang) });
    return true;
  }

  return false;
}

async function handleWebhook(request, env, ctx) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;
  try { update = await request.clone().json(); }
  catch { return app.fetch(request, env, ctx); }

  if (update.callback_query) {
    const q = update.callback_query;
    const data = q.data || "";
    const user = await upsertUser(env, q.from);
    const lang = user.language || "uz";

    if (data.startsWith("lang:") || data === "menu:home" || data === "menu:departments" || data.startsWith("dept:")) {
      if (!await claim(env, update.update_id)) return new Response("ok");
      try {
        try { await answerCallback(env, q.id); } catch {}
        if (data.startsWith("lang:")) {
          const nextLang = data.slice(5) === "ru" ? "ru" : "uz";
          await setLanguage(env, q.from.id, nextLang);
          await clearState(env, q.from.id);
          await showHome(env, q.message.chat.id, nextLang);
        } else if (data === "menu:home") {
          await clearState(env, q.from.id);
          await showHome(env, q.message.chat.id, lang);
        } else if (data === "menu:departments") {
          await sendMessage(env, q.message.chat.id, L(lang,
            "🏢 <b>FiberNet bo‘limlari</b>\n\nKerakli bo‘limni tanlang:",
            "🏢 <b>Отделы FiberNet</b>\n\nВыберите нужный отдел:"
          ), { reply_markup: departmentKeyboard(lang) });
        } else {
          const dept = data.slice(5);
          const meta = departmentMeta(dept, lang);
          await setState(env, q.from.id, "dept_account", { dept });
          await sendMessage(env, q.message.chat.id, `${meta.icon} <b>${escapeHtml(meta.title)}</b>\n\n${L(lang,
            "Login yoki shartnoma raqamingizni yuboring. Bilmasangiz <code>-</code> yuboring.\n\n🔐 Parol yubormang.",
            "Отправьте логин или номер договора. Если не знаете — отправьте <code>-</code>.\n\n🔐 Не отправляйте пароль."
          )}`);
        }
        return new Response("ok");
      } catch (err) {
        await releaseUpdate(env, update.update_id);
        throw err;
      }
    }
  }

  if (update.message && update.message.chat?.type === "private") {
    const msg = update.message;
    let user = await upsertUser(env, msg.from);
    const text = String(msg.text || "").trim();

    if (text === "/start") {
      if (!await claim(env, update.update_id)) return new Response("ok");
      try {
        await clearState(env, msg.from.id);
        if (!user.language) await sendMessage(env, msg.chat.id, "🌐 <b>Tilni tanlang / Выберите язык</b>", { reply_markup: languageKeyboard() });
        else await showHome(env, msg.chat.id, user.language);
        return new Response("ok");
      } catch (err) {
        await releaseUpdate(env, update.update_id);
        throw err;
      }
    }

    user = await getUser(env, msg.from.id);
    const shouldHandle = user?.state?.startsWith("dept_") || ["ticket_phone", "ticket_description", "connect_phone"].includes(user?.state);
    if (shouldHandle) {
      if (!await claim(env, update.update_id)) return new Response("ok");
      try {
        if (await departmentStateFlow(env, msg, user)) return new Response("ok");
        if (await handleCoreState(env, msg, user)) return new Response("ok");
      } catch (err) {
        await releaseUpdate(env, update.update_id);
        throw err;
      }
    }
  }

  return app.fetch(request, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram/webhook") return handleWebhook(request, env, ctx);
    if (url.pathname === "/") return new Response(`FiberNet Support Bot v${VERSION} is running.`);
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return app.scheduled(controller, env, ctx);
  }
};
