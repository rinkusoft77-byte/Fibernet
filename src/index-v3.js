import { CONTACTS, MEDIA, POPULAR_SERVICES } from "./config.js";
import { getSourceStatus, getTariffs, syncOfficialSources } from "./catalog.js";
import {
  addPortalMessage,
  advancedStats,
  assignTicket,
  claimUpdate,
  cleanupProcessedUpdates,
  clearFlow,
  closePortalTicket,
  createPortalTicket,
  ensurePortalSchema,
  flowData,
  getPortalTicket,
  getPortalUser,
  getTicketBySupportMessage,
  listPortalTickets,
  listQueue,
  markSlaNotified,
  releaseUpdate,
  savePortalPhone,
  setFlow,
  setPortalLanguage,
  setSatisfaction,
  setSupportMessage,
  setTicketStage,
  staleTickets,
  updatePortalProfile,
  upsertPortalUser
} from "./portal-db.js";
import {
  accountingKeyboard,
  categoryMeta,
  classifyText,
  departmentsKeyboard,
  diagnosticText,
  homeKeyboard,
  inferPriority,
  L,
  languageKeyboard,
  normalizePhone,
  operatorName,
  priorityMeta,
  stageLabel,
  subscriberKeyboard,
  techKeyboard,
  ticketOperatorKeyboard,
  departmentMeta
} from "./portal-ui.js";
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

const VERSION = "3.0.0";
const BOT_NAME = "FiberNet Assistant";

function isPrivate(msg) { return msg?.chat?.type === "private"; }

function operatorChats(env) {
  return new Set([
    env.SUPPORT_CHAT_ID,
    env.TECH_CHAT_ID,
    env.SUBSCRIBER_CHAT_ID,
    env.ACCOUNTING_CHAT_ID,
    env.CONNECTION_CHAT_ID
  ].filter(Boolean).map(String));
}

function isOperatorChat(env, chatId) {
  return operatorChats(env).has(String(chatId));
}

function chatForDepartment(env, department) {
  const specific = {
    tech: env.TECH_CHAT_ID,
    subscriber: env.SUBSCRIBER_CHAT_ID,
    accounting: env.ACCOUNTING_CHAT_ID,
    connection: env.CONNECTION_CHAT_ID
  }[department];
  return specific || env.SUPPORT_CHAT_ID;
}

function profileComplete(user) {
  return Boolean(user?.phone && user?.address);
}

