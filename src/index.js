import { CONTACTS, DIAGNOSTICS, MEDIA, POPULAR_SERVICES, URLS } from "./config.js";
import { t } from "./i18n.js";
import {
  addTicketMessage,
  claimUpdate,
  cleanupProcessedUpdates,
  clearState,
  closeTicket,
  createTicket,
  getTicket,
  getTicketBySupportMessage,
  getUser,
  listOpenTickets,
  listUserTickets,
  parseStateData,
  releaseUpdate,
  savePhone,
  setLanguage,
  setState,
  setSupportMessageId,
  ticketStats,
  upsertUser
} from "./db.js";
import { getSourceStatus, getTariffs, syncOfficialSources } from "./catalog.js";
import {
  answerCallback,
  contactKeyboard,
  editCaption,
  editMessage,
  editReplyMarkup,
  escapeHtml,
  inlineKeyboard,
  removeKeyboard,
  sendChatAction,
  sendMessage,
  sendPhoto
} from "./telegram.js";

const VERSION = "2.0.0";
const L = (lang, uz, ru) => lang === "ru" ? ru : uz;
const supportChat = (env, id) => String(id) === String(env.SUPPORT_CHAT_ID);
const isAdmin = (env, userId, chatId) => supportChat(env, chatId) || String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).includes(String(userId));

const categoryLabel = (cat, lang) => ({
  no_internet: L(lang, "Internet yo‘q", "Нет интернета"),
  slow: L(lang, "Internet sekin", "Низкая скорость"),
  wifi: "Wi‑Fi",
  iptv: "IPTV / TV",
  billing: L(lang, "To‘lov / kabinet", "Оплата / кабинет"),
  other: L(lang, "Boshqa muammo", "Другая проблема"),
  connection: L(lang, "Ulanish", "Подключение")
}[cat] || cat);

const statusLabel = (status, lang) => status === "closed"
  ? L(lang, "Yopilgan", "Закрыта")
  : L(lang, "Ochiq", "Открыта");

const priorityMeta = priority => ({
  critical: { emoji: "🚨", label: "CRITICAL" },
  high: { emoji: "🔴", label: "HIGH" },
  normal: { emoji: "🟡", label: "NORMAL" },
  low: { emoji: "🟢", label: "LOW" }
}[priority] || { emoji: "🟡", label: "NORMAL" });

const homeKeyboard = lang => inlineKeyboard([
  [{ text: t(lang, "tariffs"), callback_data: "menu:tariffs" }, { text: t(lang, "support"), callback_data: "menu:support" }],
  [{ text: t(lang, "connect"), callback_data: "menu:connect" }, { text: t(lang, "promotions"), callback_data: "menu:promo" }],
  [{ text: t(lang, "cabinet"), callback_data: "menu:cabinet" }, { text: t(lang, "tickets"), callback_data: "menu:tickets" }],
  [{ text: t(lang, "speedTest"), url: URLS.speed }, { text: t(lang, "faq"), url: URLS.faq }],
  [{ text: t(lang, "contacts"), callback_data: "menu:contacts" }, { text: t(lang, "services"), callback_data: "menu:services" }],
  [{ text: t(lang, "language"), callback_data: "menu:language" }]
]);

const languageKeyboard = () => inlineKeyboard([
  [{ text: "🇺🇿 O‘zbekcha", callback_data: "lang:uz" }, { text: "🇷🇺 Русский", callback_data: "lang:ru" }]
]);

const backKeyboard = lang => inlineKeyboard([[{ text: t(lang, "back"), callback_data: "menu:home" }]]);

const supportKeyboard = lang => inlineKeyboard([
  [{ text: t(lang, "noInternet"), callback_data: "support:no_internet" }, { text: t(lang, "slow"), callback_data: "support:slow" }],
  [{ text: t(lang, "wifi"), callback_data: "support:wifi" }, { text: t(lang, "iptv"), callback_data: "support:iptv" }],
  [{ text: t(lang, "billing"), callback_data: "support:billing" }, { text: t(lang, "other"), callback_data: "support:other" }],
  [{ text: t(lang, "back"), callback_data: "menu:home" }]
]);

const diagKeyboard = (lang, cat, extraRows = []) => inlineKeyboard([
  ...extraRows,
  [{ text: t(lang, "solved"), callback_data: `diag:${cat}:solved` }],
  [{ text: t(lang, "openTicket"), callback_data: `diag:${cat}:ticket` }],
  [{ text: t(lang, "back"), callback_data: "menu:support" }]
]);

