import { CONTACTS, MEDIA, POPULAR_SERVICES } from "./config.js";
import { getTariffs, syncOfficialSources } from "./catalog.js";
import {
  addV4Message,
  assignV4Ticket,
  claimV4Update,
  cleanupV4Updates,
  clearV4Session,
  closeV4Ticket,
  createV4Ticket,
  ensureV4Schema,
  getV4Session,
  getV4Ticket,
  getV4TicketBySupportMessage,
  getV4User,
  listV4Queue,
  listV4UserTickets,
  releaseV4Update,
  saveV4Profile,
  sessionData,
  setV4Language,
  setV4Rating,
  setV4Session,
  setV4Stage,
  setV4SupportMessage,
  upsertV4User,
  v4Stats
} from "./v4-db.js";
import {
  accountingKeyboard,
  categoryMeta,
  classifyText,
  departmentsKeyboard,
  departmentMeta,
  diagnosticText,
  homeKeyboard,
  L,
  languageKeyboard,
  normalizePhone,
  operatorKeyboard,
  operatorName,
  priorityFor,
  subscriberKeyboard,
  techKeyboard
} from "./v4-ui.js";
import {
  answerCallback,
  contactKeyboard,
  copyMessage,
  editReplyMarkup,
  escapeHtml,
  inlineKeyboard,
  removeKeyboard,
  sendChatAction,
  sendMessage,
  sendPhoto
} from "./telegram.js";

const VERSION = "4.0.0";
const BOT_NAME = "FiberNet Assistant";

function supportChat(env, department = "tech") {
  const specific = {
    tech: env.TECH_CHAT_ID,
    accounting: env.ACCOUNTING_CHAT_ID,
    subscriber: env.SUBSCRIBER_CHAT_ID,
    connection: env.CONNECTION_CHAT_ID
  }[department];
  return specific || env.SUPPORT_CHAT_ID || null;
}

function isOperatorChat(env, chatId) {
  return [env.SUPPORT_CHAT_ID, env.TECH_CHAT_ID, env.ACCOUNTING_CHAT_ID, env.SUBSCRIBER_CHAT_ID, env.CONNECTION_CHAT_ID]
    .filter(Boolean).map(String).includes(String(chatId));
}

function profileComplete(user) {
  return Boolean(user?.phone && user?.address);
}

function userName(user) {
  return [user?.first_name, user?.last_name].filter(Boolean).join(" ") || (user?.username ? `@${user.username}` : String(user?.telegram_id || "—"));
}