function formatDate(value, lang = "uz") {
  try {
    return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "uz-UZ", {
      timeZone: "Asia/Tashkent",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(new Date(value));
  } catch { return String(value || "—"); }
}

function userLabel(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ");
  return name || (user?.username ? `@${user.username}` : String(user?.telegram_id || "—"));
}

async function showHome(env, chatId, lang) {
  const caption = L(lang,
    `⚡️ <b>${BOT_NAME}</b>\n\nInternet, tariflar, texnik yordam, to‘lov, abonent bo‘limi va murojaatlar — <b>hammasi shu bot ichida</b>.\n\n👇 Kerakli xizmatni tanlang:`,
    `⚡️ <b>${BOT_NAME}</b>\n\nИнтернет, тарифы, техподдержка, платежи, абонентский отдел и обращения — <b>всё внутри этого бота</b>.\n\n👇 Выберите нужную услугу:`
  );
  try {
    await sendChatAction(env, chatId, "upload_photo");
    await sendPhoto(env, chatId, MEDIA.homeBanner, caption, { reply_markup: homeKeyboard(lang) });
  } catch {
    await sendMessage(env, chatId, caption, { reply_markup: homeKeyboard(lang) });
  }
}

async function showProfile(env, chatId, user) {
  const lang = user.language || "uz";
  const text = [
    `👤 <b>${L(lang, "Mening profilim", "Мой профиль")}</b>`,
    "",
    `🙍 ${escapeHtml(userLabel(user))}`,
    `🔐 ${L(lang, "Login/shartnoma", "Логин/договор")}: <code>${escapeHtml(user.account_login || "—")}</code>`,
    `📍 ${L(lang, "Manzil", "Адрес")}: ${escapeHtml(user.address || "—")}`,
    `📞 ${L(lang, "Telefon", "Телефон")}: <b>${escapeHtml(user.phone || "—")}</b>`,
    "",
    profileComplete(user)
      ? L(lang, "✅ Keyingi murojaatlarda bu ma’lumotlarni bir bosishda ishlatishingiz mumkin.", "✅ Эти данные можно использовать в новых обращениях одним нажатием.")
      : L(lang, "⚠️ Profilni to‘ldirsangiz, keyingi murojaatlar ancha tez yaratiladi.", "⚠️ Заполните профиль — новые обращения будут создаваться намного быстрее.")
  ].join("\n");
  await sendMessage(env, chatId, text, { reply_markup: inlineKeyboard([
    [{ text: L(lang, "✏️ Profilni tahrirlash", "✏️ Изменить профиль"), callback_data: "profile:edit" }],
    [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
  ]) });
}

async function beginProfileEdit(env, user, chatId) {
  const lang = user.language || "uz";
  await setFlow(env, user.telegram_id, "profile_account", {});
  await sendMessage(env, chatId, L(lang,
    "🔐 <b>Login yoki shartnoma raqami</b>\n\nBilmasangiz <code>-</code> yuboring. Parol yubormang.",
    "🔐 <b>Логин или номер договора</b>\n\nЕсли не знаете — отправьте <code>-</code>. Пароль не отправляйте."
  ));
}

async function finishProfile(env, user, data, chatId) {
  await updatePortalProfile(env, user.telegram_id, {
    accountLogin: data.accountLogin,
    address: data.address,
    phone: data.phone
  });
  await clearFlow(env, user.telegram_id);
  const updated = await getPortalUser(env, user.telegram_id);
  await sendMessage(env, chatId, L(updated.language || "uz",
    "✅ <b>Profil saqlandi</b>\n\nEndi murojaatlarni tezroq yuborishingiz mumkin.",
    "✅ <b>Профиль сохранён</b>\n\nТеперь обращения можно создавать быстрее."
  ), { reply_markup: homeKeyboard(updated.language || "uz") });
}

async function beginTicket(env, user, chatId, department, category, options = {}) {
  const lang = user.language || "uz";
  const data = {
    department,
    category,
    diagnostics: options.diagnostics || null,
    prefillDescription: options.prefillDescription || null,
    skipAccount: department === "connection"
  };

  if (profileComplete(user)) {
    await setFlow(env, user.telegram_id, "ticket_profile_choice", data);
    const d = departmentMeta(department, lang);
    const c = categoryMeta(category, lang);
    await sendMessage(env, chatId,
      `${d.icon} <b>${escapeHtml(d.title)}</b>\n${c.icon} ${escapeHtml(c.title)}\n\n${L(lang,
        "Saqlangan profilingizdan foydalanamizmi?",
        "Использовать сохранённые данные профиля?"
      )}\n\n📍 ${escapeHtml(user.address || "—")}\n📞 ${escapeHtml(user.phone || "—")}`,
      { reply_markup: inlineKeyboard([
        [{ text: L(lang, "✅ Profilimdan foydalanish", "✅ Использовать профиль"), callback_data: "flow:use_profile" }],
        [{ text: L(lang, "✏️ Boshqa ma’lumot kiritish", "✏️ Ввести другие данные"), callback_data: "flow:edit_details" }],
        [{ text: L(lang, "❌ Bekor qilish", "❌ Отмена"), callback_data: "flow:cancel" }]
      ]) }
    );
    return;
  }

  if (data.skipAccount) {
    await setFlow(env, user.telegram_id, "ticket_address", data);
    await sendMessage(env, chatId, L(lang,
      "📍 <b>Ulanish manzili</b>\n\nTuman, ko‘cha, uy/xonadonni yozing:",
      "📍 <b>Адрес подключения</b>\n\nУкажите район, улицу, дом/квартиру:"
    ));
  } else {
    await setFlow(env, user.telegram_id, "ticket_account", data);
    await sendMessage(env, chatId, L(lang,
      "🔐 <b>Abonent login yoki shartnoma raqami</b>\n\nBilmasangiz <code>-</code> yuboring.\n⚠️ Parol yubormang.",
      "🔐 <b>Логин абонента или номер договора</b>\n\nЕсли не знаете — отправьте <code>-</code>.\n⚠️ Не отправляйте пароль."
    ));
  }
}

async function askTicketDescription(env, user, data, chatId) {
  const lang = user.language || "uz";
  if (data.prefillDescription) {
    await setFlow(env, user.telegram_id, "ticket_confirm", data);
    const d = departmentMeta(data.department, lang);
    const c = categoryMeta(data.category, lang);
    await sendMessage(env, chatId, [
      `📨 <b>${L(lang, "Murojaatni yuborish", "Отправить обращение")}</b>`,
      "",
      `${d.icon} ${escapeHtml(d.title)}`,
      `${c.icon} ${escapeHtml(c.title)}`,
      `📝 ${escapeHtml(data.prefillDescription)}`,
      "",
      `📍 ${escapeHtml(data.address || "—")}`,
      `📞 ${escapeHtml(data.phone || "—")}`
    ].join("\n"), { reply_markup: inlineKeyboard([
      [{ text: L(lang, "✅ Yuborish", "✅ Отправить"), callback_data: "flow:send_ticket" }],
      [{ text: L(lang, "✏️ Matnni qayta yozish", "✏️ Изменить текст"), callback_data: "flow:rewrite" }],
      [{ text: L(lang, "❌ Bekor qilish", "❌ Отмена"), callback_data: "flow:cancel" }]
    ]) });
    return;
  }
  await setFlow(env, user.telegram_id, "ticket_description", data);
  await sendMessage(env, chatId, L(lang,
    "✍️ <b>Murojaatingizni yozing</b>\n\nErkin yozing. Masalan: <i>internet yo‘q, ONU’da LOS qizil</i>. Qisqa matn ham qabul qilinadi.",
    "✍️ <b>Напишите обращение</b>\n\nПишите свободно. Например: <i>нет интернета, на ONU красный LOS</i>. Короткий текст тоже принимается."
  ), { reply_markup: removeKeyboard });
}

async function createTicketFromFlow(env, user, data, description, messageId = null) {
  const ticketNo = await createPortalTicket(env, {
    telegramId: user.telegram_id,
    department: data.department,
    category: data.category,
    description,
    accountLogin: data.accountLogin || user.account_login,
    address: data.address || user.address,
    phone: data.phone || user.phone,
    diagnostics: data.diagnostics,
    priority: inferPriority(data.category, `${data.diagnostics || ""} ${description}`),
    telegramMessageId: messageId
  });
  await clearFlow(env, user.telegram_id);
  await notifyOperators(env, ticketNo);
  return ticketNo;
}

async function notifyOperators(env, ticketNo) {
  const ticket = await getPortalTicket(env, ticketNo);
  if (!ticket) return;
  const user = await getPortalUser(env, ticket.telegram_id);
  const chatId = chatForDepartment(env, ticket.department);
  if (!chatId) return;
  const lang = user?.language || "uz";
  const d = departmentMeta(ticket.department, lang);
  const c = categoryMeta(ticket.category, lang);
  const p = priorityMeta(ticket.priority);
  const text = [
    `${p.icon} <b>${p.label} · ${escapeHtml(ticket.ticket_no)}</b>`,
    "━━━━━━━━━━━━━━",
    `${d.icon} <b>${escapeHtml(d.title)}</b>`,
    `${c.icon} ${escapeHtml(c.title)}`,
    `👤 ${escapeHtml(userLabel(user))} · <code>${ticket.telegram_id}</code>`,
    user?.username ? `🔗 @${escapeHtml(user.username)}` : null,
    `🔐 Login: <code>${escapeHtml(ticket.account_login || "—")}</code>`,
    `📍 ${escapeHtml(ticket.address || "—")}`,
    `📞 ${escapeHtml(ticket.phone || "—")}`,
    ticket.diagnostics ? `🧪 ${escapeHtml(ticket.diagnostics)}` : null,
    `🕒 ${escapeHtml(formatDate(ticket.created_at, lang))}`,
    "",
    `📝 <b>${L(lang, "Murojaat", "Обращение")}:</b>`,
    escapeHtml(ticket.description),
    "",
    "💬 <b>Reply</b> qiling — javob mijozga bot orqali boradi."
  ].filter(Boolean).join("\n");
  const sent = await sendMessage(env, chatId, text, { reply_markup: ticketOperatorKeyboard(ticketNo) });
  await setSupportMessage(env, ticketNo, sent.message_id);
}

async function showTariffSeries(env, chatId, lang) {
  await sendMessage(env, chatId, L(lang,
    "📶 <b>FiberNet tariflari</b>\n\nTarif turini tanlang. Ma’lumotlar bot bazasida saqlanadi va rasmiy manbalardan yangilanadi.",
    "📶 <b>Тарифы FiberNet</b>\n\nВыберите серию. Данные хранятся в боте и обновляются из официальных источников."
  ), { reply_markup: inlineKeyboard([
    [{ text: "⚡ TEZKOR", callback_data: "tariff:tezkor:0" }, { text: "🌐 OnLine", callback_data: "tariff:online:0" }],
    [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
  ]) });
}

async function showTariffs(env, chatId, lang, series, page = 0) {
  const items = await getTariffs(env, series);
  const perPage = 4;
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const slice = items.slice(page * perPage, page * perPage + perPage);
  const body = slice.map(x => [
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
  await sendMessage(env, chatId, `📶 <b>${series === "tezkor" ? "TEZKOR" : "OnLine"}</b>\n\n${body}`, {
    reply_markup: inlineKeyboard([
      nav,
      [{ text: L(lang, "🔄 Tarifni o‘zgartirish bo‘yicha murojaat", "🔄 Обращение по смене тарифа"), callback_data: "ticket:new:subscriber:tariff_change" }],
      [{ text: L(lang, "⬅️ Tarif turlari", "⬅️ Серии тарифов"), callback_data: "home:tariffs" }]
    ])
  });
}

async function showServices(env, chatId, lang) {
  const ruNames = {
    "Wi‑Fi sozlash": "Настройка Wi‑Fi",
    "Kompyuterda tarmoqni sozlash": "Настройка сети на компьютере",
    "LAN sozlash": "Настройка LAN",
    "Tarmoq uskunasi diagnostikasi": "Диагностика сетевого оборудования",
    "IPTV sozlash": "Настройка IPTV",
    "TV/pristavka sozlash": "Настройка ТВ/приставки",
    "Router yetkazib berish": "Доставка роутера",
    "Ustani chaqirish": "Вызов мастера"
  };
  const lines = POPULAR_SERVICES.map(([name, price]) => `• ${escapeHtml(lang === "ru" ? (ruNames[name] || name) : name)} — <b>${escapeHtml(price)}</b>`).join("\n");
  await sendMessage(env, chatId, `${L(lang, "🧰 <b>Qo‘shimcha xizmatlar</b>", "🧰 <b>Дополнительные услуги</b>")}\n\n${lines}\n\n${L(lang, "Kerakli xizmat bo‘yicha murojaatni shu botdan yuboring.", "Заявку на нужную услугу можно отправить прямо в этом боте.")}`, {
    reply_markup: inlineKeyboard([
      [{ text: L(lang, "🎫 Xizmat bo‘yicha murojaat", "🎫 Обращение по услуге"), callback_data: "ticket:new:subscriber:other" }],
      [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
    ])
  });
}

async function showPromo(env, chatId, lang) {
  const caption = L(lang,
    "🎁 <b>FiberNet aksiyalari</b>\n\nAmaldagi takliflar haqida ma’lumotni shu bot ichida ko‘rishingiz va savol bo‘lsa Abonent bo‘limiga murojaat yuborishingiz mumkin.",
    "🎁 <b>Акции FiberNet</b>\n\nАктуальные предложения можно посмотреть прямо в боте. По вопросам создайте обращение в абонентский отдел."
  );
  const photo = lang === "ru" ? MEDIA.promoRu : MEDIA.promoUz;
  try { await sendPhoto(env, chatId, photo, caption, { reply_markup: inlineKeyboard([
    [{ text: L(lang, "👥 Aksiya bo‘yicha savol", "👥 Вопрос по акции"), callback_data: "ticket:new:subscriber:other" }],
    [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
  ]) }); }
  catch { await sendMessage(env, chatId, caption, { reply_markup: homeKeyboard(lang) }); }
}

async function showContacts(env, chatId, lang) {
  const addr = lang === "ru" ? CONTACTS.addressRu : CONTACTS.addressUz;
  await sendMessage(env, chatId, [
    `☎️ <b>${L(lang, "FiberNet aloqa", "Контакты FiberNet")}</b>`,
    "",
    `📞 <b>${CONTACTS.phone}</b>`,
    `🧑‍💻 ${CONTACTS.supportEmail}`,
    `📧 ${CONTACTS.infoEmail}`,
    `📍 ${escapeHtml(addr)}`,
    "",
    L(lang, "🕐 Texnik yordam: 24/7", "🕐 Техподдержка: 24/7"),
    L(lang, "💬 Eng qulay usul — shu botda murojaat qoldirish.", "💬 Самый удобный способ — оставить обращение в этом боте.")
  ].join("\n"), { reply_markup: inlineKeyboard([
    [{ text: L(lang, "🎫 Murojaat yuborish", "🎫 Создать обращение"), callback_data: "home:departments" }],
    [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
  ]) });
}

async function showUserTickets(env, chatId, user) {
  const lang = user.language || "uz";
  const rows = await listPortalTickets(env, user.telegram_id, 10);
  if (!rows.length) {
    await sendMessage(env, chatId, L(lang,
      "📭 <b>Murojaatlar yo‘q</b>\n\nYangi murojaatni bosh menyudan yuborishingiz mumkin.",
      "📭 <b>Обращений нет</b>\n\nНовое обращение можно создать из главного меню."
    ), { reply_markup: homeKeyboard(lang) });
    return;
  }
  const buttons = rows.map(x => [{
    text: `${x.status === "closed" ? "✅" : x.stage === "waiting_customer" ? "⏳" : "🟡"} ${x.ticket_no} · ${stageLabel(x.stage, lang)}`,
    callback_data: `ticket:view:${x.ticket_no}`
  }]);
  buttons.push([{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]);
  await sendMessage(env, chatId, L(lang,
    "📂 <b>Mening murojaatlarim</b>\n\nHolatini ko‘rish uchun murojaatni tanlang:",
    "📂 <b>Мои обращения</b>\n\nВыберите обращение, чтобы посмотреть статус:"
  ), { reply_markup: inlineKeyboard(buttons) });
}

async function showTicket(env, chatId, user, no) {
  const ticket = await getPortalTicket(env, no);
  if (!ticket || String(ticket.telegram_id) !== String(user.telegram_id)) return;
  const lang = user.language || "uz";
  const d = departmentMeta(ticket.department, lang);
  const c = categoryMeta(ticket.category, lang);
  const p = priorityMeta(ticket.priority);
  const body = [
    `🎫 <b>${escapeHtml(ticket.ticket_no)}</b>`,
    `${ticket.status === "closed" ? "✅" : "🟡"} <b>${escapeHtml(stageLabel(ticket.stage, lang))}</b>`,
    `${d.icon} ${escapeHtml(d.title)}`,
    `${c.icon} ${escapeHtml(c.title)}`,
    `${p.icon} ${p.label}`,
    ticket.assigned_name ? `👨‍💻 ${L(lang, "Operator", "Оператор")}: ${escapeHtml(ticket.assigned_name)}` : null,
    `🕒 ${escapeHtml(formatDate(ticket.created_at, lang))}`,
    "",
    `📝 ${escapeHtml(ticket.description)}`
  ].filter(Boolean).join("\n");
  const buttons = [];
  if (ticket.status === "open") buttons.push([{ text: L(lang, "💬 Javob yozish", "💬 Написать ответ"), callback_data: `ticket:reply:${ticket.ticket_no}` }]);
  buttons.push([{ text: L(lang, "⬅️ Murojaatlar", "⬅️ Обращения"), callback_data: "home:tickets" }]);
  await sendMessage(env, chatId, body, { reply_markup: inlineKeyboard(buttons) });
}

async function notifyResolved(env, ticket, closed = false) {
  const user = await getPortalUser(env, ticket.telegram_id);
  if (!user) return;
  const lang = user.language || "uz";
  await sendMessage(env, ticket.telegram_id, L(lang,
    `${closed ? "✅ <b>Murojaat yopildi</b>" : "✅ <b>Muammo hal qilindi deb belgilandi</b>"}\n\n🎫 <code>${ticket.ticket_no}</code>\n\nYordam sifatini baholang:`,
    `${closed ? "✅ <b>Обращение закрыто</b>" : "✅ <b>Обращение отмечено как решённое</b>"}\n\n🎫 <code>${ticket.ticket_no}</code>\n\nОцените качество помощи:`
  ), { reply_markup: inlineKeyboard([[
    { text: "👍", callback_data: `feedback:${ticket.ticket_no}:1` },
    { text: "👎", callback_data: `feedback:${ticket.ticket_no}:0` }
  ], ticket.status === "open" ? [
    { text: L(lang, "💬 Muammo davom etyapti", "💬 Проблема осталась"), callback_data: `ticket:reply:${ticket.ticket_no}` }
  ] : []].filter(r => r.length)) });
}

async function handleProfileState(env, msg, user) {
  const lang = user.language || "uz";
  const data = flowData(user);
  if (user.state === "profile_account") {
    if (!msg.text) return true;
    data.accountLogin = msg.text.trim() === "-" ? null : msg.text.trim().slice(0, 80);
    await setFlow(env, user.telegram_id, "profile_address", data);
    await sendMessage(env, msg.chat.id, L(lang, "📍 Xizmat manzilingizni yozing:", "📍 Укажите адрес услуги:"));
    return true;
  }
  if (user.state === "profile_address") {
    if (!msg.text?.trim()) return true;
    data.address = msg.text.trim().slice(0, 300);
    await setFlow(env, user.telegram_id, "profile_phone", data);
    await sendMessage(env, msg.chat.id, L(lang,
      "📞 Telefon raqamingizni yuboring yoki tugmani bosing:",
      "📞 Отправьте номер телефона или нажмите кнопку:"
    ), { reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер")) });
    return true;
  }
  if (user.state === "profile_phone") {
    const phone = normalizePhone(msg.contact?.phone_number || msg.text || "");
    if (!phone) {
      await sendMessage(env, msg.chat.id, L(lang, "⚠️ Raqamni qayta yuboring.", "⚠️ Отправьте номер ещё раз."), {
        reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер"))
      });
      return true;
    }
    data.phone = phone;
    await finishProfile(env, user, data, msg.chat.id);
    return true;
  }
  return false;
}

async function handleTicketState(env, msg, user) {
  const lang = user.language || "uz";
  const data = flowData(user);
  if (user.state === "ticket_account") {
    if (!msg.text) return true;
    data.accountLogin = msg.text.trim() === "-" ? null : msg.text.trim().slice(0, 80);
    await setFlow(env, user.telegram_id, "ticket_address", data);
    await sendMessage(env, msg.chat.id, L(lang, "📍 Xizmat manzilini yozing:", "📍 Укажите адрес услуги:"));
    return true;
  }
  if (user.state === "ticket_address") {
    if (!msg.text?.trim()) return true;
    data.address = msg.text.trim().slice(0, 300);
    await setFlow(env, user.telegram_id, "ticket_phone", data);
    await sendMessage(env, msg.chat.id, L(lang,
      "📞 Telefon raqamingizni yuboring yoki kontakt tugmasini bosing:",
      "📞 Отправьте номер телефона или нажмите кнопку контакта:"
    ), { reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер")) });
    return true;
  }
  if (user.state === "ticket_phone") {
    const phone = normalizePhone(msg.contact?.phone_number || msg.text || "");
    if (!phone) {
      await sendMessage(env, msg.chat.id, L(lang, "⚠️ Raqamni qayta yuboring.", "⚠️ Отправьте номер ещё раз."), {
        reply_markup: contactKeyboard(L(lang, "📱 O‘z raqamimni yuborish", "📱 Отправить мой номер"))
      });
      return true;
    }
    data.phone = phone;
    await savePortalPhone(env, user.telegram_id, phone);
    // Reuse these details for future tickets too.
    await updatePortalProfile(env, user.telegram_id, {
      accountLogin: data.accountLogin ?? user.account_login,
      address: data.address ?? user.address,
      phone
    });
    await askTicketDescription(env, user, data, msg.chat.id);
    return true;
  }
  if (user.state === "ticket_description") {
    const description = String(msg.text || msg.caption || "").trim();
    if (!description) {
      await sendMessage(env, msg.chat.id, L(lang, "✍️ Murojaat matnini yuboring.", "✍️ Отправьте текст обращения."));
      return true;
    }
    const no = await createTicketFromFlow(env, user, data, description.slice(0, 2000), msg.message_id);
    await sendMessage(env, msg.chat.id, L(lang,
      `✅ <b>Murojaat yuborildi</b>\n\n🎫 ID: <code>${no}</code>\nOperator holatni shu bot orqali yangilaydi va javob ham shu yerga keladi.`,
      `✅ <b>Обращение отправлено</b>\n\n🎫 ID: <code>${no}</code>\nСтатус и ответ оператора придут сюда, в этот бот.`
    ), { reply_markup: homeKeyboard(lang) });
    return true;
  }
  if (user.state === "ticket_reply") {
    const ticket = await getPortalTicket(env, data.ticketNo);
    if (!ticket || String(ticket.telegram_id) !== String(user.telegram_id) || ticket.status !== "open") {
      await clearFlow(env, user.telegram_id);
      await sendMessage(env, msg.chat.id, L(lang, "⚠️ Murojaat topilmadi yoki yopilgan.", "⚠️ Обращение не найдено или закрыто."));
      return true;
    }
    const operatorChat = chatForDepartment(env, ticket.department);
    const body = String(msg.text || msg.caption || "").trim();
    const header = `💬 <b>${escapeHtml(ticket.ticket_no)} · ${L(lang, "mijoz javobi", "ответ клиента")}</b>${body ? `\n\n${escapeHtml(body)}` : ""}`;
    await sendMessage(env, operatorChat, header, ticket.support_message_id ? { reply_to_message_id: ticket.support_message_id } : {});
    if (!msg.text && (msg.photo || msg.document || msg.video || msg.voice || msg.audio)) {
      try { await copyMessage(env, operatorChat, msg.chat.id, msg.message_id); } catch {}
    }
    await addPortalMessage(env, ticket.ticket_no, "user", user.telegram_id, body || "[attachment]", msg.message_id);
    await setTicketStage(env, ticket.ticket_no, "in_progress");
    await clearFlow(env, user.telegram_id);
    await sendMessage(env, msg.chat.id, L(lang,
      "✅ Javob operatorga yuborildi.",
      "✅ Ответ отправлен оператору."
    ), { reply_markup: inlineKeyboard([
      [{ text: L(lang, "🎫 Murojaatni ko‘rish", "🎫 Открыть обращение"), callback_data: `ticket:view:${ticket.ticket_no}` }],
      [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
    ]) });
    return true;
  }
  return false;
}

async function handleState(env, msg, user) {
  if (!user?.state) return false;
  if (user.state.startsWith("profile_")) return handleProfileState(env, msg, user);
  if (user.state.startsWith("ticket_")) return handleTicketState(env, msg, user);
  return false;
}

async function handleFreeText(env, msg, user) {
  const text = String(msg.text || "").trim();
  if (!text) return;
  const lang = user.language || "uz";
  const intent = classifyText(text);
  if (intent.action === "tariffs") return showTariffSeries(env, msg.chat.id, lang);
  return beginTicket(env, user, msg.chat.id, intent.department, intent.category, { prefillDescription: text });
}

async function handlePrivateMessage(env, msg) {
  let user = await upsertPortalUser(env, msg.from);
  const lang = user.language || "uz";
  const text = String(msg.text || "").trim();

  if (text === "/start") {
    await clearFlow(env, msg.from.id);
    if (!user.language) {
      await sendMessage(env, msg.chat.id, "🌐 <b>Tilni tanlang / Выберите язык</b>", { reply_markup: languageKeyboard() });
      return;
    }
    await showHome(env, msg.chat.id, user.language);
    return;
  }
  if (text === "/cancel") {
    await clearFlow(env, msg.from.id);
    await sendMessage(env, msg.chat.id, L(lang, "❎ Amal bekor qilindi.", "❎ Действие отменено."), { reply_markup: removeKeyboard });
    await showHome(env, msg.chat.id, lang);
    return;
  }
  if (text === "/profile") return showProfile(env, msg.chat.id, user);
  if (text === "/tickets") return showUserTickets(env, msg.chat.id, user);
  if (text === "/language") return sendMessage(env, msg.chat.id, "🌐 <b>Til / Язык</b>", { reply_markup: languageKeyboard() });
  if (text === "/help") {
    await sendMessage(env, msg.chat.id, L(lang,
      "ℹ️ <b>FiberNet bot yordam</b>\n\nSiz oddiy matn bilan ham yozishingiz mumkin: <i>internet yo‘q</i>, <i>to‘lov tushmadi</i>, <i>ulanish kerak</i>. Bot murojaatni kerakli bo‘limga yo‘naltiradi.\n\n/start — bosh menyu\n/profile — profil\n/tickets — murojaatlar\n/cancel — joriy amalni bekor qilish",
      "ℹ️ <b>Помощь FiberNet Bot</b>\n\nМожно просто написать: <i>нет интернета</i>, <i>платёж не зачислен</i>, <i>нужно подключение</i>. Бот направит обращение в нужный отдел.\n\n/start — главное меню\n/profile — профиль\n/tickets — обращения\n/cancel — отмена"
    ), { reply_markup: homeKeyboard(lang) });
    return;
  }

  user = await getPortalUser(env, msg.from.id);
  if (await handleState(env, msg, user)) return;
  await handleFreeText(env, msg, user);
}

async function handleOperatorMessage(env, msg) {
  const text = String(msg.text || "").trim();
  let ticket = null;
  if (msg.reply_to_message?.message_id) ticket = await getTicketBySupportMessage(env, msg.reply_to_message.message_id);

  if (ticket && ticket.status === "open" && !text.startsWith("/")) {
    const user = await getPortalUser(env, ticket.telegram_id);
    const lang = user?.language || "uz";
    const body = String(msg.text || msg.caption || "").trim();
    if (body) {
      await sendMessage(env, ticket.telegram_id,
        `👨‍💻 <b>FiberNet ${L(lang, "operatori", "оператор")}</b>\n\n${escapeHtml(body)}`,
        { reply_markup: inlineKeyboard([[{ text: L(lang, "💬 Javob yozish", "💬 Ответить"), callback_data: `ticket:reply:${ticket.ticket_no}` }]]) }
      );
    } else {
      try { await copyMessage(env, ticket.telegram_id, msg.chat.id, msg.message_id); } catch {}
      await sendMessage(env, ticket.telegram_id, L(lang,
        `👨‍💻 Operator <code>${ticket.ticket_no}</code> murojaatingizga fayl/media yubordi.`,
        `👨‍💻 Оператор отправил файл/медиа по обращению <code>${ticket.ticket_no}</code>.`
      ), { reply_markup: inlineKeyboard([[{ text: L(lang, "💬 Javob yozish", "💬 Ответить"), callback_data: `ticket:reply:${ticket.ticket_no}` }]]) });
    }
    await addPortalMessage(env, ticket.ticket_no, "operator", msg.from.id, body || "[attachment]", msg.message_id);
    await assignTicket(env, ticket.ticket_no, { id: msg.from.id, name: operatorName(msg.from) });
    await setTicketStage(env, ticket.ticket_no, "in_progress", { id: msg.from.id, name: operatorName(msg.from) });
    return;
  }

  if (text === "/queue" || text === "/tickets") {
    const rows = await listQueue(env, 20);
    const body = rows.length ? rows.map(x => {
      const p = priorityMeta(x.priority);
      return `${p.icon} <b>${escapeHtml(x.ticket_no)}</b> · ${escapeHtml(x.department || "tech")} · ${escapeHtml(x.stage || "new")}\n${escapeHtml((x.description || "").slice(0, 120))}`;
    }).join("\n\n") : "✅ Ochiq murojaatlar yo‘q.";
    await sendMessage(env, msg.chat.id, `📥 <b>FiberNet Queue</b>\n\n${body}`);
    return;
  }

  if (text === "/stats") {
    const s = await advancedStats(env);
    await sendMessage(env, msg.chat.id, [
      "📊 <b>FiberNet Support Stats</b>", "",
      `📚 Total: <b>${s.total || 0}</b>`,
      `🟡 Open: <b>${s.open || 0}</b>`,
      `🆕 New: <b>${s.new_count || 0}</b>`,
      `👨‍💻 In progress: <b>${s.in_progress || 0}</b>`,
      `⏳ Waiting client: <b>${s.waiting_customer || 0}</b>`,
      `✅ Closed: <b>${s.closed || 0}</b>`,
      `👍 Positive: <b>${s.positive || 0}</b>`,
      `👎 Negative: <b>${s.negative || 0}</b>`
    ].join("\n"));
    return;
  }

  const close = text.match(/^\/close\s+(FN-[A-Z0-9-]+)$/i);
  if (close) {
    const no = close[1].toUpperCase();
    if (await closePortalTicket(env, no, msg.from.id)) {
      const t = await getPortalTicket(env, no);
      await notifyResolved(env, t, true);
      await sendMessage(env, msg.chat.id, `✅ ${escapeHtml(no)} yopildi.`);
    } else await sendMessage(env, msg.chat.id, "⚠️ Ticket topilmadi yoki allaqachon yopilgan.");
    return;
  }

  if (text === "/help" || text === "/admin") {
    await sendMessage(env, msg.chat.id, "🛠 <b>FiberNet Operator</b>\n\n/queue — navbat\n/stats — statistika\n/close FN-... — yopish\n\nEng tez usul: ticket xabariga Reply qiling.");
  }
}

async function handleCallback(env, q) {
  try { await answerCallback(env, q.id); } catch {}
  let user = await upsertPortalUser(env, q.from);
  const lang = user.language || "uz";
  const data = q.data || "";
  const chatId = q.message.chat.id;

  if (data === "noop") return;

  if (isOperatorChat(env, chatId) && data.startsWith("op:")) {
    const [, action, no] = data.split(":");
    const ticket = await getPortalTicket(env, no);
    if (!ticket || ticket.status !== "open") return;
    const op = { id: q.from.id, name: operatorName(q.from) };
    if (action === "claim") {
      await assignTicket(env, no, op);
      await sendMessage(env, chatId, `👨‍💻 ${escapeHtml(op.name)} · ${escapeHtml(no)} ni qabul qildi.`);
    } else if (action === "wait") {
      await assignTicket(env, no, op);
      await setTicketStage(env, no, "waiting_customer", op);
      const u = await getPortalUser(env, ticket.telegram_id);
      await sendMessage(env, ticket.telegram_id, L(u?.language || "uz",
        `⏳ Operator <code>${no}</code> bo‘yicha sizning javobingizni kutmoqda.`,
        `⏳ Оператор ожидает ваш ответ по обращению <code>${no}</code>.`
      ), { reply_markup: inlineKeyboard([[{ text: L(u?.language || "uz", "💬 Javob yozish", "💬 Ответить"), callback_data: `ticket:reply:${no}` }]]) });
    } else if (action === "resolve") {
      await assignTicket(env, no, op);
      await setTicketStage(env, no, "resolved", op);
      await notifyResolved(env, await getPortalTicket(env, no), false);
    } else if (action === "close") {
      if (await closePortalTicket(env, no, q.from.id)) await notifyResolved(env, await getPortalTicket(env, no), true);
      try { await editReplyMarkup(env, chatId, q.message.message_id); } catch {}
    }
    return;
  }

  if (data.startsWith("lang:")) {
    const next = data.endsWith(":ru") || data === "lang:ru" ? "ru" : "uz";
    await setPortalLanguage(env, q.from.id, next);
    await clearFlow(env, q.from.id);
    await showHome(env, chatId, next);
    return;
  }

  if (data === "home:main") { await clearFlow(env, q.from.id); return showHome(env, chatId, lang); }
  if (data === "home:language") return sendMessage(env, chatId, "🌐 <b>Til / Язык</b>", { reply_markup: languageKeyboard() });
  if (data === "home:tech") return sendMessage(env, chatId, L(lang, "📡 <b>Texnik yordam</b>\n\nMuammo turini tanlang:", "📡 <b>Техподдержка</b>\n\nВыберите тип проблемы:"), { reply_markup: techKeyboard(lang) });
  if (data === "home:departments") return sendMessage(env, chatId, L(lang, "🎫 <b>Qaysi bo‘limga murojaat qilmoqchisiz?</b>", "🎫 <b>В какой отдел хотите обратиться?</b>"), { reply_markup: departmentsKeyboard(lang) });
  if (data === "home:accounting") return sendMessage(env, chatId, L(lang, "💳 <b>Buxgalteriya</b>\n\nSavol turini tanlang:", "💳 <b>Бухгалтерия</b>\n\nВыберите тему:"), { reply_markup: accountingKeyboard(lang) });
  if (data === "home:subscriber") return sendMessage(env, chatId, L(lang, "👥 <b>Abonent bo‘limi</b>\n\nSavol turini tanlang:", "👥 <b>Абонентский отдел</b>\n\nВыберите тему:"), { reply_markup: subscriberKeyboard(lang) });
  if (data === "home:profile") return showProfile(env, chatId, user);
  if (data === "home:tickets") return showUserTickets(env, chatId, user);
  if (data === "home:tariffs") return showTariffSeries(env, chatId, lang);
  if (data === "home:services") return showServices(env, chatId, lang);
  if (data === "home:promo") return showPromo(env, chatId, lang);
  if (data === "home:contacts") return showContacts(env, chatId, lang);

  if (data === "profile:edit") return beginProfileEdit(env, user, chatId);

  if (data.startsWith("diag:")) {
    const category = data.slice(5);
    const text = diagnosticText(lang, category);
    await sendMessage(env, chatId, text, { reply_markup: inlineKeyboard([
      [{ text: L(lang, "🎫 Operatorga murojaat", "🎫 Обращение оператору"), callback_data: `ticket:new:tech:${category}` }],
      [{ text: L(lang, "✅ Hal bo‘ldi", "✅ Проблема решена"), callback_data: "home:main" }],
      [{ text: L(lang, "⬅️ Texnik yordam", "⬅️ Техподдержка"), callback_data: "home:tech" }]
    ]) });
    return;
  }

  if (data.startsWith("ticket:new:")) {
    const [, , department, category] = data.split(":");
    return beginTicket(env, user, chatId, department, category, {
      diagnostics: department === "tech" ? diagnosticText(lang, category).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) : null
    });
  }

  if (data === "flow:use_profile") {
    const fd = flowData(user);
    fd.accountLogin = user.account_login || null;
    fd.address = user.address || null;
    fd.phone = user.phone || null;
    return askTicketDescription(env, user, fd, chatId);
  }
  if (data === "flow:edit_details") {
    const fd = flowData(user);
    if (fd.skipAccount) {
      await setFlow(env, user.telegram_id, "ticket_address", fd);
      return sendMessage(env, chatId, L(lang, "📍 Ulanish manzilini yozing:", "📍 Укажите адрес подключения:"));
    }
    await setFlow(env, user.telegram_id, "ticket_account", fd);
    return sendMessage(env, chatId, L(lang, "🔐 Login/shartnoma raqamini yuboring. Bilmasangiz <code>-</code>.", "🔐 Отправьте логин/номер договора. Если не знаете — <code>-</code>."));
  }
  if (data === "flow:rewrite") {
    const fd = flowData(user);
    fd.prefillDescription = null;
    return askTicketDescription(env, user, fd, chatId);
  }
  if (data === "flow:send_ticket") {
    const fd = flowData(user);
    if (!fd.prefillDescription) return;
    const no = await createTicketFromFlow(env, user, fd, fd.prefillDescription);
    await sendMessage(env, chatId, L(lang,
      `✅ <b>Murojaat yuborildi</b>\n\n🎫 ID: <code>${no}</code>`,
      `✅ <b>Обращение отправлено</b>\n\n🎫 ID: <code>${no}</code>`
    ), { reply_markup: homeKeyboard(lang) });
    return;
  }
  if (data === "flow:cancel") {
    await clearFlow(env, user.telegram_id);
    return showHome(env, chatId, lang);
  }

  if (data.startsWith("tariff:")) {
    const [, series, page] = data.split(":");
    return showTariffs(env, chatId, lang, series, Number(page));
  }

  if (data.startsWith("ticket:view:")) return showTicket(env, chatId, user, data.slice("ticket:view:".length));
  if (data.startsWith("ticket:reply:")) {
    const no = data.slice("ticket:reply:".length);
    const ticket = await getPortalTicket(env, no);
    if (!ticket || String(ticket.telegram_id) !== String(user.telegram_id) || ticket.status !== "open") return;
    await setFlow(env, user.telegram_id, "ticket_reply", { ticketNo: no });
    await sendMessage(env, chatId, L(lang,
      `💬 <b>${escapeHtml(no)}</b>\n\nJavobingizni yozing. Matn, rasm yoki fayl yuborishingiz mumkin.`,
      `💬 <b>${escapeHtml(no)}</b>\n\nНапишите ответ. Можно отправить текст, фото или файл.`
    ));
    return;
  }

  if (data.startsWith("feedback:")) {
    const [, no, score] = data.split(":");
    const ticket = await getPortalTicket(env, no);
    if (!ticket || String(ticket.telegram_id) !== String(user.telegram_id)) return;
    await setSatisfaction(env, no, user.telegram_id, Number(score));
    await sendMessage(env, chatId, L(lang, "💙 Rahmat! Bahoyingiz qabul qilindi.", "💙 Спасибо! Оценка принята."), { reply_markup: homeKeyboard(lang) });
  }
}

async function processUpdate(env, update) {
  if (!await claimUpdate(env, update.update_id)) return;
  try {
    if (update.callback_query) await handleCallback(env, update.callback_query);
    else if (update.message) {
      if (isPrivate(update.message)) await handlePrivateMessage(env, update.message);
      else if (isOperatorChat(env, update.message.chat.id)) await handleOperatorMessage(env, update.message);
    }
  } catch (err) {
    await releaseUpdate(env, update.update_id);
    throw err;
  }
}

async function webhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  let update;
  try { update = await request.json(); }
  catch { return new Response("Bad Request", { status: 400 }); }
  if (!Number.isInteger(update.update_id)) return new Response("ok");
  await ensurePortalSchema(env);
  await processUpdate(env, update);
  return new Response("ok");
}

async function runSlaCheck(env) {
  await ensurePortalSchema(env);
  const rows = await staleTickets(env, 30, 20);
  for (const ticket of rows) {
    const chatId = chatForDepartment(env, ticket.department);
    if (!chatId) continue;
    const p = priorityMeta(ticket.priority);
    await sendMessage(env, chatId,
      `⏰ <b>SLA reminder</b>\n\n${p.icon} <code>${escapeHtml(ticket.ticket_no)}</code> · ${escapeHtml(ticket.stage || "new")}\n🕒 ${escapeHtml(formatDate(ticket.created_at, "uz"))}\n\n${escapeHtml((ticket.description || "").slice(0, 300))}`,
      ticket.support_message_id ? { reply_to_message_id: ticket.support_message_id } : {}
    );
    await markSlaNotified(env, ticket.ticket_no);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      try { return await webhook(request, env); }
      catch (err) {
        console.error("FiberNet v3 webhook error", String(err));
        return new Response("Retry", { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        await ensurePortalSchema(env);
        const sources = await getSourceStatus(env);
        const stats = await advancedStats(env);
        return Response.json({ ok: true, service: "fibernet-bot", version: VERSION, portal: true, stats, sources });
      } catch (err) {
        return Response.json({ ok: false, version: VERSION, error: String(err) }, { status: 503 });
      }
    }
    if (url.pathname === "/") return new Response(`FiberNet Customer Portal Bot v${VERSION} is running.`);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      if (controller.cron === "15 23 * * *") {
        await syncOfficialSources(env);
        await cleanupProcessedUpdates(env);
      } else {
        await runSlaCheck(env);
      }
    })());
  }
};
