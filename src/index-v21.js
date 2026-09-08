import app from "./index.js";
import { MEDIA, URLS } from "./config.js";
import {
  clearState,
  createTicket,
  getUser,
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

const VERSION = "2.1.0";
const L = (lang, uz, ru) => lang === "ru" ? ru : uz;

function languageKeyboard() {
  return inlineKeyboard([[
    { text: "🇺🇿 O‘zbekcha", callback_data: "lang:uz" },
    { text: "🇷🇺 Русский", callback_data: "lang:ru" }
  ]]);
}

function homeKeyboard(lang) {
  return inlineKeyboard([
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
    [
      { text: L(lang, "🧰 Xizmatlar", "🧰 Услуги"), callback_data: "menu:services" },
      { text: L(lang, "🌐 Til", "🌐 Язык"), callback_data: "menu:language" }
    ]
  ]);
}

function departmentKeyboard(lang) {
  return inlineKeyboard([
    [{ text: L(lang, "🛠 Texnik yordamga yozish", "🛠 Написать в техподдержку"), callback_data: "dept:tech" }],
    [{ text: L(lang, "👥 Abonent bo‘limi", "👥 Абонентский отдел"), callback_data: "dept:subscriber" }],
    [{ text: L(lang, "💳 Buxgalteriya", "💳 Бухгалтерия"), callback_data: "dept:accounting" }],
    [{ text: L(lang, "⬅️ Bosh menyu", "⬅️ Главное меню"), callback_data: "menu:home" }]
  ]);
}

function departmentMeta(dept, lang) {
  const map = {
    tech: {
      icon: "🛠",
      title: L(lang, "Texnik yordam", "Техническая поддержка"),
      category: "other",
      priority: "normal"
    },
    subscriber: {
      icon: "👥",
      title: L(lang, "Abonent bo‘limi", "Абонентский отдел"),
      category: "other",
      priority: "low"
    },
    accounting: {
      icon: "💳",
      title: L(lang, "Buxgalteriya", "Бухгалтерия"),
      category: "billing",
      priority: "normal"
    }
  };
  return map[dept] || map.tech;
}

function normalizePhoneLoose(value) {
  const raw = String(value || "").trim();
  let digits = raw.replace(/[^0-9]/g, "");

  // Uzbekistan local mobile format: 90 123 45 67 -> +998901234567
  if (digits.length === 9) digits = `998${digits}`;

  // Common accidental 0-prefix: 0901234567 -> +998901234567
  if (digits.length === 10 && digits.startsWith("0")) digits = `998${digits.slice(1)}`;

  // Telegram contact may return number without a leading +. Trust a real contact
  // as long as its normalized international length is sane.
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
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

async function startDepartmentFlow(env, q, lang, dept) {
  const meta = departmentMeta(dept, lang);
  await setState(env, q.from.id, "dept_account", { dept });
  return sendMessage(
    env,
    q.message.chat.id,
    `${meta.icon} <b>${escapeHtml(meta.title)}</b>\n\n${L(lang,
      "Abonent login yoki shartnoma raqamingizni yuboring. Bilmasangiz <code>-</code> yuboring.\n\n🔐 Parol yubormang.",
      "Отправьте логин абонента или номер договора. Если не знаете — отправьте <code>-</code>.\n\n🔐 Не отправляйте пароль."
    )}`
  );
}

async function notifyDepartmentTicket(env, ticketNo, user, data, description) {
  if (!env.SUPPORT_CHAT_ID) return;
  const lang = user.language || "uz";
  const meta = departmentMeta(data.dept, lang);
  const text = [
    `${meta.icon} <b>${escapeHtml(meta.title)} · ${escapeHtml(ticketNo)}</b>`,
    "━━━━━━━━━━━━━━",
    `👤 Telegram: <code>${user.telegram_id}</code>`,
    user.username ? `🔗 @${escapeHtml(user.username)}` : null,
    `📞 ${escapeHtml(data.phone || user.phone || "—")}`,
    `📍 ${escapeHtml(data.address || "—")}`,
    `🔐 Login: <code>${escapeHtml(data.accountLogin || "—")}</code>`,
    "",
    `📝 <b>${L(lang, "Murojaat", "Обращение")}:</b>`,
    escapeHtml(description),
    "",
    `💬 ${L(lang, "Shu xabarga Reply qilsangiz, javob abonentga boradi.", "Ответьте Reply на это сообщение — ответ уйдёт абоненту.")}`
  ].filter(Boolean).join("\n");

  const msg = await sendMessage(env, env.SUPPORT_CHAT_ID, text, {
    reply_markup: inlineKeyboard([[{ text: "✅ Ticketni yopish", callback_data: `admin:close:${ticketNo}` }]])
  });
  await setSupportMessageId(env, ticketNo, msg.message_id);
}

async function departmentStateFlow(env, msg, user) {
  if (!user?.state?.startsWith("dept_")) return false;
  const lang = user.language || "uz";
  let data = {};
  try { data = user.state_data ? JSON.parse(user.state_data) : {}; } catch {}
  const chatId = msg.chat.id;

  if (user.state === "dept_account") {
    if (!msg.text) return true;
    data.accountLogin = msg.text.trim() === "-" ? null : msg.text.trim().slice(0, 80);
    await setState(env, user.telegram_id, "dept_address", data);
    await sendMessage(env, chatId, L(lang,
      "📍 <b>Xizmat manzili</b>\n\nTuman, ko‘cha, uy/xonadonni yozing:",
      "📍 <b>Адрес услуги</b>\n\nУкажите район, улицу, дом/квартиру:"
    ));
    return true;
  }

  if (user.state === "dept_address") {
    if (!msg.text) return true;
    const address = msg.text.trim();
    if (address.length < 3) {
      await sendMessage(env, chatId, L(lang, "⚠️ Manzilni to‘liqroq yozing.", "⚠️ Укажите адрес подробнее."));
      return true;
    }
    data.address = address.slice(0, 300);
    await setState(env, user.telegram_id, "dept_phone", data);
    await sendMessage(env, chatId, L(lang,
      "📞 <b>Telefon raqam</b>\n\nPastdagi tugma orqali o‘z raqamingizni yuborishingiz mumkin yoki raqamni yozing:",
      "📞 <b>Номер телефона</b>\n\nМожно отправить свой номер кнопкой ниже или ввести его вручную:"
    ), { reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер")) });
    return true;
  }

  if (user.state === "dept_phone") {
    const raw = msg.contact?.phone_number || msg.text || "";
    const phone = normalizePhoneLoose(raw);
    if (!phone) {
      await sendMessage(env, chatId, L(lang,
        "⚠️ Raqamni aniqlab bo‘lmadi. Kontakt tugmasini bosing yoki masalan <code>+998901234567</code> ko‘rinishida yozing.",
        "⚠️ Не удалось определить номер. Нажмите кнопку контакта или введите, например, <code>+998901234567</code>."
      ), { reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер")) });
      return true;
    }
    data.phone = phone;
    await savePhone(env, user.telegram_id, phone);
    await setState(env, user.telegram_id, "dept_description", data);
    const meta = departmentMeta(data.dept, lang);
    await sendMessage(env, chatId,
      `${meta.icon} <b>${escapeHtml(meta.title)}</b>\n\n${L(lang,
        "✍️ Murojaatingizni erkin yozing. Qisqa yozsangiz ham qabul qilinadi — bot majburan uzun matn talab qilmaydi.",
        "✍️ Напишите обращение свободным текстом. Можно кратко — бот не требует длинного описания."
      )}`,
      { reply_markup: removeKeyboard }
    );
    return true;
  }

  if (user.state === "dept_description") {
    if (!msg.text || !msg.text.trim()) return true;
    const description = msg.text.trim().slice(0, 2000);
    const meta = departmentMeta(data.dept, lang);
    const prefixed = `${meta.icon} ${meta.title}\n\n${description}`;
    const priority = data.dept === "tech" && /\blos\b|qizil|красн|avari|авари/i.test(description) ? "high" : meta.priority;
    const ticketNo = await createTicket(env, {
      telegramId: user.telegram_id,
      category: meta.category,
      description: prefixed,
      accountLogin: data.accountLogin,
      address: data.address,
      phone: data.phone || user.phone,
      priority
    });
    await clearState(env, user.telegram_id);
    await notifyDepartmentTicket(env, ticketNo, user, data, description);
    await sendMessage(env, chatId, L(lang,
      `✅ <b>Murojaat yuborildi</b>\n\n🎫 ID: <code>${ticketNo}</code>\n${meta.icon} ${escapeHtml(meta.title)}\n\nOperator javobi shu bot orqali keladi.`,
      `✅ <b>Обращение отправлено</b>\n\n🎫 ID: <code>${ticketNo}</code>\n${meta.icon} ${escapeHtml(meta.title)}\n\nОтвет оператора придёт в этот бот.`
    ), { reply_markup: homeKeyboard(lang) });
    return true;
  }

  return false;
}

function transformTelegramContact(update) {
  const msg = update?.message;
  if (!msg?.contact?.phone_number) return update;
  const phone = normalizePhoneLoose(msg.contact.phone_number);
  if (!phone) return update;

  // Core v2 validates phone text. Convert a Telegram contact into a clean text
  // number before delegating, so contact formatting can never cause a false error.
  const cloned = structuredClone(update);
  cloned.message.text = phone;
  delete cloned.message.contact;
  return cloned;
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

    if (data.startsWith("lang:")) {
      try { await answerCallback(env, q.id); } catch {}
      const nextLang = data.slice(5) === "ru" ? "ru" : "uz";
      await setLanguage(env, q.from.id, nextLang);
      await clearState(env, q.from.id);
      await showHome(env, q.message.chat.id, nextLang);
      return new Response("ok");
    }

    if (data === "menu:home") {
      try { await answerCallback(env, q.id); } catch {}
      await clearState(env, q.from.id);
      await showHome(env, q.message.chat.id, lang);
      return new Response("ok");
    }

    if (data === "menu:departments") {
      try { await answerCallback(env, q.id); } catch {}
      await sendMessage(env, q.message.chat.id, L(lang,
        "🏢 <b>FiberNet bo‘limlari</b>\n\nKerakli bo‘limni tanlang. Har bir murojaat ticket sifatida operatorlarga yuboriladi.",
        "🏢 <b>Отделы FiberNet</b>\n\nВыберите нужный отдел. Обращение будет отправлено операторам как ticket."
      ), { reply_markup: departmentKeyboard(lang) });
      return new Response("ok");
    }

    if (data.startsWith("dept:")) {
      try { await answerCallback(env, q.id); } catch {}
      await startDepartmentFlow(env, q, lang, data.slice(5));
      return new Response("ok");
    }
  }

  if (update.message && update.message.chat?.type === "private") {
    const msg = update.message;
    let user = await upsertUser(env, msg.from);
    const text = String(msg.text || "").trim();

    if (text === "/start") {
      await clearState(env, msg.from.id);
      if (!user.language) {
        await sendMessage(env, msg.chat.id, "🌐 <b>Tilni tanlang / Выберите язык</b>", { reply_markup: languageKeyboard() });
      } else {
        await showHome(env, msg.chat.id, user.language);
      }
      return new Response("ok");
    }

    user = await getUser(env, msg.from.id);
    if (await departmentStateFlow(env, msg, user)) return new Response("ok");
  }

  const transformed = transformTelegramContact(update);
  if (transformed !== update) {
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    const forwarded = new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformed)
    });
    return app.fetch(forwarded, env, ctx);
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