function formatDate(value, lang = "uz") {
  try {
    return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "uz-UZ", {
      timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(new Date(value));
  } catch { return String(value || "—"); }
}

async function showHome(env, chatId, lang) {
  const caption = L(lang,
    `⚡️ <b>${BOT_NAME}</b>\n\nInternet, texnik yordam, to‘lov, abonent bo‘limi, ulanish, tariflar va murojaatlar — <b>hammasi shu bot ichida</b>.\n\n👇 Kerakli bo‘limni tanlang:`,
    `⚡️ <b>${BOT_NAME}</b>\n\nИнтернет, техподдержка, платежи, абонентский отдел, подключение, тарифы и обращения — <b>всё внутри этого бота</b>.\n\n👇 Выберите раздел:`
  );
  try {
    await sendChatAction(env, chatId, "upload_photo");
    await sendPhoto(env, chatId, MEDIA.homeBanner, caption, { reply_markup: homeKeyboard(lang) });
  } catch {
    await sendMessage(env, chatId, caption, { reply_markup: homeKeyboard(lang) });
  }
}

async function showDepartments(env, chatId, lang) {
  await sendMessage(env, chatId, L(lang,
    "🎫 <b>Murojaat bo‘limi</b>\n\nQaysi bo‘limga murojaat yubormoqchisiz?",
    "🎫 <b>Обращения</b>\n\nВ какой отдел хотите отправить обращение?"
  ), { reply_markup: departmentsKeyboard(lang) });
}

async function showProfile(env, chatId, user) {
  const lang = user.language || "uz";
  await sendMessage(env, chatId, [
    `👤 <b>${L(lang, "Mening profilim", "Мой профиль")}</b>`, "",
    `🙍 ${escapeHtml(userName(user))}`,
    `🔐 ${L(lang, "Login/shartnoma", "Логин/договор")}: <code>${escapeHtml(user.account_login || "—")}</code>`,
    `📍 ${L(lang, "Manzil", "Адрес")}: ${escapeHtml(user.address || "—")}`,
    `📞 ${L(lang, "Telefon", "Телефон")}: <b>${escapeHtml(user.phone || "—")}</b>`, "",
    profileComplete(user)
      ? L(lang, "✅ Profil tayyor. Yangi murojaatda ma’lumotlarni qayta kiritish shart emas.", "✅ Профиль готов. В новых обращениях данные можно не вводить заново.")
      : L(lang, "⚠️ Profilni to‘ldiring — keyingi murojaatlar tezroq yuboriladi.", "⚠️ Заполните профиль — следующие обращения будут отправляться быстрее.")
  ].join("\n"), { reply_markup: inlineKeyboard([
    [{ text: L(lang, "✏️ Profilni tahrirlash", "✏️ Изменить профиль"), callback_data: "profile:edit" }],
    [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
  ]) });
}

async function startProfileEdit(env, user, chatId) {
  const lang = user.language || "uz";
  await setV4Session(env, user.telegram_id, "profile_account", {});
  await sendMessage(env, chatId, L(lang,
    "🔐 <b>Login yoki shartnoma raqami</b>\n\nBilmasangiz <code>-</code> yuboring. Parol yubormang.",
    "🔐 <b>Логин или номер договора</b>\n\nЕсли не знаете — отправьте <code>-</code>. Пароль не отправляйте."
  ));
}

async function startTicket(env, user, chatId, department, category, options = {}) {
  const lang = user.language || "uz";
  const data = {
    department,
    category,
    prefillDescription: options.prefillDescription || null,
    diagnostic: options.diagnostic || null,
    skipAccount: department === "connection"
  };

  if (profileComplete(user)) {
    await setV4Session(env, user.telegram_id, "ticket_profile", data);
    const d = departmentMeta(department, lang);
    const c = categoryMeta(category, lang);
    await sendMessage(env, chatId,
      `${d.icon} <b>${escapeHtml(d.title)}</b>\n${c.icon} ${escapeHtml(c.title)}\n\n${L(lang, "Saqlangan profilingizdan foydalanamizmi?", "Использовать сохранённый профиль?")}\n\n📍 ${escapeHtml(user.address)}\n📞 ${escapeHtml(user.phone)}`,
      { reply_markup: inlineKeyboard([
        [{ text: L(lang, "✅ Profilimdan foydalanish", "✅ Использовать профиль"), callback_data: "flow:use_profile" }],
        [{ text: L(lang, "✏️ Boshqa ma’lumot kiritish", "✏️ Ввести другие данные"), callback_data: "flow:manual" }],
        [{ text: L(lang, "❌ Bekor qilish", "❌ Отмена"), callback_data: "flow:cancel" }]
      ]) }
    );
    return;
  }

  if (data.skipAccount) {
    await setV4Session(env, user.telegram_id, "ticket_address", data);
    await sendMessage(env, chatId, L(lang, "📍 <b>Ulanish manzilini yozing</b>", "📍 <b>Укажите адрес подключения</b>"));
  } else {
    await setV4Session(env, user.telegram_id, "ticket_account", data);
    await sendMessage(env, chatId, L(lang,
      "🔐 <b>Abonent login yoki shartnoma raqami</b>\n\nBilmasangiz <code>-</code> yuboring. Parol yubormang.",
      "🔐 <b>Логин абонента или номер договора</b>\n\nЕсли не знаете — отправьте <code>-</code>. Пароль не отправляйте."
    ));
  }
}

async function askDescription(env, user, data, chatId) {
  await setV4Session(env, user.telegram_id, "ticket_description", data);
  await sendMessage(env, chatId, L(user.language || "uz",
    "✍️ <b>Muammoni yoki savolni yozing</b>\n\nQisqa yozsangiz ham qabul qilinadi. Rasm/faylga izoh yozib ham yuborishingiz mumkin.",
    "✍️ <b>Опишите проблему или вопрос</b>\n\nМожно написать кратко. Также можно отправить фото/файл с подписью."
  ), { reply_markup: removeKeyboard });
}

async function notifyOperators(env, ticketNo) {
  const ticket = await getV4Ticket(env, ticketNo);
  if (!ticket) return null;
  const user = await getV4User(env, ticket.telegram_id);
  const lang = user?.language || "uz";
  const d = departmentMeta(ticket.department, lang);
  const c = categoryMeta(ticket.category, lang);
  const chatId = supportChat(env, ticket.department);
  if (!chatId) return null;
  const pIcon = ticket.priority === "critical" ? "🚨" : ticket.priority === "high" ? "🔴" : ticket.priority === "low" ? "🟢" : "🟡";
  const text = [
    `${pIcon} <b>${escapeHtml(ticket.priority.toUpperCase())} · ${escapeHtml(ticket.ticket_no)}</b>`,
    "━━━━━━━━━━━━━━", `${d.icon} <b>${escapeHtml(d.title)}</b>`, `${c.icon} ${escapeHtml(c.title)}`,
    `👤 ${escapeHtml(userName(user))} · <code>${ticket.telegram_id}</code>`,
    user?.username ? `🔗 @${escapeHtml(user.username)}` : null,
    `🔐 Login: <code>${escapeHtml(ticket.account_login || "—")}</code>`,
    `📍 ${escapeHtml(ticket.address || "—")}`, `📞 ${escapeHtml(ticket.phone || "—")}`, "",
    `📝 <b>${L(lang, "Murojaat", "Обращение")}:</b>`, escapeHtml(ticket.description), "",
    "💬 Shu xabarga Reply qiling — javob mijozga bot orqali yuboriladi."
  ].filter(Boolean).join("\n");
  const sent = await sendMessage(env, chatId, text, { reply_markup: operatorKeyboard(ticketNo) });
  await setV4SupportMessage(env, ticketNo, chatId, sent.message_id);
  return { chatId, messageId: sent.message_id };
}

async function createAndNotify(env, user, data, description, msg = null) {
  const full = data.diagnostic ? `${data.diagnostic}\n\n${description}` : description;
  const no = await createV4Ticket(env, {
    telegramId: user.telegram_id,
    department: data.department,
    category: data.category,
    description: full,
    accountLogin: data.accountLogin ?? user.account_login,
    address: data.address ?? user.address,
    phone: data.phone ?? user.phone,
    priority: priorityFor(data.category, full),
    telegramMessageId: msg?.message_id || null
  });
  await clearV4Session(env, user.telegram_id);
  const support = await notifyOperators(env, no);
  if (support && msg && !msg.text && (msg.photo || msg.document || msg.video || msg.voice || msg.audio)) {
    try { await copyMessage(env, support.chatId, msg.chat.id, msg.message_id); } catch {}
  }
  return no;
}

async function sendTicketSuccess(env, chatId, lang, no) {
  await sendMessage(env, chatId, L(lang,
    `✅ <b>Murojaat yuborildi</b>\n\n🎫 ID: <code>${no}</code>\nOperator javobi va status shu botga keladi.`,
    `✅ <b>Обращение отправлено</b>\n\n🎫 ID: <code>${no}</code>\nОтвет оператора и статус придут в этот бот.`
  ), { reply_markup: homeKeyboard(lang) });
}

async function showTariffMenu(env, chatId, lang) {
  await sendMessage(env, chatId, L(lang, "📶 <b>Tariflar</b>\n\nTarif seriyasini tanlang:", "📶 <b>Тарифы</b>\n\nВыберите серию:"), {
    reply_markup: inlineKeyboard([
      [{ text: "⚡ TEZKOR", callback_data: "tariff:tezkor:0" }, { text: "🌐 OnLine", callback_data: "tariff:online:0" }],
      [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
    ])
  });
}

async function showTariffs(env, chatId, lang, series, page = 0) {
  const items = await getTariffs(env, series);
  const perPage = 4;
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const slice = items.slice(page * perPage, page * perPage + perPage);
  const text = slice.map(x => [
    `⚡ <b>${escapeHtml(x.name)}</b>`,
    `💳 ${Number(x.price || 0).toLocaleString("ru-RU")} ${L(lang, "so‘m/oy", "сум/мес")}`,
    `🌙 18:00–00:00 · <b>${escapeHtml(x.evening || "—")} Mbit/s</b>`,
    `☀️ 00:00–18:00 · <b>${escapeHtml(x.daytime || "—")} Mbit/s</b>`,
    x.tv ? `📺 TV · ${escapeHtml(x.tv)}+` : null
  ].filter(Boolean).join("\n")).join("\n\n");
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️", callback_data: `tariff:${series}:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: "noop" });
  if (page < pages - 1) nav.push({ text: "➡️", callback_data: `tariff:${series}:${page + 1}` });
  await sendMessage(env, chatId, `📶 <b>${series === "tezkor" ? "TEZKOR" : "OnLine"}</b>\n\n${text || "—"}`, {
    reply_markup: inlineKeyboard([
      nav,
      [{ text: L(lang, "🔄 Tarifni o‘zgartirish", "🔄 Сменить тариф"), callback_data: "ticket:new:subscriber:tariff_change" }],
      [{ text: L(lang, "⬅️ Tariflar", "⬅️ Тарифы"), callback_data: "home:tariffs" }]
    ])
  });
}

async function showServices(env, chatId, lang) {
  const ru = {
    "Wi‑Fi sozlash": "Настройка Wi‑Fi", "Kompyuterda tarmoqni sozlash": "Настройка сети на компьютере",
    "LAN sozlash": "Настройка LAN", "Tarmoq uskunasi diagnostikasi": "Диагностика сетевого оборудования",
    "IPTV sozlash": "Настройка IPTV", "TV/pristavka sozlash": "Настройка ТВ/приставки",
    "Router yetkazib berish": "Доставка роутера", "Ustani chaqirish": "Вызов мастера"
  };
  const lines = POPULAR_SERVICES.map(([name, price]) => `• ${escapeHtml(lang === "ru" ? (ru[name] || name) : name)} — <b>${escapeHtml(price)}</b>`).join("\n");
  await sendMessage(env, chatId, `${L(lang, "🧰 <b>Xizmatlar</b>", "🧰 <b>Услуги</b>")}\n\n${lines}`, { reply_markup: inlineKeyboard([
    [{ text: L(lang, "🎫 Xizmat bo‘yicha murojaat", "🎫 Обращение по услуге"), callback_data: "ticket:new:subscriber:other" }],
    [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
  ]) });
}

async function showPromo(env, chatId, lang) {
  const caption = L(lang,
    "🎁 <b>FiberNet aksiyalari</b>\n\nAksiya bo‘yicha savolni shu botdan Abonent bo‘limiga yuborishingiz mumkin.",
    "🎁 <b>Акции FiberNet</b>\n\nВопрос по акции можно отправить в абонентский отдел прямо из бота."
  );
  try {
    await sendPhoto(env, chatId, lang === "ru" ? MEDIA.promoRu : MEDIA.promoUz, caption, { reply_markup: inlineKeyboard([
      [{ text: L(lang, "👥 Aksiya bo‘yicha savol", "👥 Вопрос по акции"), callback_data: "ticket:new:subscriber:other" }],
      [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
    ]) });
  } catch {
    await sendMessage(env, chatId, caption, { reply_markup: homeKeyboard(lang) });
  }
}

async function showContacts(env, chatId, lang) {
  await sendMessage(env, chatId, [
    `☎️ <b>${L(lang, "FiberNet aloqa", "Контакты FiberNet")}</b>`, "",
    `📞 <b>${CONTACTS.phone}</b>`, `🧑‍💻 ${CONTACTS.supportEmail}`, `📧 ${CONTACTS.infoEmail}`,
    `📍 ${escapeHtml(lang === "ru" ? CONTACTS.addressRu : CONTACTS.addressUz)}`, "",
    L(lang, "💬 Murojaatlarni shu bot orqali yuborish mumkin.", "💬 Обращения можно отправлять прямо через этот бот.")
  ].join("\n"), { reply_markup: inlineKeyboard([
    [{ text: L(lang, "🎫 Murojaat yuborish", "🎫 Создать обращение"), callback_data: "home:departments" }],
    [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
  ]) });
}

async function showUserTickets(env, chatId, user) {
  const lang = user.language || "uz";
  const rows = await listV4UserTickets(env, user.telegram_id, 10);
  if (!rows.length) {
    await sendMessage(env, chatId, L(lang, "📭 Hali murojaatlaringiz yo‘q.", "📭 У вас пока нет обращений."), { reply_markup: homeKeyboard(lang) });
    return;
  }
  const buttons = rows.map(x => [{
    text: `${x.status === "closed" ? "✅" : x.stage === "waiting_customer" ? "⏳" : "🟡"} ${x.ticket_no}`,
    callback_data: `ticket:view:${x.ticket_no}`
  }]);
  buttons.push([{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]);
  await sendMessage(env, chatId, L(lang, "📂 <b>Murojaatlarim</b>\n\nKo‘rish uchun ID ni bosing:", "📂 <b>Мои обращения</b>\n\nНажмите на ID:"), { reply_markup: inlineKeyboard(buttons) });
}

async function showTicket(env, chatId, user, no) {
  const ticket = await getV4Ticket(env, no);
  if (!ticket || String(ticket.telegram_id) !== String(user.telegram_id)) return;
  const lang = user.language || "uz";
  const d = departmentMeta(ticket.department, lang);
  const c = categoryMeta(ticket.category, lang);
  const buttons = [];
  if (ticket.status === "open") buttons.push([{ text: L(lang, "💬 Javob yozish", "💬 Ответить"), callback_data: `ticket:reply:${no}` }]);
  buttons.push([{ text: L(lang, "⬅️ Murojaatlarim", "⬅️ Мои обращения"), callback_data: "home:tickets" }]);
  await sendMessage(env, chatId, [
    `🎫 <b>${escapeHtml(no)}</b>`, `${ticket.status === "closed" ? "✅" : "🟡"} ${escapeHtml(ticket.stage)}`,
    `${d.icon} ${escapeHtml(d.title)}`, `${c.icon} ${escapeHtml(c.title)}`,
    ticket.assigned_name ? `👨‍💻 ${escapeHtml(ticket.assigned_name)}` : null,
    `🕒 ${escapeHtml(formatDate(ticket.created_at, lang))}`, "", `📝 ${escapeHtml(ticket.description)}`
  ].filter(Boolean).join("\n"), { reply_markup: inlineKeyboard(buttons) });
}

async function handleSession(env, msg, user, session) {
  if (!session) return false;
  const lang = user.language || "uz";
  const data = sessionData(session);
  const state = session.state;

  if (state === "profile_account") {
    if (!msg.text) return true;
    data.accountLogin = msg.text.trim() === "-" ? null : msg.text.trim().slice(0, 80);
    await setV4Session(env, user.telegram_id, "profile_address", data);
    await sendMessage(env, msg.chat.id, L(lang, "📍 Xizmat manzilingizni yozing:", "📍 Укажите адрес услуги:"));
    return true;
  }
  if (state === "profile_address") {
    if (!msg.text?.trim()) return true;
    data.address = msg.text.trim().slice(0, 300);
    await setV4Session(env, user.telegram_id, "profile_phone", data);
    await sendMessage(env, msg.chat.id, L(lang, "📞 Telefon raqamingizni yuboring:", "📞 Отправьте номер телефона:"), {
      reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер"))
    });
    return true;
  }
  if (state === "profile_phone") {
    const phone = normalizePhone(msg.contact?.phone_number || msg.text || "");
    if (!phone) {
      await sendMessage(env, msg.chat.id, L(lang, "⚠️ Raqamni qayta yuboring.", "⚠️ Отправьте номер ещё раз."), { reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер")) });
      return true;
    }
    data.phone = phone;
    await saveV4Profile(env, user.telegram_id, data);
    await clearV4Session(env, user.telegram_id);
    await sendMessage(env, msg.chat.id, L(lang, "✅ <b>Profil saqlandi.</b>", "✅ <b>Профиль сохранён.</b>"), { reply_markup: removeKeyboard });
    await showHome(env, msg.chat.id, lang);
    return true;
  }
  if (state === "ticket_account") {
    if (!msg.text) return true;
    data.accountLogin = msg.text.trim() === "-" ? null : msg.text.trim().slice(0, 80);
    await setV4Session(env, user.telegram_id, "ticket_address", data);
    await sendMessage(env, msg.chat.id, L(lang, "📍 Xizmat manzilini yozing:", "📍 Укажите адрес услуги:"));
    return true;
  }
  if (state === "ticket_address") {
    if (!msg.text?.trim()) return true;
    data.address = msg.text.trim().slice(0, 300);
    await setV4Session(env, user.telegram_id, "ticket_phone", data);
    await sendMessage(env, msg.chat.id, L(lang, "📞 Telefon raqamingizni yuboring yoki kontakt tugmasini bosing:", "📞 Отправьте номер или нажмите кнопку контакта:"), {
      reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер"))
    });
    return true;
  }
  if (state === "ticket_phone") {
    const phone = normalizePhone(msg.contact?.phone_number || msg.text || "");
    if (!phone) {
      await sendMessage(env, msg.chat.id, L(lang, "⚠️ Telefon raqamni qayta yuboring.", "⚠️ Отправьте номер ещё раз."), { reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер")) });
      return true;
    }
    data.phone = phone;
    await saveV4Profile(env, user.telegram_id, { accountLogin: data.accountLogin ?? user.account_login, address: data.address ?? user.address, phone });
    await askDescription(env, user, data, msg.chat.id);
    return true;
  }
  if (state === "ticket_description") {
    const body = String(msg.text || msg.caption || "").trim();
    const hasMedia = Boolean(msg.photo || msg.document || msg.video || msg.voice || msg.audio);
    if (!body && !hasMedia) {
      await sendMessage(env, msg.chat.id, L(lang, "✍️ Murojaat matnini yuboring.", "✍️ Отправьте текст обращения."));
      return true;
    }
    const description = body || L(lang, "Rasm/fayl yuborildi", "Отправлено фото/файл");
    const no = await createAndNotify(env, user, data, description.slice(0, 2000), msg);
    await sendTicketSuccess(env, msg.chat.id, lang, no);
    return true;
  }
  if (state === "ticket_reply") {
    const ticket = await getV4Ticket(env, data.ticketNo);
    if (!ticket || String(ticket.telegram_id) !== String(user.telegram_id) || ticket.status !== "open") {
      await clearV4Session(env, user.telegram_id);
      await sendMessage(env, msg.chat.id, L(lang, "⚠️ Murojaat topilmadi yoki yopilgan.", "⚠️ Обращение не найдено или закрыто."));
      return true;
    }
    const chatId = ticket.support_chat_id || supportChat(env, ticket.department);
    const body = String(msg.text || msg.caption || "").trim();
    if (body) await sendMessage(env, chatId, `💬 <b>${escapeHtml(ticket.ticket_no)} · mijoz</b>\n\n${escapeHtml(body)}`, ticket.support_message_id ? { reply_to_message_id: ticket.support_message_id } : {});
    if (!msg.text && (msg.photo || msg.document || msg.video || msg.voice || msg.audio)) {
      try { await copyMessage(env, chatId, msg.chat.id, msg.message_id); } catch {}
    }
    await addV4Message(env, ticket.ticket_no, "user", user.telegram_id, body || "[attachment]", msg.message_id);
    await setV4Stage(env, ticket.ticket_no, "in_progress");
    await clearV4Session(env, user.telegram_id);
    await sendMessage(env, msg.chat.id, L(lang, "✅ Javob operatorga yuborildi.", "✅ Ответ отправлен оператору."), { reply_markup: homeKeyboard(lang) });
    return true;
  }
  return false;
}

async function handlePrivateMessage(env, msg) {
  let user = await upsertV4User(env, msg.from);
  const text = String(msg.text || "").trim();
  const lang = user.language || "uz";

  if (text === "/start") {
    await clearV4Session(env, user.telegram_id);
    if (!user.language) return sendMessage(env, msg.chat.id, "🌐 <b>Tilni tanlang / Выберите язык</b>", { reply_markup: languageKeyboard() });
    return showHome(env, msg.chat.id, user.language);
  }
  if (text === "/cancel") {
    await clearV4Session(env, user.telegram_id);
    await sendMessage(env, msg.chat.id, L(lang, "❎ Amal bekor qilindi.", "❎ Действие отменено."), { reply_markup: removeKeyboard });
    return showHome(env, msg.chat.id, lang);
  }
  if (text === "/profile") return showProfile(env, msg.chat.id, user);
  if (text === "/tickets") return showUserTickets(env, msg.chat.id, user);
  if (text === "/language") return sendMessage(env, msg.chat.id, "🌐 <b>Til / Язык</b>", { reply_markup: languageKeyboard() });

  const session = await getV4Session(env, user.telegram_id);
  if (await handleSession(env, msg, user, session)) return;

  if (!user.language) return sendMessage(env, msg.chat.id, "🌐 <b>Tilni tanlang / Выберите язык</b>", { reply_markup: languageKeyboard() });
  if (!text) return showHome(env, msg.chat.id, lang);

  const intent = classifyText(text);
  if (intent.action === "home") return showHome(env, msg.chat.id, lang);
  if (intent.action === "tariffs") return showTariffMenu(env, msg.chat.id, lang);
  if (intent.action === "departments") {
    await sendMessage(env, msg.chat.id, L(lang, "🤔 Qaysi bo‘limga tegishli ekanini aniqlay olmadim. Bo‘limni tanlang:", "🤔 Не удалось определить отдел. Выберите нужный:"), { reply_markup: departmentsKeyboard(lang) });
    return;
  }
  return startTicket(env, user, msg.chat.id, intent.department, intent.category, { prefillDescription: text });
}

async function handleOperatorMessage(env, msg) {
  const text = String(msg.text || "").trim();
  let ticket = null;
  if (msg.reply_to_message?.message_id) ticket = await getV4TicketBySupportMessage(env, msg.reply_to_message.message_id);
  if (ticket && ticket.status === "open" && !text.startsWith("/")) {
    const user = await getV4User(env, ticket.telegram_id);
    const lang = user?.language || "uz";
    const body = String(msg.text || msg.caption || "").trim();
    if (body) {
      await sendMessage(env, ticket.telegram_id, `👨‍💻 <b>FiberNet ${L(lang, "operatori", "оператор")}</b>\n\n${escapeHtml(body)}`, {
        reply_markup: inlineKeyboard([[{ text: L(lang, "💬 Javob yozish", "💬 Ответить"), callback_data: `ticket:reply:${ticket.ticket_no}` }]])
      });
    } else if (msg.photo || msg.document || msg.video || msg.voice || msg.audio) {
      try { await copyMessage(env, ticket.telegram_id, msg.chat.id, msg.message_id); } catch {}
      await sendMessage(env, ticket.telegram_id, L(lang, "👨‍💻 Operator sizga fayl/media yubordi.", "👨‍💻 Оператор отправил вам файл/медиа."));
    }
    await addV4Message(env, ticket.ticket_no, "operator", msg.from.id, body || "[attachment]", msg.message_id);
    await assignV4Ticket(env, ticket.ticket_no, { id: msg.from.id, name: operatorName(msg.from) });
    await setV4Stage(env, ticket.ticket_no, "in_progress", { id: msg.from.id, name: operatorName(msg.from) });
    return;
  }

  if (text === "/queue" || text === "/tickets") {
    const rows = await listV4Queue(env, 20);
    const body = rows.length ? rows.map(x => `${x.priority === "critical" ? "🚨" : x.priority === "high" ? "🔴" : "🟡"} <b>${escapeHtml(x.ticket_no)}</b> · ${escapeHtml(x.department)} · ${escapeHtml(x.stage)}\n${escapeHtml((x.description || "").slice(0, 120))}`).join("\n\n") : "✅ Ochiq murojaatlar yo‘q.";
    return sendMessage(env, msg.chat.id, `📥 <b>FiberNet Queue</b>\n\n${body}`);
  }
  if (text === "/stats") {
    const s = await v4Stats(env);
    return sendMessage(env, msg.chat.id, `📊 <b>FiberNet v4</b>\n\n📚 Total: <b>${s.total || 0}</b>\n🟡 Open: <b>${s.open_count || 0}</b>\n✅ Closed: <b>${s.closed_count || 0}</b>`);
  }
  if (text === "/help" || text === "/admin") {
    return sendMessage(env, msg.chat.id, "🛠 <b>FiberNet Operator</b>\n\n/queue — ochiq murojaatlar\n/stats — statistika\n\nTicket xabariga Reply qilsangiz, javob mijozga ketadi.");
  }
}

async function handleCallback(env, q) {
  try { await answerCallback(env, q.id); } catch {}
  let user = await upsertV4User(env, q.from);
  const lang = user.language || "uz";
  const data = q.data || "";
  const chatId = q.message.chat.id;

  if (data === "noop") return;

  if (isOperatorChat(env, chatId) && data.startsWith("op:")) {
    const [, action, no] = data.split(":");
    const ticket = await getV4Ticket(env, no);
    if (!ticket || ticket.status !== "open") return;
    const op = { id: q.from.id, name: operatorName(q.from) };
    if (action === "claim") {
      await assignV4Ticket(env, no, op);
      return sendMessage(env, chatId, `👨‍💻 ${escapeHtml(op.name)} · ${escapeHtml(no)} ni qabul qildi.`);
    }
    if (action === "wait") {
      await assignV4Ticket(env, no, op);
      await setV4Stage(env, no, "waiting_customer", op);
      const u = await getV4User(env, ticket.telegram_id);
      return sendMessage(env, ticket.telegram_id, L(u?.language || "uz", `⏳ Operator <code>${no}</code> bo‘yicha javobingizni kutmoqda.`, `⏳ Оператор ждёт ваш ответ по <code>${no}</code>.`), {
        reply_markup: inlineKeyboard([[{ text: L(u?.language || "uz", "💬 Javob yozish", "💬 Ответить"), callback_data: `ticket:reply:${no}` }]])
      });
    }
    if (action === "resolve") {
      await assignV4Ticket(env, no, op);
      await setV4Stage(env, no, "resolved", op);
      const u = await getV4User(env, ticket.telegram_id);
      await sendMessage(env, ticket.telegram_id, L(u?.language || "uz", `✅ <b>Muammo hal qilindi deb belgilandi</b>\n\n🎫 <code>${no}</code>`, `✅ <b>Обращение отмечено как решённое</b>\n\n🎫 <code>${no}</code>`), {
        reply_markup: inlineKeyboard([
          [{ text: "👍", callback_data: `feedback:${no}:1` }, { text: "👎", callback_data: `feedback:${no}:0` }],
          [{ text: L(u?.language || "uz", "💬 Muammo davom etyapti", "💬 Проблема осталась"), callback_data: `ticket:reply:${no}` }]
        ])
      });
      return;
    }
    if (action === "close") {
      if (await closeV4Ticket(env, no, q.from.id)) {
        const u = await getV4User(env, ticket.telegram_id);
        await sendMessage(env, ticket.telegram_id, L(u?.language || "uz", `✅ Murojaat yopildi: <code>${no}</code>`, `✅ Обращение закрыто: <code>${no}</code>`), { reply_markup: homeKeyboard(u?.language || "uz") });
        try { await editReplyMarkup(env, chatId, q.message.message_id); } catch {}
      }
      return;
    }
  }

  if (data.startsWith("lang:")) {
    const next = data === "lang:ru" ? "ru" : "uz";
    await setV4Language(env, user.telegram_id, next);
    await clearV4Session(env, user.telegram_id);
    return showHome(env, chatId, next);
  }

  if (data === "home:main") { await clearV4Session(env, user.telegram_id); return showHome(env, chatId, lang); }
  if (data === "home:language") return sendMessage(env, chatId, "🌐 <b>Til / Язык</b>", { reply_markup: languageKeyboard() });
  if (data === "home:tech") return sendMessage(env, chatId, L(lang, "🛠 <b>Texnik yordam</b>\n\nMuammo turini tanlang:", "🛠 <b>Техподдержка</b>\n\nВыберите проблему:"), { reply_markup: techKeyboard(lang) });
  if (data === "home:accounting") return sendMessage(env, chatId, L(lang, "💳 <b>Buxgalteriya</b>\n\nSavol turini tanlang:", "💳 <b>Бухгалтерия</b>\n\nВыберите тему:"), { reply_markup: accountingKeyboard(lang) });
  if (data === "home:subscriber") return sendMessage(env, chatId, L(lang, "👥 <b>Abonent bo‘limi</b>\n\nSavol turini tanlang:", "👥 <b>Абонентский отдел</b>\n\nВыберите тему:"), { reply_markup: subscriberKeyboard(lang) });
  if (data === "home:departments") return showDepartments(env, chatId, lang);
  if (data === "home:profile") return showProfile(env, chatId, user);
  if (data === "home:tickets") return showUserTickets(env, chatId, user);
  if (data === "home:tariffs") return showTariffMenu(env, chatId, lang);
  if (data === "home:services") return showServices(env, chatId, lang);
  if (data === "home:promo") return showPromo(env, chatId, lang);
  if (data === "home:contacts") return showContacts(env, chatId, lang);
  if (data === "profile:edit") return startProfileEdit(env, user, chatId);

  if (data.startsWith("diag:")) {
    const category = data.slice(5);
    return sendMessage(env, chatId, diagnosticText(lang, category), { reply_markup: inlineKeyboard([
      [{ text: L(lang, "🎫 Operatorga murojaat", "🎫 Обращение оператору"), callback_data: `ticket:new:tech:${category}` }],
      [{ text: L(lang, "⬅️ Texnik yordam", "⬅️ Техподдержка"), callback_data: "home:tech" }]
    ]) });
  }

  if (data.startsWith("ticket:new:")) {
    const [, , department, category] = data.split(":");
    return startTicket(env, user, chatId, department, category, {
      diagnostic: department === "tech" ? diagnosticText(lang, category).replace(/<[^>]+>/g, "").slice(0, 700) : null
    });
  }

  if (data === "flow:use_profile") {
    const session = await getV4Session(env, user.telegram_id);
    if (!session || session.state !== "ticket_profile") return showHome(env, chatId, lang);
    const fd = sessionData(session);
    fd.accountLogin = user.account_login || null; fd.address = user.address || null; fd.phone = user.phone || null;
    if (fd.prefillDescription) {
      const no = await createAndNotify(env, user, fd, fd.prefillDescription);
      return sendTicketSuccess(env, chatId, lang, no);
    }
    return askDescription(env, user, fd, chatId);
  }
  if (data === "flow:manual") {
    const session = await getV4Session(env, user.telegram_id);
    if (!session || session.state !== "ticket_profile") return showHome(env, chatId, lang);
    const fd = sessionData(session);
    if (fd.skipAccount) {
      await setV4Session(env, user.telegram_id, "ticket_address", fd);
      return sendMessage(env, chatId, L(lang, "📍 Ulanish manzilini yozing:", "📍 Укажите адрес подключения:"));
    }
    await setV4Session(env, user.telegram_id, "ticket_account", fd);
    return sendMessage(env, chatId, L(lang, "🔐 Login/shartnoma raqamini yuboring. Bilmasangiz <code>-</code>.", "🔐 Отправьте логин/номер договора. Если не знаете — <code>-</code>."));
  }
  if (data === "flow:cancel") { await clearV4Session(env, user.telegram_id); return showHome(env, chatId, lang); }

  if (data.startsWith("tariff:")) {
    const [, series, page] = data.split(":");
    return showTariffs(env, chatId, lang, series, Number(page));
  }
  if (data.startsWith("ticket:view:")) return showTicket(env, chatId, user, data.slice("ticket:view:".length));
  if (data.startsWith("ticket:reply:")) {
    const no = data.slice("ticket:reply:".length);
    const ticket = await getV4Ticket(env, no);
    if (!ticket || String(ticket.telegram_id) !== String(user.telegram_id) || ticket.status !== "open") return;
    await setV4Session(env, user.telegram_id, "ticket_reply", { ticketNo: no });
    return sendMessage(env, chatId, L(lang, `💬 <b>${escapeHtml(no)}</b>\n\nJavobingizni yozing yoki media yuboring:`, `💬 <b>${escapeHtml(no)}</b>\n\nНапишите ответ или отправьте медиа:`));
  }
  if (data.startsWith("feedback:")) {
    const [, no, score] = data.split(":");
    const ticket = await getV4Ticket(env, no);
    if (!ticket || String(ticket.telegram_id) !== String(user.telegram_id)) return;
    await setV4Rating(env, no, user.telegram_id, Number(score));
    return sendMessage(env, chatId, L(lang, "💙 Rahmat! Bahoyingiz qabul qilindi.", "💙 Спасибо! Оценка принята."), { reply_markup: homeKeyboard(lang) });
  }
}

async function processUpdate(env, update) {
  if (!await claimV4Update(env, update.update_id)) return;
  try {
    if (update.callback_query) await handleCallback(env, update.callback_query);
    else if (update.message) {
      if (update.message.chat?.type === "private") await handlePrivateMessage(env, update.message);
      else if (isOperatorChat(env, update.message.chat?.id)) await handleOperatorMessage(env, update.message);
    }
  } catch (err) {
    await releaseV4Update(env, update.update_id);
    throw err;
  }
}

async function webhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  let update;
  try { update = await request.json(); } catch { return new Response("Bad Request", { status: 400 }); }
  if (!Number.isInteger(update.update_id)) return new Response("ok");
  await ensureV4Schema(env);
  await processUpdate(env, update);
  return new Response("ok");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      try { return await webhook(request, env); }
      catch (err) {
        console.error("FiberNet v4 webhook error", { error: String(err), stack: err?.stack });
        return new Response("Retry", { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        await ensureV4Schema(env);
        return Response.json({ ok: true, service: "fibernet-bot", version: VERSION, stats: await v4Stats(env) });
      } catch (err) {
        return Response.json({ ok: false, version: VERSION, error: String(err) }, { status: 503 });
      }
    }
    if (url.pathname === "/") return new Response(`FiberNet Assistant v${VERSION} is running.`);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try { await ensureV4Schema(env); await cleanupV4Updates(env); } catch (e) { console.error("v4 cleanup", String(e)); }
      try { await syncOfficialSources(env); } catch (e) { console.error("v4 sync", String(e)); }
    })());
  }
};

export const __test = { normalizePhone, classifyText, priorityFor };