function normalizePhone(value) {
  const raw = String(value || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 9) digits = `998${digits}`;
  if (digits.length === 12 && digits.startsWith("998")) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

function formatDate(value, lang = "uz") {
  try {
    return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "uz-UZ", {
      timeZone: "Asia/Tashkent",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return String(value || "—");
  }
}

function inferPriority(category, description = "") {
  const text = String(description).toLowerCase();
  if (category === "connection") return "low";
  if (/\blos\b|красн.*los|los.*красн|qizil.*los|los.*qizil|обрыв|uzil|авари/.test(text)) return "critical";
  if (category === "no_internet") return "high";
  if (category === "iptv" && /all|barcha|все канал/.test(text)) return "high";
  return "normal";
}

async function renderPanel(env, message, text, replyMarkup) {
  const chatId = message.chat.id;
  const extra = { reply_markup: replyMarkup };
  try {
    if (message.photo?.length && text.length <= 950) {
      return await editCaption(env, chatId, message.message_id, text, extra);
    }
    if (!message.photo?.length) {
      return await editMessage(env, chatId, message.message_id, text, extra);
    }
  } catch (err) {
    if (String(err).toLowerCase().includes("message is not modified")) return null;
  }
  return sendMessage(env, chatId, text, extra);
}

async function showHome(env, chatId, lang, message = null) {
  const caption = t(lang, "welcome");
  if (message) return renderPanel(env, message, caption, homeKeyboard(lang));
  try {
    await sendChatAction(env, chatId, "upload_photo");
    return await sendPhoto(env, chatId, MEDIA.homeBanner, caption, { reply_markup: homeKeyboard(lang) });
  } catch (err) {
    console.warn("Home banner fallback:", String(err));
    return sendMessage(env, chatId, caption, { reply_markup: homeKeyboard(lang) });
  }
}

async function showPromo(env, chatId, lang) {
  const photo = lang === "ru" ? MEDIA.promoRu : MEDIA.promoUz;
  const url = lang === "ru" ? URLS.promotionsRu : URLS.promotionsUz;
  const keyboard = inlineKeyboard([
    [{ text: L(lang, "📖 Shartlarni ko‘rish", "📖 Условия акции"), url }],
    [{ text: t(lang, "home"), callback_data: "menu:home" }]
  ]);
  try {
    await sendChatAction(env, chatId, "upload_photo");
    return await sendPhoto(env, chatId, photo, t(lang, "promoCaption"), { reply_markup: keyboard });
  } catch (err) {
    console.warn("Promo image fallback:", String(err));
    return sendMessage(env, chatId, t(lang, "promoCaption"), { reply_markup: keyboard });
  }
}

function serviceName(lang, name) {
  if (lang !== "ru") return name;
  return ({
    "Wi‑Fi sozlash": "Настройка Wi‑Fi",
    "Kompyuterda tarmoqni sozlash": "Настройка сети на компьютере",
    "LAN sozlash": "Настройка LAN",
    "Tarmoq uskunasi diagnostikasi": "Диагностика сетевого оборудования",
    "IPTV sozlash": "Настройка IPTV",
    "TV/pristavka sozlash": "Настройка ТВ/приставки",
    "Router yetkazib berish": "Доставка роутера",
    "Ustani chaqirish": "Вызов мастера"
  })[name] || name;
}

async function showTariffPage(env, q, lang, series, requestedPage = 0) {
  if (!["tezkor", "online"].includes(series)) return showHome(env, q.message.chat.id, lang, q.message);
  const items = await getTariffs(env, series);
  const perPage = 4;
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const slice = items.slice(page * perPage, page * perPage + perPage);
  const money = n => Number(n || 0).toLocaleString("ru-RU");
  const lines = slice.map(x => {
    const tv = x.tv ? `\n📺 TV: ${escapeHtml(x.tv)}+` : "";
    return `⚡ <b>${escapeHtml(x.name)}</b>\n💳 ${money(x.price)} ${L(lang, "so‘m/oy", "сум/мес")}\n🌙 18:00–00:00 — <b>${escapeHtml(x.evening || "—")} Mbit/s</b>\n☀️ 00:00–18:00 — <b>${escapeHtml(x.daytime || "—")} Mbit/s</b>${tv}`;
  }).join("\n\n");
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️", callback_data: `tariff:${series}:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: "noop" });
  if (page < pages - 1) nav.push({ text: "➡️", callback_data: `tariff:${series}:${page + 1}` });
  const sourceUrl = series === "tezkor" ? URLS.tezkor : URLS.online;
  const keyboard = inlineKeyboard([
    nav,
    [{ text: t(lang, "allTariffs"), url: sourceUrl }],
    [{ text: t(lang, "back"), callback_data: "menu:tariffs" }]
  ]);
  const title = series === "tezkor" ? "TEZKOR" : "OnLine";
  const body = `📶 <b>${title}</b>\n\n${lines}\n\n${t(lang, "officialSource")}`;
  return renderPanel(env, q.message, body, keyboard);
}

function diagnosticText(lang, category, variant) {
  if (category === "no_internet" && !variant) {
    return L(lang,
      "🚫 <b>Internet yo‘q</b>\n\nONU/ONT qurilmangizdagi <b>LOS</b> indikatori qanday?",
      "🚫 <b>Нет интернета</b>\n\nКак ведёт себя индикатор <b>LOS</b> на ONU/ONT?"
    );
  }
  if (category === "no_internet" && variant === "los") {
    return L(lang,
      "🚨 <b>LOS qizil yonmoqda</b>\n\nBu optik signal yo‘qligini ko‘rsatishi mumkin. Optik kabelni bukmang va ajratmang. Operatorga murojaat ochishni tavsiya qilamiz.",
      "🚨 <b>LOS горит красным</b>\n\nЭто может означать отсутствие оптического сигнала. Не сгибайте и не отсоединяйте оптоволокно. Рекомендуем создать обращение оператору."
    );
  }
  if (category === "slow" && !variant) {
    return L(lang,
      "🐢 <b>Internet sekin</b>\n\nMuammo qaysi ulanishda ko‘proq seziladi?",
      "🐢 <b>Низкая скорость</b>\n\nНа каком подключении проблема заметнее?"
    );
  }
  if (category === "slow" && variant === "wifi") {
    return `${DIAGNOSTICS[lang].slow}\n\n${L(lang, "📡 Avval 5 GHz tarmoqda, routerga yaqin joyda test qiling.", "📡 Сначала проверьте 5 GHz рядом с роутером.")}`;
  }
  if (category === "slow" && variant === "cable") {
    return `${DIAGNOSTICS[lang].slow}\n\n${L(lang, "🔌 Kabel orqali ham sekin bo‘lsa, speed test natijasini ticketga yozing.", "🔌 Если медленно и по кабелю, укажите результат speed test в обращении.")}`;
  }
  if (category === "wifi" && !variant) {
    return L(lang,
      "📡 <b>Wi‑Fi muammosi</b>\n\nAsosiy muammo qaysi?",
      "📡 <b>Проблема Wi‑Fi</b>\n\nЧто беспокоит больше?"
    );
  }
  if (category === "wifi" && variant === "range") {
    return `${DIAGNOSTICS[lang].wifi}\n\n${L(lang, "📍 Signal uzoq xonalarda pasaysa, routerni markaziy va ochiq joyga ko‘chirish foydali.", "📍 Если сигнал слабый в дальних комнатах, лучше разместить роутер ближе к центру квартиры и открыто.")}`;
  }
  if (category === "wifi" && variant === "drops") {
    return `${DIAGNOSTICS[lang].wifi}\n\n${L(lang, "🔄 Uzilib-ulanish davom etsa, 2.4/5 GHz tarmoqlarini alohida nomlab tekshirib ko‘ring.", "🔄 Если соединение обрывается, попробуйте разделить имена сетей 2.4/5 GHz и проверить каждую отдельно.")}`;
  }
  if (category === "iptv" && !variant) {
    return L(lang,
      "📺 <b>IPTV / TV</b>\n\nMuammo barcha kanallardami yoki faqat bittasida?",
      "📺 <b>IPTV / ТВ</b>\n\nПроблема на всех каналах или только на одном?"
    );
  }
  if (category === "iptv" && variant === "all") {
    return `${DIAGNOSTICS[lang].iptv}\n\n${L(lang, "⚠️ Barcha kanallarda muammo bo‘lsa, internet va router holatini ham tekshiring.", "⚠️ Если проблема на всех каналах, также проверьте интернет и роутер.")}`;
  }
  if (category === "iptv" && variant === "one") {
    return `${DIAGNOSTICS[lang].iptv}\n\n${L(lang, "ℹ️ Faqat bitta kanal muammoli bo‘lsa, ticketda kanal nomini yozing.", "ℹ️ Если проблема только на одном канале, укажите его название в обращении.")}`;
  }
  return DIAGNOSTICS[lang]?.[category] || DIAGNOSTICS.uz.other;
}

function diagnosticKeyboard(lang, category, variant = null) {
  if (category === "no_internet" && !variant) {
    return inlineKeyboard([
      [{ text: "🔴 LOS", callback_data: "check:no_internet:los" }, { text: L(lang, "🟢 LOS o‘chiq", "🟢 LOS не горит"), callback_data: "check:no_internet:nolos" }],
      [{ text: t(lang, "openTicket"), callback_data: "diag:no_internet:ticket" }],
      [{ text: t(lang, "back"), callback_data: "menu:support" }]
    ]);
  }
  if (category === "slow" && !variant) {
    return inlineKeyboard([
      [{ text: "📡 Wi‑Fi", callback_data: "check:slow:wifi" }, { text: L(lang, "🔌 Kabel", "🔌 Кабель"), callback_data: "check:slow:cable" }],
      [{ text: t(lang, "speedTest"), url: URLS.speed }],
      [{ text: t(lang, "back"), callback_data: "menu:support" }]
    ]);
  }
  if (category === "wifi" && !variant) {
    return inlineKeyboard([
      [{ text: L(lang, "📶 Signal kuchsiz", "📶 Слабый сигнал"), callback_data: "check:wifi:range" }],
      [{ text: L(lang, "🔄 Uzilib qoladi", "🔄 Обрывается"), callback_data: "check:wifi:drops" }],
      [{ text: t(lang, "back"), callback_data: "menu:support" }]
    ]);
  }
  if (category === "iptv" && !variant) {
    return inlineKeyboard([
      [{ text: L(lang, "📺 Barcha kanallar", "📺 Все каналы"), callback_data: "check:iptv:all" }],
      [{ text: L(lang, "1️⃣ Bitta kanal", "1️⃣ Один канал"), callback_data: "check:iptv:one" }],
      [{ text: t(lang, "back"), callback_data: "menu:support" }]
    ]);
  }
  if (category === "billing") {
    return diagKeyboard(lang, category, [[{ text: t(lang, "cabinet"), url: URLS.cabinet }]]);
  }
  if (category === "no_internet" && variant === "los") {
    return inlineKeyboard([
      [{ text: "🚨 " + t(lang, "openTicket"), callback_data: "ticketctx:no_internet:los" }],
      [{ text: t(lang, "back"), callback_data: "support:no_internet" }]
    ]);
  }
  const extras = category === "slow" ? [[{ text: t(lang, "speedTest"), url: URLS.speed }]] : [];
  return diagKeyboard(lang, category, extras);
}

async function notifySupport(env, ticketNo) {
  if (!env.SUPPORT_CHAT_ID || String(env.SUPPORT_CHAT_ID).startsWith("REPLACE_")) return;
  const ticket = await getTicket(env, ticketNo);
  if (!ticket) return;
  const user = await getUser(env, ticket.telegram_id);
  const p = priorityMeta(ticket.priority);
  const text = [
    `${p.emoji} <b>${p.label} · FiberNet ${escapeHtml(ticketNo)}</b>`,
    `━━━━━━━━━━━━━━`,
    `🧩 <b>${escapeHtml(categoryLabel(ticket.category, "uz"))}</b>`,
    `👤 Telegram: <code>${ticket.telegram_id}</code>`,
    user?.username ? `🔗 @${escapeHtml(user.username)}` : null,
    `📞 ${escapeHtml(ticket.phone || user?.phone || "—")}`,
    `📍 ${escapeHtml(ticket.address || "—")}`,
    `🔐 Login: <code>${escapeHtml(ticket.account_login || "—")}</code>`,
    `🕒 ${escapeHtml(formatDate(ticket.created_at, "uz"))}`,
    ``,
    `📝 <b>Muammo:</b>`,
    escapeHtml(ticket.description),
    ``,
    `💬 Shu xabarga <b>Reply</b> qilsangiz, javob abonentga yuboriladi.`
  ].filter(Boolean).join("\n");
  const m = await sendMessage(env, env.SUPPORT_CHAT_ID, text, {
    reply_markup: inlineKeyboard([[{ text: "✅ Ticketni yopish", callback_data: `admin:close:${ticketNo}` }]])
  });
  await setSupportMessageId(env, ticketNo, m.message_id);
}

async function notifyClosed(env, ticketNo) {
  const ticket = await getTicket(env, ticketNo);
  if (!ticket) return;
  const user = await getUser(env, ticket.telegram_id);
  const lang = user?.language || "uz";
  await sendMessage(env, ticket.telegram_id, t(lang, "ticketClosed", { ticket: ticketNo }), {
    reply_markup: inlineKeyboard([[
      { text: t(lang, "feedbackGood"), callback_data: `feedback:${ticketNo}:good` },
      { text: t(lang, "feedbackBad"), callback_data: `feedback:${ticketNo}:bad` }
    ]])
  });
}

async function makeTicket(env, user, data, category, description) {
  const diagnostic = data.diagnostic ? `${L(user.language || "uz", "Diagnostika", "Диагностика")}: ${data.diagnostic}\n\n` : "";
  const fullDescription = `${diagnostic}${description}`.trim();
  const priority = inferPriority(category, fullDescription);
  const no = await createTicket(env, {
    telegramId: user.telegram_id,
    category,
    description: fullDescription,
    accountLogin: data.accountLogin,
    address: data.address,
    phone: data.phone || user.phone,
    priority
  });
  await clearState(env, user.telegram_id);
  await notifySupport(env, no);
  return no;
}

async function relayUserReply(env, user, ticket, body, telegramMessageId) {
  const text = `💬 <b>${escapeHtml(ticket.ticket_no)} · abonent javobi</b>\n\n${escapeHtml(body)}`;
  await sendMessage(env, env.SUPPORT_CHAT_ID, text, ticket.support_message_id ? { reply_to_message_id: ticket.support_message_id } : {});
  await addTicketMessage(env, ticket.ticket_no, "user", user.telegram_id, body, telegramMessageId || null);
}

async function stateFlow(env, msg, user) {
  if (!user?.state) return false;
  const lang = user.language || "uz";
  const d = parseStateData(user);
  const chatId = msg.chat.id;

  if (user.state === "ticket_account") {
    if (!msg.text) return true;
    d.accountLogin = msg.text.trim() === "-" ? null : msg.text.trim().slice(0, 80);
    await setState(env, user.telegram_id, "ticket_address", d);
    await sendMessage(env, chatId, t(lang, "askAddress"));
    return true;
  }

  if (user.state === "ticket_address") {
    if (!msg.text) return true;
    const address = msg.text.trim();
    if (address.length < 6) {
      await sendMessage(env, chatId, t(lang, "invalidAddress"));
      return true;
    }
    d.address = address.slice(0, 300);
    await setState(env, user.telegram_id, "ticket_phone", d);
    await sendMessage(env, chatId, t(lang, "askPhone"), { reply_markup: contactKeyboard(t(lang, "sharePhone")) });
    return true;
  }

  if (user.state === "ticket_phone") {
    const raw = msg.contact?.phone_number || msg.text || "";
    const phone = normalizePhone(raw);
    if (!phone) {
      await sendMessage(env, chatId, t(lang, "invalidPhone"), { reply_markup: contactKeyboard(t(lang, "sharePhone")) });
      return true;
    }
    d.phone = phone;
    await savePhone(env, user.telegram_id, phone);
    await setState(env, user.telegram_id, "ticket_description", d);
    await sendMessage(env, chatId, t(lang, "askDescription"), { reply_markup: removeKeyboard });
    return true;
  }

  if (user.state === "ticket_description") {
    if (!msg.text) return true;
    const description = msg.text.trim();
    if (description.length < 10) {
      await sendMessage(env, chatId, t(lang, "shortDescription"));
      return true;
    }
    const no = await makeTicket(env, user, d, d.category || "other", description.slice(0, 2000));
    await sendMessage(env, chatId, t(lang, "ticketCreated", { ticket: no }), { reply_markup: homeKeyboard(lang) });
    return true;
  }

  if (user.state === "connect_address") {
    if (!msg.text) return true;
    const address = msg.text.trim();
    if (address.length < 6) {
      await sendMessage(env, chatId, t(lang, "invalidAddress"));
      return true;
    }
    d.address = address.slice(0, 300);
    await setState(env, user.telegram_id, "connect_phone", d);
    await sendMessage(env, chatId, t(lang, "connectAskPhone"), { reply_markup: contactKeyboard(t(lang, "sharePhone")) });
    return true;
  }

  if (user.state === "connect_phone") {
    const raw = msg.contact?.phone_number || msg.text || "";
    const phone = normalizePhone(raw);
    if (!phone) {
      await sendMessage(env, chatId, t(lang, "invalidPhone"), { reply_markup: contactKeyboard(t(lang, "sharePhone")) });
      return true;
    }
    d.phone = phone;
    await savePhone(env, user.telegram_id, phone);
    const no = await makeTicket(env, user, d, "connection", L(lang, "Yangi ulanish uchun ariza", "Заявка на новое подключение"));
    await sendMessage(env, chatId, t(lang, "connectCreated", { ticket: no }), { reply_markup: homeKeyboard(lang) });
    return true;
  }

  if (user.state === "ticket_reply") {
    if (!msg.text) return true;
    const body = msg.text.trim();
    if (!body) return true;
    const ticket = await getTicket(env, d.ticketNo);
    if (!ticket || String(ticket.telegram_id) !== String(user.telegram_id) || ticket.status !== "open") {
      await clearState(env, user.telegram_id);
      await sendMessage(env, chatId, L(lang, "⚠️ Murojaat topilmadi yoki yopilgan.", "⚠️ Обращение не найдено или уже закрыто."), { reply_markup: homeKeyboard(lang) });
      return true;
    }
    await relayUserReply(env, user, ticket, body.slice(0, 2000), msg.message_id);
    await clearState(env, user.telegram_id);
    await sendMessage(env, chatId, t(lang, "replySent"), { reply_markup: homeKeyboard(lang) });
    return true;
  }

  return false;
}

async function closeAndNotify(env, ticketNo, closedBy) {
  const ok = await closeTicket(env, ticketNo, closedBy);
  if (ok) await notifyClosed(env, ticketNo);
  return ok;
}

async function adminMessage(env, msg) {
  const text = (msg.text || "").trim();
  let ticket = null;
  if (msg.reply_to_message?.message_id) ticket = await getTicketBySupportMessage(env, msg.reply_to_message.message_id);

  if (ticket && text && !text.startsWith("/")) {
    if (ticket.status !== "open") {
      await sendMessage(env, msg.chat.id, `⚠️ ${escapeHtml(ticket.ticket_no)} yopilgan.`);
      return true;
    }
    const user = await getUser(env, ticket.telegram_id);
    const lang = user?.language || "uz";
    await sendMessage(env, ticket.telegram_id, t(lang, "operatorReply", { message: escapeHtml(text) }), {
      reply_markup: inlineKeyboard([[{ text: t(lang, "replyToTicket"), callback_data: `ticket:reply:${ticket.ticket_no}` }]])
    });
    await addTicketMessage(env, ticket.ticket_no, "operator", msg.from.id, text, msg.message_id);
    return true;
  }

  if (text === "/help" || text === "/admin") {
    await sendMessage(env, msg.chat.id, `🛠 <b>FiberNet Admin</b>\n\n/tickets — ochiq ticketlar\n/stats — statistika\n/sync — rasmiy manbalarni yangilash\n/close FN-... — ticketni yopish\n/reply FN-... matn — abonentga javob`);
    return true;
  }

  if (text === "/tickets") {
    const rows = await listOpenTickets(env, 15);
    const body = rows.length
      ? rows.map(x => { const p = priorityMeta(x.priority); return `${p.emoji} <b>${escapeHtml(x.ticket_no)}</b> · ${escapeHtml(categoryLabel(x.category, "uz"))}\n<code>${escapeHtml((x.description || "").slice(0, 100))}</code>`; }).join("\n\n")
      : "✅ Ochiq ticketlar yo‘q.";
    await sendMessage(env, msg.chat.id, `🎫 <b>Ochiq ticketlar</b>\n\n${body}`);
    return true;
  }

  if (text === "/stats") {
    const s = await ticketStats(env);
    await sendMessage(env, msg.chat.id, `📊 <b>FiberNet statistika</b>\n\n🟡 Open: <b>${s.open_count || 0}</b>\n✅ Closed: <b>${s.closed_count || 0}</b>\n📚 Total: <b>${s.total_count || 0}</b>`);
    return true;
  }

  if (text === "/sync") {
    const r = await syncOfficialSources(env);
    await sendMessage(env, msg.chat.id, `🔄 <b>Sync tugadi</b>\n<code>${escapeHtml(JSON.stringify(r))}</code>`);
    return true;
  }

  const closeMatch = text.match(/^\/close\s+(FN-[A-Z0-9-]+)$/i);
  if (closeMatch) {
    const no = closeMatch[1].toUpperCase();
    const ok = await closeAndNotify(env, no, msg.from.id);
    await sendMessage(env, msg.chat.id, ok ? `✅ ${escapeHtml(no)} yopildi.` : "⚠️ Topilmadi yoki allaqachon yopilgan.");
    return true;
  }

  const replyMatch = text.match(/^\/reply\s+(FN-[A-Z0-9-]+)\s+([\s\S]+)$/i);
  if (replyMatch) {
    const no = replyMatch[1].toUpperCase();
    const body = replyMatch[2].trim();
    const x = await getTicket(env, no);
    if (!x || x.status !== "open") {
      await sendMessage(env, msg.chat.id, "⚠️ Ticket topilmadi yoki yopilgan.");
      return true;
    }
    const user = await getUser(env, x.telegram_id);
    const lang = user?.language || "uz";
    await sendMessage(env, x.telegram_id, t(lang, "operatorReply", { message: escapeHtml(body) }), {
      reply_markup: inlineKeyboard([[{ text: t(lang, "replyToTicket"), callback_data: `ticket:reply:${no}` }]])
    });
    await addTicketMessage(env, no, "operator", msg.from.id, body, msg.message_id);
    await sendMessage(env, msg.chat.id, `✅ ${escapeHtml(no)} ga yuborildi.`);
    return true;
  }

  return false;
}

async function callback(env, q) {
  try { await answerCallback(env, q.id); } catch {}
  const chatId = q.message.chat.id;
  let user = await upsertUser(env, q.from);
  const data = q.data || "";

  if (data === "noop") return;

  if (data.startsWith("lang:")) {
    const lang = data.slice(5) === "ru" ? "ru" : "uz";
    await setLanguage(env, q.from.id, lang);
    await clearState(env, q.from.id);
    user = await getUser(env, q.from.id);
    return showHome(env, chatId, user?.language || lang, q.message);
  }

  const lang = user.language || "uz";

  if (data === "menu:home") return showHome(env, chatId, lang, q.message);
  if (data === "menu:language") return renderPanel(env, q.message, t(lang, "chooseLanguage"), languageKeyboard());
  if (data === "menu:support") return renderPanel(env, q.message, t(lang, "supportChoose"), supportKeyboard(lang));

  if (data === "menu:tariffs") {
    return renderPanel(env, q.message, t(lang, "tariffChoose"), inlineKeyboard([
      [{ text: "⚡ TEZKOR", callback_data: "tariff:tezkor:0" }, { text: "🌐 OnLine", callback_data: "tariff:online:0" }],
      [{ text: t(lang, "back"), callback_data: "menu:home" }]
    ]));
  }

  if (data.startsWith("tariff:")) {
    const [, series, page = "0"] = data.split(":");
    return showTariffPage(env, q, lang, series, Number(page));
  }

  if (data === "menu:connect") {
    await setState(env, q.from.id, "connect_address", {});
    return sendMessage(env, chatId, t(lang, "connectAskAddress"));
  }

  if (data === "menu:promo") return showPromo(env, chatId, lang);

  if (data === "menu:cabinet") {
    return renderPanel(env, q.message, t(lang, "cabinetText"), inlineKeyboard([
      [{ text: t(lang, "cabinet"), url: URLS.cabinet }],
      [{ text: t(lang, "back"), callback_data: "menu:home" }]
    ]));
  }

  if (data === "menu:contacts") {
    const addr = lang === "ru" ? CONTACTS.addressRu : CONTACTS.addressUz;
    const body = `${t(lang, "contactsTitle")}\n\n📞 <b>${CONTACTS.phone}</b>\n📧 ${CONTACTS.infoEmail}\n🧑‍💻 ${CONTACTS.supportEmail}\n📍 ${escapeHtml(addr)}\n\n🕐 ${L(lang, "Texnik yordam: 24/7", "Техподдержка: 24/7")}`;
    return renderPanel(env, q.message, body, inlineKeyboard([
      [{ text: t(lang, "website"), url: lang === "ru" ? URLS.homeRu : URLS.homeUz }],
      [{ text: t(lang, "back"), callback_data: "menu:home" }]
    ]));
  }

  if (data === "menu:services") {
    const lines = POPULAR_SERVICES.map(([name, price]) => `• ${escapeHtml(serviceName(lang, name))} — <b>${escapeHtml(price)}</b>`);
    const body = [t(lang, "servicesTitle"), "", ...lines].join("\n");
    return renderPanel(env, q.message, body, inlineKeyboard([
      [{ text: L(lang, "🌐 Xizmatlar sahifasi", "🌐 Страница услуг"), url: URLS.services }],
      [{ text: t(lang, "back"), callback_data: "menu:home" }]
    ]));
  }

  if (data === "menu:tickets") {
    const rows = await listUserTickets(env, q.from.id, 8);
    if (!rows.length) return renderPanel(env, q.message, `🎫 <b>${t(lang, "tickets")}</b>\n\n${t(lang, "emptyTickets")}`, backKeyboard(lang));
    const buttons = rows.map(x => [{
      text: `${x.status === "open" ? "🟡" : "✅"} ${x.ticket_no} · ${categoryLabel(x.category, lang)}`,
      callback_data: `ticket:view:${x.ticket_no}`
    }]);
    buttons.push([{ text: t(lang, "back"), callback_data: "menu:home" }]);
    return renderPanel(env, q.message, `🎫 <b>${t(lang, "tickets")}</b>\n\n${L(lang, "Murojaatni ochish uchun ID ustiga bosing.", "Нажмите на ID, чтобы открыть обращение.")}`, inlineKeyboard(buttons));
  }

  if (data.startsWith("ticket:view:")) {
    const no = data.slice("ticket:view:".length);
    const ticket = await getTicket(env, no);
    if (!ticket || String(ticket.telegram_id) !== String(q.from.id)) return;
    const p = priorityMeta(ticket.priority);
    const body = [
      `🎫 <b>${escapeHtml(ticket.ticket_no)}</b>`,
      `${ticket.status === "open" ? "🟡" : "✅"} ${escapeHtml(statusLabel(ticket.status, lang))}`,
      `🧩 ${escapeHtml(categoryLabel(ticket.category, lang))}`,
      `${p.emoji} ${escapeHtml(p.label)}`,
      `🕒 ${escapeHtml(formatDate(ticket.created_at, lang))}`,
      ``,
      `📝 ${escapeHtml(ticket.description)}`
    ].join("\n");
    const buttons = [];
    if (ticket.status === "open") buttons.push([{ text: t(lang, "replyToTicket"), callback_data: `ticket:reply:${ticket.ticket_no}` }]);
    buttons.push([{ text: t(lang, "back"), callback_data: "menu:tickets" }]);
    return renderPanel(env, q.message, body, inlineKeyboard(buttons));
  }

  if (data.startsWith("ticket:reply:")) {
    const no = data.slice("ticket:reply:".length);
    const ticket = await getTicket(env, no);
    if (!ticket || String(ticket.telegram_id) !== String(q.from.id) || ticket.status !== "open") return;
    await setState(env, q.from.id, "ticket_reply", { ticketNo: no });
    return sendMessage(env, chatId, t(lang, "replyPrompt", { ticket: no }));
  }

  if (data.startsWith("support:")) {
    const category = data.slice(8);
    return renderPanel(env, q.message, diagnosticText(lang, category), diagnosticKeyboard(lang, category));
  }

  if (data.startsWith("check:")) {
    const [, category, variant] = data.split(":");
    return renderPanel(env, q.message, diagnosticText(lang, category, variant), diagnosticKeyboard(lang, category, variant));
  }

  if (data.startsWith("ticketctx:")) {
    const [, category, variant] = data.split(":");
    const diagnostic = ({
      "no_internet:los": L(lang, "ONU/ONT: LOS qizil", "ONU/ONT: LOS красный")
    })[`${category}:${variant}`] || `${category}:${variant}`;
    await setState(env, q.from.id, "ticket_account", { category, diagnostic });
    return sendMessage(env, chatId, t(lang, "askAccount"));
  }

  if (data.startsWith("diag:")) {
    const [, category, action] = data.split(":");
    if (action === "solved") {
      return renderPanel(env, q.message, t(lang, "solvedThanks"), homeKeyboard(lang));
    }
    if (action === "ticket") {
      await setState(env, q.from.id, "ticket_account", { category });
      return sendMessage(env, chatId, t(lang, "askAccount"));
    }
  }

  if (data.startsWith("feedback:")) {
    const [, no, value] = data.split(":");
    const ticket = await getTicket(env, no);
    if (!ticket || String(ticket.telegram_id) !== String(q.from.id) || ticket.status !== "closed") return;
    await addTicketMessage(env, no, "user", q.from.id, `feedback:${value}`, q.message.message_id);
    return sendMessage(env, chatId, t(lang, "feedbackThanks"), { reply_markup: homeKeyboard(lang) });
  }

  if (data.startsWith("admin:close:") && isAdmin(env, q.from.id, chatId)) {
    const no = data.slice("admin:close:".length);
    const ok = await closeAndNotify(env, no, q.from.id);
    if (ok) {
      try { await editReplyMarkup(env, chatId, q.message.message_id); } catch {}
      await sendMessage(env, chatId, `✅ ${escapeHtml(no)} yopildi.`);
    }
    return;
  }
}

async function message(env, msg) {
  if (!msg.from || msg.from.is_bot) return;
  const chatId = msg.chat.id;

  if (isAdmin(env, msg.from.id, chatId) && supportChat(env, chatId) && await adminMessage(env, msg)) return;
  if (msg.chat.type !== "private") return;

  let user = await upsertUser(env, msg.from);
  const text = (msg.text || "").trim();

  if (text === "/start") {
    await clearState(env, msg.from.id);
    if (!user.language) return sendMessage(env, chatId, t("uz", "chooseLanguage"), { reply_markup: languageKeyboard() });
    return showHome(env, chatId, user.language);
  }

  if (text === "/language") {
    return sendMessage(env, chatId, t(user.language || "uz", "chooseLanguage"), { reply_markup: languageKeyboard() });
  }

  if (text === "/cancel") {
    await clearState(env, msg.from.id);
    await sendMessage(env, chatId, t(user.language || "uz", "cancelled"), { reply_markup: removeKeyboard });
    return showHome(env, chatId, user.language || "uz");
  }

  if (text === "/help") {
    return sendMessage(env, chatId, t(user.language || "uz", "helpText"), { reply_markup: homeKeyboard(user.language || "uz") });
  }

  user = await getUser(env, msg.from.id);
  if (await stateFlow(env, msg, user)) return;
  return sendMessage(env, chatId, t(user.language || "uz", "unknown"), { reply_markup: homeKeyboard(user.language || "uz") });
}

async function webhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (!Number.isInteger(update.update_id)) return new Response("ok");
  if (!await claimUpdate(env, update.update_id)) return new Response("ok");

  try {
    if (update.callback_query) await callback(env, update.callback_query);
    else if (update.message) await message(env, update.message);
    return new Response("ok");
  } catch (err) {
    console.error("Telegram update failed", { updateId: update.update_id, error: String(err) });
    await releaseUpdate(env, update.update_id);
    return new Response("Retry", { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/telegram/webhook") return webhook(request, env);

    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const sources = await getSourceStatus(env);
        return Response.json({ ok: true, service: "fibernet-support-bot", version: VERSION, sources });
      } catch (err) {
        return Response.json({ ok: false, version: VERSION, error: String(err) }, { status: 503 });
      }
    }

    if (request.method === "POST" && url.pathname === "/admin/sync") {
      const auth = request.headers.get("authorization") || "";
      if (!env.ADMIN_API_TOKEN || auth !== `Bearer ${env.ADMIN_API_TOKEN}`) return new Response("Unauthorized", { status: 401 });
      return Response.json({ ok: true, report: await syncOfficialSources(env) });
    }

    if (url.pathname === "/") return new Response(`FiberNet Support Bot v${VERSION} is running.`);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      await syncOfficialSources(env);
      await cleanupProcessedUpdates(env);
    })());
  }
};
