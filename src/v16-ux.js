import {
  addMessage, clearSession, createTicket, deliveryDone, enqueueDelivery,
  getSession, getTicket, getUser, sessionData, setSession, setStage,
  setSupportMessage, upsertUser
} from './v5-db.js';
import { getDepartmentByChat, getDepartmentChat } from './v7-routing.js';
import {
  accountingIssuesKeyboard, categoryMeta, classifyText, connectionIssuesKeyboard,
  customerTypeKeyboard, departmentMeta, entityTypeLabel, L, operatorKeyboard,
  operatorName, priorityFor, subscriberIssuesKeyboard
} from './v8-ui.js';
import { __test as v14Test, accessLabel, getAccess } from './v14-access.js';
import { ensureTopicForTicket } from './v15-helpdesk.js';
import {
  answerCallback, escapeHtml, inlineKeyboard, sendMessage, tg
} from './telegram.js';

const now = () => new Date().toISOString();
let ready = false;
const rateBuckets = new Map();

const ENV_CHAT_KEYS = {
  tech: 'TECH_CHAT_ID',
  accounting: 'ACCOUNTING_CHAT_ID',
  subscriber: 'SUBSCRIBER_CHAT_ID',
  connection: 'CONNECTION_CHAT_ID',
  general: 'SUPPORT_CHAT_ID'
};

const HELP_CATEGORIES = {
  internet: { dept: 'tech', cat: 'no_internet' },
  slow: { dept: 'tech', cat: 'slow' },
  wifi: { dept: 'tech', cat: 'wifi' },
  tv: { dept: 'tech', cat: 'iptv' },
  equipment: { dept: 'tech', cat: 'equipment' },
  payment: { dept: 'accounting', cat: 'payment_missing' },
  balance: { dept: 'accounting', cat: 'balance' },
  subscriber: { dept: 'subscriber', cat: 'other' },
  connect: { dept: 'connection', cat: 'connection' }
};

export async function ensureV16Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn16_prefs (
      telegram_id INTEGER PRIMARY KEY,
      entity_type TEXT,
      preferred_identifier TEXT,
      last_service TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn16_sources (
      telegram_id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn16_processed (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn16_alerts (
      alert_key TEXT PRIMARY KEY,
      last_alert_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      data TEXT
    )`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

async function claimUpdate(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  await ensureV16Schema(env);
  try {
    await env.DB.prepare('INSERT INTO fn16_processed(update_id) VALUES(?)').bind(updateId).run();
    return true;
  } catch (e) {
    const s = String(e).toLowerCase();
    if (s.includes('unique') || s.includes('constraint')) return false;
    throw e;
  }
}

function isPrivate(chat) { return chat?.type === 'private'; }
function isGroup(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
function adminIds(env) { return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String); }
function isAdmin(env, id) { return adminIds(env).includes(String(id)); }
function bodyOf(msg) { return String(msg?.text || msg?.caption || '').trim(); }

async function userLang(env, id) {
  const u = await getUser(env, id);
  return u?.language === 'ru' ? 'ru' : 'uz';
}

async function getPrefs(env, id) {
  await ensureV16Schema(env);
  return env.DB.prepare('SELECT * FROM fn16_prefs WHERE telegram_id=?').bind(id).first();
}

async function savePrefs(env, id, patch = {}) {
  await ensureV16Schema(env);
  const old = await getPrefs(env, id);
  const entity = patch.entityType ?? old?.entity_type ?? null;
  const ident = patch.preferredIdentifier ?? old?.preferred_identifier ?? null;
  const service = patch.lastService ?? old?.last_service ?? null;
  return env.DB.prepare(`INSERT INTO fn16_prefs(telegram_id,entity_type,preferred_identifier,last_service,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET
    entity_type=excluded.entity_type,preferred_identifier=excluded.preferred_identifier,
    last_service=excluded.last_service,updated_at=excluded.updated_at`)
    .bind(id, entity, ident, service, now()).run();
}

async function saveSource(env, id, source) {
  const clean = String(source || 'direct').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'direct';
  await ensureV16Schema(env);
  return env.DB.prepare(`INSERT INTO fn16_sources(telegram_id,source,first_seen_at,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET source=excluded.source,updated_at=excluded.updated_at`)
    .bind(id, clean, now(), now()).run();
}

async function getSource(env, id) {
  await ensureV16Schema(env);
  return env.DB.prepare('SELECT source FROM fn16_sources WHERE telegram_id=?').bind(id).first();
}

function serviceHubKeyboard(lang) {
  return inlineKeyboard([
    [{ text: L(lang, '🚫 Internet ishlamayapti', '🚫 Не работает интернет'), callback_data: 'svc:internet' },
     { text: L(lang, '🐢 Internet sekin', '🐢 Низкая скорость'), callback_data: 'svc:slow' }],
    [{ text: '📡 Wi-Fi', callback_data: 'svc:wifi' },
     { text: '📺 HopHop / IPTV', callback_data: 'svc:tv' }],
    [{ text: L(lang, '🔧 ONU / router', '🔧 ONU / роутер'), callback_data: 'svc:equipment' }],
    [{ text: L(lang, '💳 To‘lov / balans', '💳 Оплата / баланс'), callback_data: 'svc:money' }],
    [{ text: L(lang, '👤 Tarif / login / Statik IP', '👤 Тариф / логин / статический IP'), callback_data: 'svc:subscriber' }],
    [{ text: L(lang, '🔌 Yangi ulanish / manzil', '🔌 Подключение / адрес'), callback_data: 'svc:connect' }],
    [{ text: L(lang, '✍️ Muammoni o‘zim yozaman', '✍️ Опишу проблему сам'), callback_data: 'svc:describe' }],
    [{ text: L(lang, '🏢 Bo‘lim bo‘yicha tanlash', '🏢 Выбрать отдел'), callback_data: 'svc:departments' }],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
}

function rawDepartmentsKeyboard(lang) {
  return inlineKeyboard([
    [{ text: L(lang, '🛠 Texnik yordam', '🛠 Техподдержка'), callback_data: 'dept:tech' }],
    [{ text: L(lang, '👥 Abonent bo‘limi', '👥 Абонентский отдел'), callback_data: 'dept:subscriber' }],
    [{ text: L(lang, '💳 Buxgalteriya', '💳 Бухгалтерия'), callback_data: 'dept:accounting' }],
    [{ text: L(lang, '🔌 Ulanish bo‘limi', '🔌 Отдел подключений'), callback_data: 'dept:connection' }],
    [{ text: L(lang, '⬅️ Qulay yordam menyusi', '⬅️ Удобное меню помощи'), callback_data: 'home:departments' }]
  ]);
}

async function showServiceHub(env, chatId, user) {
  const lang = user?.language === 'ru' ? 'ru' : 'uz';
  const prefs = await getPrefs(env, user.telegram_id);
  const access = await getAccess(env, user.telegram_id);
  const profileBits = [];
  if (prefs?.entity_type) profileBits.push(`👤 ${escapeHtml(entityTypeLabel(prefs.entity_type, lang))}`);
  if (access?.access_type) profileBits.push(`🌐 ${escapeHtml(accessLabel(access.access_type, lang))}`);
  return sendMessage(env, chatId, [
    `🧭 <b>${L(lang, 'Nimada yordam kerak?', 'С чем нужна помощь?')}</b>`,
    '',
    L(lang,
      'Bo‘lim nomini bilishingiz shart emas. Muammoni tanlang — bot kerakli bo‘lim va mutaxassisga o‘zi yo‘naltiradi.',
      'Не нужно знать название отдела. Выберите проблему — бот сам направит обращение нужному отделу и специалисту.'),
    profileBits.length ? `\n${profileBits.join(' · ')}` : null
  ].filter(Boolean).join('\n'), { reply_markup: serviceHubKeyboard(lang) });
}

function techAccessKeyboard(entityType, category, lang) {
  return inlineKeyboard([
    [{ text: L(lang, '🔌 MET / oddiy kabel', '🔌 MET / обычный кабель'), callback_data: `net:ethernet:${entityType}:${category}` }],
    [{ text: '🌐 GPON', callback_data: `net:gpon:${entityType}:${category}` }],
    [{ text: L(lang, '👤 Mijoz turini o‘zgartirish', '👤 Изменить тип клиента'), callback_data: `ux:type:tech:${category}` }],
    [{ text: L(lang, '⬅️ Yordam menyusi', '⬅️ Меню помощи'), callback_data: 'home:departments' }]
  ]);
}

function quickDiagnosticKeyboard(department, entityType, category, lang) {
  return inlineKeyboard([
    [{ text: L(lang, '✅ Muammo hal bo‘ldi', '✅ Проблема решена'), callback_data: 'home:main' }],
    [{ text: L(lang, '👨‍💻 Operatorga murojaat', '👨‍💻 Обратиться к оператору'), callback_data: `assist:${department}:${entityType}:${category}` }],
    [{ text: L(lang, '⬅️ Boshqa muammo', '⬅️ Другая проблема'), callback_data: 'home:departments' }]
  ]);
}

async function routeTechService(env, chatId, user, category) {
  const lang = user.language || 'uz';
  const prefs = await getPrefs(env, user.telegram_id);
  const access = await getAccess(env, user.telegram_id);
  await savePrefs(env, user.telegram_id, { lastService: `tech:${category}` });

  if (!prefs?.entity_type) {
    return sendMessage(env, chatId,
      L(lang,
        '👤 <b>Abonent turini bir marta tanlang</b>\n\nKeyingi murojaatlarda bot buni eslab qoladi.',
        '👤 <b>Один раз выберите тип абонента</b>\n\nВ следующих обращениях бот запомнит выбор.'),
      { reply_markup: customerTypeKeyboard('tech', lang, category) });
  }

  if (!access?.access_type) {
    return sendMessage(env, chatId,
      `🌐 <b>${L(lang, 'Ulanish turi', 'Тип подключения')}</b>\n\n👤 ${escapeHtml(entityTypeLabel(prefs.entity_type, lang))}\n\n${L(lang, 'Internet qaysi texnologiyada ulangan?', 'По какой технологии подключён интернет?')}`,
      { reply_markup: techAccessKeyboard(prefs.entity_type, category, lang) });
  }

  return sendMessage(env, chatId,
    v14Test.diagnosticText(lang, access.access_type, category, prefs.entity_type),
    { reply_markup: quickDiagnosticKeyboard('tech', prefs.entity_type, category, lang) });
}

async function routeSubscriberService(env, chatId, user) {
  const lang = user.language || 'uz';
  const prefs = await getPrefs(env, user.telegram_id);
  await savePrefs(env, user.telegram_id, { lastService: 'subscriber' });
  if (!prefs?.entity_type) {
    return sendMessage(env, chatId,
      L(lang,
        '👤 <b>Abonent turini tanlang</b>\n\nBot keyingi safar tanlovingizni eslab qoladi.',
        '👤 <b>Выберите тип абонента</b>\n\nБот запомнит выбор на следующий раз.'),
      { reply_markup: customerTypeKeyboard('subscriber', lang, 'other') });
  }
  return sendMessage(env, chatId,
    `👥 <b>${L(lang, 'Abonent xizmatlari', 'Абонентские услуги')}</b>\n👤 ${escapeHtml(entityTypeLabel(prefs.entity_type, lang))}\n\n${L(lang, 'Kerakli masalani tanlang:', 'Выберите вопрос:')}`,
    { reply_markup: subscriberIssuesKeyboard(prefs.entity_type, lang) });
}

async function handleService(env, q, service) {
  const user = await upsertUser(env, q.from);
  const lang = user.language || 'uz';
  const chatId = q.message.chat.id;
  await answerCallback(env, q.id);

  if (['internet', 'slow', 'wifi', 'tv', 'equipment'].includes(service)) {
    return routeTechService(env, chatId, user, HELP_CATEGORIES[service].cat);
  }
  if (service === 'money') {
    return sendMessage(env, chatId,
      `💳 <b>${L(lang, 'To‘lov va balans', 'Оплата и баланс')}</b>\n\n${L(lang, 'Masalani tanlang:', 'Выберите вопрос:')}`,
      { reply_markup: accountingIssuesKeyboard(lang) });
  }
  if (service === 'subscriber') return routeSubscriberService(env, chatId, user);
  if (service === 'connect') {
    return sendMessage(env, chatId,
      `🔌 <b>${L(lang, 'Ulanish xizmatlari', 'Услуги подключения')}</b>\n\n${L(lang, 'Kerakli xizmatni tanlang:', 'Выберите услугу:')}`,
      { reply_markup: connectionIssuesKeyboard(lang) });
  }
  if (service === 'describe') {
    await setSession(env, user.telegram_id, 'ux_describe', {});
    return sendMessage(env, chatId, L(lang,
      '✍️ <b>Muammoni oddiy tilda yozing</b>\n\nMasalan: <i>“Wi-Fi sekin”, “to‘lov tushmadi”, “LOS qizil”, “tarifni almashtirmoqchiman”.</i>\n\nBot kerakli yo‘lni o‘zi topadi.',
      '✍️ <b>Опишите проблему обычными словами</b>\n\nНапример: <i>«Wi-Fi медленный», «платёж не пришёл», «LOS красный», «хочу сменить тариф».</i>\n\nБот сам подберёт нужный путь.'));
  }
  if (service === 'departments') {
    return sendMessage(env, chatId,
      L(lang, '🏢 <b>Bo‘limlar</b>\n\nXohlasangiz aniq bo‘limni tanlashingiz mumkin:', '🏢 <b>Отделы</b>\n\nПри желании можно выбрать конкретный отдел:'),
      { reply_markup: rawDepartmentsKeyboard(lang) });
  }
  return showServiceHub(env, chatId, user);
}

function intentConfirmKeyboard(lang, department, entityType, category) {
  return inlineKeyboard([
    [{ text: L(lang, '✅ Davom etish', '✅ Продолжить'), callback_data: `ux:intent:${department}:${entityType}:${category}` }],
    [{ text: L(lang, '🔄 Boshqa muammo tanlash', '🔄 Выбрать другую проблему'), callback_data: 'home:departments' }]
  ]);
}

async function handleDescribeMessage(env, msg, user) {
  const lang = user.language || 'uz';
  const text = bodyOf(msg);
  if (!text) return true;
  const intent = classifyText(text);
  await clearSession(env, user.telegram_id);

  if (intent.action === 'choose_type' && intent.department === 'tech') {
    return routeTechService(env, msg.chat.id, user, intent.category || 'other');
  }
  if (intent.action === 'choose_type' && intent.department === 'subscriber') {
    const prefs = await getPrefs(env, user.telegram_id);
    if (prefs?.entity_type && intent.category && intent.category !== 'other') {
      return sendMessage(env, msg.chat.id,
        `🧠 ${L(lang, 'Tushundim:', 'Понял:')} <b>${escapeHtml(categoryMeta(intent.category, lang).title)}</b>`,
        { reply_markup: intentConfirmKeyboard(lang, 'subscriber', prefs.entity_type, intent.category) });
    }
    return routeSubscriberService(env, msg.chat.id, user);
  }
  if (intent.action === 'issue') {
    return sendMessage(env, msg.chat.id,
      `🧠 ${L(lang, 'Tushundim:', 'Понял:')} <b>${escapeHtml(categoryMeta(intent.category, lang).title)}</b>`,
      { reply_markup: intentConfirmKeyboard(lang, intent.department, intent.entityType || 'none', intent.category) });
  }
  if (intent.action === 'tariffs') {
    return sendMessage(env, msg.chat.id, L(lang, '📶 Tariflar bo‘limini ochamiz:', '📶 Откроем раздел тарифов:'),
      { reply_markup: inlineKeyboard([[{ text: L(lang, '📶 Tariflarni ko‘rish', '📶 Смотреть тарифы'), callback_data: 'home:tariffs' }],[{ text: L(lang,'⬅️ Yordam','⬅️ Помощь'), callback_data:'home:departments'}]]) });
  }
  if (intent.action === 'tv') return routeTechService(env, msg.chat.id, user, 'iptv');

  await sendMessage(env, msg.chat.id, L(lang,
    '🤔 Muammoni aniq ajrata olmadim. Quyidagilardan eng yaqinini tanlang — bo‘limni bot o‘zi aniqlaydi.',
    '🤔 Не удалось точно определить проблему. Выберите ближайший вариант — нужный отдел бот определит сам.'));
  return showServiceHub(env, msg.chat.id, user);
}

function shorten(value, max = 24) {
  const s = String(value || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function expressKeyboard(lang, user, department, entityType, category, preferred) {
  const rows = [];
  const savedLogin = user.account_login && user.account_login !== '-' ? user.account_login : null;
  const savedAddress = user.address && user.address !== '-' ? user.address : null;
  const loginButton = savedLogin && department !== 'connection'
    ? { text: `⚡ ${L(lang,'Login','Логин')}: ${shorten(savedLogin)}`, callback_data: `uxsend:login:${department}:${entityType}:${category}` }
    : null;
  const addressButton = savedAddress
    ? { text: `⚡ ${L(lang,'Manzil','Адрес')}: ${shorten(savedAddress)}`, callback_data: `uxsend:address:${department}:${entityType}:${category}` }
    : null;
  if (preferred === 'address') {
    if (addressButton) rows.push([addressButton]);
    if (loginButton) rows.push([loginButton]);
  } else {
    if (loginButton) rows.push([loginButton]);
    if (addressButton) rows.push([addressButton]);
  }
  if (department !== 'connection') rows.push([{ text: L(lang, '🔐 Boshqa login / shartnoma', '🔐 Другой логин / договор'), callback_data: `uxinput:login:${department}:${entityType}:${category}` }]);
  rows.push([{ text: L(lang, '📍 Boshqa manzil', '📍 Другой адрес'), callback_data: `uxinput:address:${department}:${entityType}:${category}` }]);
  rows.push([{ text: L(lang, '❌ Bekor qilish', '❌ Отмена'), callback_data: 'home:departments' }]);
  return inlineKeyboard(rows);
}

async function findDuplicate(env, telegramId, department, category) {
  return env.DB.prepare(`SELECT * FROM fn5_tickets
    WHERE telegram_id=? AND department=? AND category=? AND status='open'
      AND datetime(created_at)>=datetime('now','-72 hours')
    ORDER BY id DESC LIMIT 1`).bind(telegramId, department, category).first();
}

async function routeChat(env, department) {
  const b = await getDepartmentChat(env, department);
  if (b?.chat_id) return b.chat_id;
  const key = ENV_CHAT_KEYS[department] || 'SUPPORT_CHAT_ID';
  return env[key] || env.SUPPORT_CHAT_ID || null;
}

async function fallbackDeliver(env, no) {
  const t = await getTicket(env, no);
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  const chatId = await routeChat(env, t.department);
  if (!chatId) throw new Error(`No operator group for ${t.department}`);
  const d = departmentMeta(t.department, lang);
  const c = categoryMeta(t.category, lang);
  const sent = await sendMessage(env, chatId, [
    `${t.priority === 'critical' ? '🚨' : t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡'} <b>${escapeHtml(no)}</b>`,
    `${d.icon} <b>${escapeHtml(d.title)}</b> · ${c.icon} ${escapeHtml(c.title)}`,
    '',
    `👤 ${escapeHtml([u?.first_name,u?.last_name].filter(Boolean).join(' ') || String(t.telegram_id))}`,
    `🔐 <code>${escapeHtml(t.account_login || '—')}</code>`,
    `📍 ${escapeHtml(t.address || '—')}`,
    `📞 ${escapeHtml(t.phone || '—')}`,
    '',
    `📝 ${escapeHtml(t.description || '—')}`
  ].join('\n'), { reply_markup: operatorKeyboard(no) });
  await setSupportMessage(env, no, chatId, sent.message_id);
  await deliveryDone(env, no);
  return { mode: 'group', chatId, messageId: sent.message_id };
}

async function deliverNewTicket(env, no) {
  try {
    const topic = await ensureTopicForTicket(env, no);
    if (topic?.thread_id) {
      await env.DB.prepare('UPDATE fn5_tickets SET support_chat_id=?,updated_at=? WHERE ticket_no=?')
        .bind(topic.chat_id, now(), no).run();
      await deliveryDone(env, no);
      return { mode: 'topic', chatId: topic.chat_id, threadId: topic.thread_id };
    }
  } catch (e) {
    console.warn('v16 forum delivery fallback', String(e));
  }
  try {
    return await fallbackDeliver(env, no);
  } catch (e) {
    await enqueueDelivery(env, no, e);
    return { mode: 'queue', error: String(e) };
  }
}

async function event(env, no, actorType, actorId, name, data = null) {
  try {
    await env.DB.prepare('INSERT INTO fn11_events(ticket_no,actor_type,actor_id,event,data) VALUES(?,?,?,?,?)')
      .bind(no, actorType, actorId || null, name, data ? JSON.stringify(data) : null).run();
  } catch {}
}

async function setUserLive(env, telegramId, no) {
  try {
    await env.DB.prepare(`INSERT INTO fn11_user_live(telegram_id,ticket_no,updated_at) VALUES(?,?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET ticket_no=excluded.ticket_no,updated_at=excluded.updated_at`)
      .bind(telegramId, no, now()).run();
  } catch {}
}

export async function createExpressTicket(env, msg, user, data, forceNew = false) {
  const lang = user.language || 'uz';
  if (!forceNew) {
    const duplicate = await findDuplicate(env, user.telegram_id, data.department, data.category);
    if (duplicate) {
      await setSession(env, user.telegram_id, 'ux_duplicate', { pending: data, existing: duplicate.ticket_no });
      await sendMessage(env, msg.chat.id, L(lang,
        `♻️ <b>Shunga o‘xshash ochiq murojaat bor</b>\n\n🎫 <code>${duplicate.ticket_no}</code>\n📌 ${escapeHtml(duplicate.stage || 'open')}\n\nYangi ticket yaratmasdan shu murojaatni davom ettirish tezroq bo‘ladi.`,
        `♻️ <b>У вас уже есть похожее открытое обращение</b>\n\n🎫 <code>${duplicate.ticket_no}</code>\n📌 ${escapeHtml(duplicate.stage || 'open')}\n\nБыстрее продолжить существующее обращение, не создавая дубликат.`),
        { reply_markup: inlineKeyboard([
          [{ text: L(lang,'💬 Shu murojaatni davom ettirish','💬 Продолжить это обращение'), callback_data: `uxdup:continue:${duplicate.ticket_no}` }],
          [{ text: L(lang,'➕ Baribir yangi yaratish','➕ Всё равно создать новое'), callback_data: 'uxdup:new' }],
          [{ text: L(lang,'❌ Bekor qilish','❌ Отмена'), callback_data: 'home:main' }]
        ]) });
      return null;
    }
  }

  const cat = categoryMeta(data.category, lang);
  let verifiedProfile = null;
  try {
    verifiedProfile = await env.DB.prepare(`SELECT given_name,family_name,login,address,status
      FROM fn18_profiles WHERE telegram_id=? AND status='approved'`).bind(user.telegram_id).first();
  } catch {}
  const customerName = String(data.customerName || (
    verifiedProfile ? [verifiedProfile.given_name, verifiedProfile.family_name].filter(Boolean).join(' ') : ''
  )).trim() || null;
  const isVerifiedProfile = Boolean(verifiedProfile);
  const typeLine = data.entityType && data.entityType !== 'none'
    ? `${L(lang,'Mijoz turi','Тип клиента')}: ${entityTypeLabel(data.entityType, lang)}`
    : null;
  const profileLine = customerName
    ? `${isVerifiedProfile ? '✅' : '📝'} ${L(lang,'Mijoz','Клиент')}: ${customerName}${isVerifiedProfile ? ` · ${L(lang,'profil admin tomonidan tasdiqlangan','профиль подтверждён администратором')}` : ` · ${L(lang,'bir martalik ma’lumot','данные для этого обращения')}`}`
    : null;
  const description = [
    profileLine,
    typeLine,
    `${L(lang,'Tanlangan muammo','Выбранная проблема')}: ${cat.title}`,
    data.details ? `${L(lang,'Qo‘shimcha','Дополнительно')}: ${data.details}` : null,
    L(lang,
      'Bot yo‘riqnomasi ko‘rildi, muammo hal bo‘lmagani uchun operatorga yuborildi.',
      'Инструкция бота просмотрена; проблема не решена, обращение передано оператору.')
  ].filter(Boolean).join('\n');

  const hasLogin = Object.prototype.hasOwnProperty.call(data, 'accountLogin');
  const hasAddress = Object.prototype.hasOwnProperty.call(data, 'address');
  const effectiveLogin = hasLogin ? data.accountLogin : (verifiedProfile?.login ?? user.account_login);
  const effectiveAddress = hasAddress ? data.address : (verifiedProfile?.address ?? user.address);

  const no = await createTicket(env, {
    telegramId: user.telegram_id,
    department: data.department,
    category: data.category,
    description,
    accountLogin: effectiveLogin || null,
    address: effectiveAddress || null,
    phone: user.phone,
    priority: priorityFor(data.category, `${description} ${data.details || ''}`),
    telegramMessageId: msg.message_id || null
  });
  await clearSession(env, user.telegram_id);
  await savePrefs(env, user.telegram_id, {
    entityType: data.entityType && data.entityType !== 'none' ? data.entityType : undefined,
    preferredIdentifier: data.identifierMode,
    lastService: `${data.department}:${data.category}`
  });

  const delivery = await deliverNewTicket(env, no);
  const fresh = await getTicket(env, no);
  await setUserLive(env, user.telegram_id, no);
  await event(env, no, 'user', user.telegram_id, 'ux_express_created', { delivery: delivery.mode });

  const assigned = fresh?.assigned_name
    ? `\n👨‍💻 ${L(lang,'Operator','Оператор')}: <b>${escapeHtml(fresh.assigned_name)}</b>`
    : '';
  await sendMessage(env, msg.chat.id, L(lang,
    `✅ <b>Murojaat yuborildi</b>\n\n🎫 <code>${no}</code>\n${cat.icon} ${escapeHtml(cat.title)}${assigned}\n\n${delivery.mode === 'queue' ? '⏳ Murojaat saqlandi. Yetkazish avtomatik qayta urinadi.' : '🚀 Kerakli mutaxassis navbatiga yuborildi.'}\n\nEndi shu chatga oddiy xabar, rasm, video, voice yoki sticker yuborsangiz ticketga qo‘shiladi.`,
    `✅ <b>Обращение отправлено</b>\n\n🎫 <code>${no}</code>\n${cat.icon} ${escapeHtml(cat.title)}${assigned}\n\n${delivery.mode === 'queue' ? '⏳ Обращение сохранено. Доставка будет повторена автоматически.' : '🚀 Обращение направлено нужному специалисту.'}\n\nТеперь обычный текст, фото, видео, голосовое или стикер в этом чате добавится в обращение.`));
  return no;
}

async function beginExpressAssist(env, q) {
  const [, department, entityType = 'none', category = 'other'] = String(q.data || '').split(':');
  const user = await upsertUser(env, q.from);
  const lang = user.language || 'uz';
  const prefs = await getPrefs(env, user.telegram_id);
  if (entityType !== 'none') await savePrefs(env, user.telegram_id, { entityType });
  await answerCallback(env, q.id);
  return sendMessage(env, q.message.chat.id, [
    `👨‍💻 <b>${L(lang,'Operatorga murojaat','Обращение оператору')}</b>`,
    `${categoryMeta(category, lang).icon} ${escapeHtml(categoryMeta(category, lang).title)}`,
    '',
    L(lang,
      'Abonentni topish uchun mavjud ma’lumotdan birini bosing. Saqlangan ma’lumot bo‘lsa qayta yozish shart emas.',
      'Выберите данные для поиска абонента. Если данные уже сохранены, вводить их заново не нужно.')
  ].join('\n'), {
    reply_markup: expressKeyboard(lang, user, department, entityType, category, prefs?.preferred_identifier)
  });
}

async function handleManualValue(env, msg, user, s) {
  const lang = user.language || 'uz';
  const d = sessionData(s);
  const value = bodyOf(msg);
  if (!value) {
    await sendMessage(env, msg.chat.id, L(lang, '✍️ Ma’lumotni matn ko‘rinishida yuboring.', '✍️ Отправьте данные текстом.'));
    return true;
  }
  if (d.identifierMode === 'login') d.accountLogin = value.slice(0, 100);
  else d.address = value.slice(0, 350);
  if (d.category === 'other') {
    await setSession(env, user.telegram_id, 'ux_details', d);
    await sendMessage(env, msg.chat.id, L(lang,
      '📝 Muammoni 1–3 gapda yozing. Kerak bo‘lsa keyin rasm/video ham yubora olasiz.',
      '📝 Опишите проблему в 1–3 предложениях. После создания обращения можно отправить фото/видео.'));
    return true;
  }
  await createExpressTicket(env, msg, user, d);
  return true;
}

async function handleDetails(env, msg, user, s) {
  const lang = user.language || 'uz';
  const d = sessionData(s);
  const text = bodyOf(msg);
  if (!text) {
    await sendMessage(env, msg.chat.id, L(lang, '📝 Muammoni matn bilan yozing.', '📝 Опишите проблему текстом.'));
    return true;
  }
  d.details = text.slice(0, 1600);
  await createExpressTicket(env, msg, user, d);
  return true;
}

async function continueDuplicate(env, q, no) {
  const user = await upsertUser(env, q.from);
  const lang = user.language || 'uz';
  const t = await getTicket(env, no);
  await answerCallback(env, q.id);
  if (!t || t.status !== 'open' || String(t.telegram_id) !== String(user.telegram_id)) {
    await clearSession(env, user.telegram_id);
    return sendMessage(env, q.message.chat.id, L(lang, '⚠️ Murojaat topilmadi yoki yopilgan.', '⚠️ Обращение не найдено или уже закрыто.'));
  }
  await clearSession(env, user.telegram_id);
  await setUserLive(env, user.telegram_id, no);
  return sendMessage(env, q.message.chat.id, L(lang,
    `💬 <b>Murojaat davom ettiriladi</b>\n🎫 <code>${no}</code>\n\nEndi shu chatga yozing yoki media yuboring — operatorga shu ticket ichida boradi.`,
    `💬 <b>Продолжаем обращение</b>\n🎫 <code>${no}</code>\n\nТеперь напишите сообщение или отправьте медиа — оно попадёт оператору в это обращение.`));
}

function allowRate(userId) {
  const ts = Date.now();
  const key = String(userId);
  const old = rateBuckets.get(key) || [];
  const fresh = old.filter(x => ts - x < 10000);
  fresh.push(ts);
  rateBuckets.set(key, fresh);
  return fresh.length <= 12;
}

async function hasActiveTicket(env, telegramId) {
  try {
    const live = await env.DB.prepare(`SELECT ticket_no FROM fn11_user_live
      WHERE telegram_id=? AND datetime(updated_at)>=datetime('now','-24 hours')`).bind(telegramId).first();
    if (live?.ticket_no) {
      const t = await getTicket(env, live.ticket_no);
      if (t?.status === 'open') return t;
    }
  } catch {}
  return null;
}

async function topicTicket(env, msg) {
  if (!msg?.message_thread_id) return null;
  const row = await env.DB.prepare(`SELECT ticket_no FROM fn15_topics
    WHERE chat_id=? AND thread_id=? AND state='open'`).bind(msg.chat.id, msg.message_thread_id).first();
  return row?.ticket_no ? getTicket(env, row.ticket_no) : null;
}

async function ensureOperatorAccess(env, t, from) {
  if (!t) return { ok: false };
  if (t.assigned_to && String(t.assigned_to) !== String(from.id) && !isAdmin(env, from.id)) {
    return { ok: false, reason: `Ticket ${t.assigned_name || t.assigned_to} operatoriga biriktirilgan.` };
  }
  if (!t.assigned_to) {
    const op = { id: from.id, name: operatorName(from) };
    const r = await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=?,assigned_name=?,stage='in_progress',updated_at=?
      WHERE ticket_no=? AND status='open' AND assigned_to IS NULL`).bind(op.id, op.name, now(), t.ticket_no).run();
    if ((r.meta?.changes || 0) === 0) {
      const fresh = await getTicket(env, t.ticket_no);
      if (String(fresh?.assigned_to) !== String(from.id) && !isAdmin(env, from.id)) {
        return { ok: false, reason: `Ticket ${fresh?.assigned_name || 'boshqa operator'} tomonidan olindi.` };
      }
    }
  }
  return { ok: true };
}

const ASK_TEMPLATES = {
  login: {
    uz: '🔐 Iltimos, abonent login yoki shartnoma raqamini yuboring. <b>Parol yubormang.</b>',
    ru: '🔐 Пожалуйста, отправьте логин абонента или номер договора. <b>Пароль не отправляйте.</b>'
  },
  address: {
    uz: '📍 Iltimos, ulanish manzilini to‘liq yozing: ko‘cha, uy va kvartira/ofis.',
    ru: '📍 Пожалуйста, укажите полный адрес подключения: улица, дом и квартира/офис.'
  },
  photo: {
    uz: '📸 Iltimos, ONU/router indikatorlari ko‘rinadigan qilib rasm yuboring.',
    ru: '📸 Пожалуйста, отправьте фото ONU/роутера так, чтобы были видны индикаторы.'
  },
  los: {
    uz: '🔴 ONU’da <b>LOS</b> indikatori qizil yonayaptimi yoki miltillayaptimi? Iloji bo‘lsa rasm yuboring.',
    ru: '🔴 На ONU индикатор <b>LOS</b> горит или мигает красным? По возможности отправьте фото.'
  },
  speedtest: {
    uz: '📊 Iltimos, imkon bo‘lsa kabel orqali speed test qiling va natijaning screenshotini yuboring.',
    ru: '📊 По возможности сделайте speed test по кабелю и отправьте скриншот результата.'
  },
  restart: {
    uz: '🔄 ONU/router quvvatini 60 soniyaga o‘chirib, qayta yoqing. To‘liq yuklangach natijani yozing.',
    ru: '🔄 Выключите ONU/роутер на 60 секунд и включите снова. После полной загрузки сообщите результат.'
  }
};

async function sendAsk(env, q, no, key) {
  const t = await getTicket(env, no);
  const access = await ensureOperatorAccess(env, t, q.from);
  if (!access.ok) {
    await answerCallback(env, q.id, access.reason || 'Ruxsat yo‘q');
    return true;
  }
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  const template = ASK_TEMPLATES[key];
  if (!template) { await answerCallback(env, q.id, 'Template topilmadi'); return true; }
  const text = template[lang] || template.uz;
  await sendMessage(env, t.telegram_id,
    `👨‍💻 <b>FiberNet ${L(lang,'operatori','оператор')}</b>\n🎫 <code>${escapeHtml(no)}</code>\n\n${text}`);
  await addMessage(env, no, 'operator', q.from.id, `[ask:${key}] ${text.replace(/<[^>]+>/g,'')}`, q.message.message_id);
  await setStage(env, no, 'waiting_customer', { id: q.from.id, name: operatorName(q.from) });
  await setUserLive(env, t.telegram_id, no);
  await event(env, no, 'operator', q.from.id, 'operator_ask', { key });
  await answerCallback(env, q.id, 'Mijozga yuborildi');
  return true;
}

async function sendMacro(env, q, no, key) {
  const t = await getTicket(env, no);
  const access = await ensureOperatorAccess(env, t, q.from);
  if (!access.ok) {
    await answerCallback(env, q.id, access.reason || 'Ruxsat yo‘q');
    return true;
  }
  const m = await env.DB.prepare('SELECT * FROM fn15_macros WHERE macro_key=? AND enabled=1').bind(key).first();
  if (!m) { await answerCallback(env, q.id, 'Quick reply topilmadi'); return true; }
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  const text = lang === 'ru' ? m.text_ru : m.text_uz;
  await sendMessage(env, t.telegram_id,
    `👨‍💻 <b>FiberNet ${L(lang,'operatori','оператор')}</b>\n🎫 <code>${escapeHtml(no)}</code>\n\n${escapeHtml(text)}`);
  await addMessage(env, no, 'operator', q.from.id, `[macro:${key}] ${text}`, q.message.message_id);
  await setStage(env, no, 'waiting_customer', { id: q.from.id, name: operatorName(q.from) });
  await setUserLive(env, t.telegram_id, no);
  await event(env, no, 'operator', q.from.id, 'operator_macro', { key });
  await answerCallback(env, q.id, 'Quick reply yuborildi');
  return true;
}

async function ticketSummary(env, no) {
  const t = await getTicket(env, no);
  if (!t) return 'Ticket topilmadi.';
  const u = await getUser(env, t.telegram_id);
  const a = await getAccess(env, t.telegram_id);
  const prefs = await getPrefs(env, t.telegram_id);
  const source = await getSource(env, t.telegram_id);
  const msgs = await env.DB.prepare(`SELECT sender_type,body,created_at FROM fn5_messages
    WHERE ticket_no=? ORDER BY id DESC LIMIT 6`).bind(no).all();
  let notes = { results: [] };
  try {
    notes = await env.DB.prepare(`SELECT operator_name,note,created_at FROM fn13_internal_notes
      WHERE ticket_no=? ORDER BY id DESC LIMIT 3`).bind(no).all();
  } catch {}
  const recent = (msgs.results || []).reverse().map(x =>
    `${x.sender_type === 'operator' ? '👨‍💻' : '👤'} ${escapeHtml(shorten(x.body || '—', 180))}`
  ).join('\n');
  const noteText = (notes.results || []).reverse().map(x =>
    `📝 ${escapeHtml(x.operator_name || 'op')}: ${escapeHtml(shorten(x.note, 140))}`
  ).join('\n');
  return [
    `📋 <b>${escapeHtml(no)} · Context</b>`,
    `📌 ${escapeHtml(t.stage)} · ${priorityFor(t.category, t.description) === 'critical' ? '🚨' : escapeHtml(t.priority)}`,
    `${departmentMeta(t.department, 'uz').icon} ${escapeHtml(departmentMeta(t.department, 'uz').title)}`,
    `${categoryMeta(t.category, 'uz').icon} ${escapeHtml(categoryMeta(t.category, 'uz').title)}`,
    `👤 ${escapeHtml(prefs?.entity_type ? entityTypeLabel(prefs.entity_type, 'uz') : '—')}`,
    `🌐 ${escapeHtml(a?.access_type ? accessLabel(a.access_type, 'uz') : '—')}`,
    `🔐 <code>${escapeHtml(t.account_login || '—')}</code>`,
    `📍 ${escapeHtml(t.address || '—')}`,
    `📞 ${escapeHtml(t.phone || '—')}`,
    `🔗 Source: <code>${escapeHtml(source?.source || 'direct')}</code>`,
    t.assigned_name ? `👨‍💻 Operator: <b>${escapeHtml(t.assigned_name)}</b>` : '👨‍💻 Operator: —',
    '',
    '<b>Oxirgi xabarlar:</b>',
    recent || '—',
    noteText ? `\n<b>Ichki izohlar:</b>\n${noteText}` : null
  ].filter(Boolean).join('\n');
}

function quickKeyboard(no) {
  return inlineKeyboard([
    [{ text:'🔄 Restart', callback_data:`v16:macro:restart:${no}` }, { text:'🔴 LOS', callback_data:`v16:macro:los:${no}` }],
    [{ text:'📶 Wi-Fi 5G', callback_data:`v16:macro:wifi5:${no}` }, { text:'🔌 Kabel', callback_data:`v16:macro:cable:${no}` }],
    [{ text:'💳 To‘lov', callback_data:`v16:macro:payment:${no}` }]
  ]);
}

function askKeyboard(no) {
  return inlineKeyboard([
    [{ text:'🔐 Login', callback_data:`v16:ask:login:${no}` }, { text:'📍 Manzil', callback_data:`v16:ask:address:${no}` }],
    [{ text:'📸 ONU/router rasmi', callback_data:`v16:ask:photo:${no}` }, { text:'🔴 LOS', callback_data:`v16:ask:los:${no}` }],
    [{ text:'📊 Speedtest', callback_data:`v16:ask:speedtest:${no}` }, { text:'🔄 Restart', callback_data:`v16:ask:restart:${no}` }]
  ]);
}

async function handleOperatorCallback(env, q) {
  if (!isGroup(q.message?.chat)) return false;
  const data = String(q.data || '');
  if (!data.startsWith('v16:')) return false;
  const p = data.split(':');
  const action = p[1];

  if (action === 'summary') {
    const no = p[2];
    await answerCallback(env, q.id);
    await sendMessage(env, q.message.chat.id, await ticketSummary(env, no),
      q.message.message_thread_id ? { message_thread_id: q.message.message_thread_id } : {});
    return true;
  }
  if (action === 'quick') {
    const no = p[2];
    await answerCallback(env, q.id, 'Quick replies');
    await sendMessage(env, q.message.chat.id, '⚡ <b>Tayyor javoblar</b>',
      { ...(q.message.message_thread_id ? { message_thread_id: q.message.message_thread_id } : {}), reply_markup: quickKeyboard(no) });
    return true;
  }
  if (action === 'askmenu') {
    const no = p[2];
    await answerCallback(env, q.id, 'Mijozdan so‘rash');
    await sendMessage(env, q.message.chat.id, '❓ <b>Mijozdan nima so‘raymiz?</b>',
      { ...(q.message.message_thread_id ? { message_thread_id: q.message.message_thread_id } : {}), reply_markup: askKeyboard(no) });
    return true;
  }
  if (action === 'macro') return sendMacro(env, q, p[3], p[2]);
  if (action === 'ask') return sendAsk(env, q, p[3], p[2]);
  return false;
}

async function handleOperatorText(env, msg) {
  if (!isGroup(msg.chat) || msg.from?.is_bot || !msg.message_thread_id) return false;
  const t = await topicTicket(env, msg);
  if (!t) return false;
  const text = String(msg.text || '').trim();

  if (text.startsWith('//')) {
    const note = text.slice(2).trim();
    if (!note) return true;
    try {
      await env.DB.prepare(`INSERT INTO fn13_internal_notes(ticket_no,operator_id,operator_name,note)
        VALUES(?,?,?,?)`).bind(t.ticket_no, msg.from.id, operatorName(msg.from), note.slice(0, 1600)).run();
    } catch {}
    await event(env, t.ticket_no, 'operator', msg.from.id, 'internal_note_shortcut', { note: note.slice(0, 300) });
    await sendMessage(env, msg.chat.id, '📝 Ichki izoh saqlandi. <b>Mijozga yuborilmadi.</b>',
      { message_thread_id: msg.message_thread_id });
    return true;
  }

  if (/^\/summary(?:@\w+)?$/i.test(text)) {
    await sendMessage(env, msg.chat.id, await ticketSummary(env, t.ticket_no),
      { message_thread_id: msg.message_thread_id });
    return true;
  }
  if (/^\/ask(?:@\w+)?$/i.test(text)) {
    await sendMessage(env, msg.chat.id, '❓ <b>Mijozdan nima so‘raymiz?</b>',
      { message_thread_id: msg.message_thread_id, reply_markup: askKeyboard(t.ticket_no) });
    return true;
  }
  if (/^\/quick(?:@\w+)?$/i.test(text)) {
    await sendMessage(env, msg.chat.id, '⚡ <b>Tayyor javoblar</b>',
      { message_thread_id: msg.message_thread_id, reply_markup: quickKeyboard(t.ticket_no) });
    return true;
  }
  return false;
}

async function repairBrokenTopics(env) {
  const r = await env.DB.prepare(`SELECT o.id,o.ticket_no,o.last_error,p.chat_id,p.thread_id
    FROM fn15_outbox o LEFT JOIN fn15_topics p ON p.ticket_no=o.ticket_no
    WHERE o.target_thread_id IS NOT NULL
      AND (lower(COALESCE(o.last_error,'')) LIKE '%thread%' OR lower(COALESCE(o.last_error,'')) LIKE '%topic%')
    ORDER BY o.id ASC LIMIT 10`).all();
  for (const x of r.results || []) {
    if (!x.ticket_no) continue;
    let repaired = false;
    if (x.chat_id && x.thread_id) {
      try {
        await tg(env, 'reopenForumTopic', { chat_id: x.chat_id, message_thread_id: x.thread_id });
        repaired = true;
      } catch {}
    }
    if (!repaired) {
      await env.DB.prepare('DELETE FROM fn15_topics WHERE ticket_no=?').bind(x.ticket_no).run();
      const topic = await ensureTopicForTicket(env, x.ticket_no);
      if (topic?.thread_id) {
        await env.DB.prepare('UPDATE fn15_outbox SET target_chat_id=?,target_thread_id=?,next_try_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?')
          .bind(topic.chat_id, topic.thread_id, x.ticket_no).run();
        repaired = true;
      }
    }
    if (repaired) await event(env, x.ticket_no, 'system', null, 'topic_repaired_v16');
  }
}

async function alertBlockedUsers(env) {
  const r = await env.DB.prepare(`SELECT DISTINCT o.ticket_no,o.last_error,t.support_chat_id
    FROM fn15_outbox o JOIN fn5_tickets t ON t.ticket_no=o.ticket_no
    WHERE o.direction='operator_to_user'
      AND (lower(COALESCE(o.last_error,'')) LIKE '%blocked%' OR lower(COALESCE(o.last_error,'')) LIKE '%forbidden%')
    LIMIT 10`).all();
  for (const x of r.results || []) {
    const key = `blocked:${x.ticket_no}`;
    const old = await env.DB.prepare('SELECT alert_key FROM fn16_alerts WHERE alert_key=?').bind(key).first();
    if (old) continue;
    const topic = await env.DB.prepare('SELECT * FROM fn15_topics WHERE ticket_no=?').bind(x.ticket_no).first();
    const chatId = topic?.chat_id || x.support_chat_id;
    if (chatId) {
      try {
        await sendMessage(env, chatId,
          `🚫 <b>${escapeHtml(x.ticket_no)}</b> — mijoz botni bloklagan bo‘lishi mumkin. Xabar yetkazilmadi.`,
          topic?.thread_id ? { message_thread_id: topic.thread_id } : {});
      } catch {}
    }
    await env.DB.prepare('INSERT OR REPLACE INTO fn16_alerts(alert_key,last_alert_at,data) VALUES(?,?,?)')
      .bind(key, now(), String(x.last_error || '').slice(0, 300)).run();
  }
}

export async function handleV16Update(env, update) {
  await ensureV16Schema(env);

  const q = update?.callback_query;
  if (q?.message?.chat) {
    if (await handleOperatorCallback(env, q)) return true;
    if (isPrivate(q.message.chat)) {
      const data = String(q.data || '');
      if (data === 'home:departments') {
        if (!await claimUpdate(env, update.update_id)) return true;
        const user = await upsertUser(env, q.from);
        await answerCallback(env, q.id);
        await clearSession(env, user.telegram_id);
        await showServiceHub(env, q.message.chat.id, user);
        return true;
      }
      if (data.startsWith('svc:')) {
        if (!await claimUpdate(env, update.update_id)) return true;
        return handleService(env, q, data.slice(4));
      }
      if (data.startsWith('ux:type:')) {
        const [, , department, category = 'other'] = data.split(':');
        if (!await claimUpdate(env, update.update_id)) return true;
        const user = await upsertUser(env, q.from);
        await answerCallback(env, q.id);
        await sendMessage(env, q.message.chat.id,
          L(user.language || 'uz', '👤 Abonent turini tanlang:', '👤 Выберите тип абонента:'),
          { reply_markup: customerTypeKeyboard(department, user.language || 'uz', category) });
        return true;
      }
      if (data.startsWith('type:tech:') || data.startsWith('type:subscriber:')) {
        const p = data.split(':');
        const entityType = p[2];
        if (entityType === 'physical' || entityType === 'legal') await savePrefs(env, q.from.id, { entityType });
        return false;
      }
      if (data.startsWith('ux:intent:')) {
        if (!await claimUpdate(env, update.update_id)) return true;
        const [, , dept, type, cat] = data.split(':');
        await answerCallback(env, q.id);
        if (dept === 'tech') {
          const user = await upsertUser(env, q.from);
          return routeTechService(env, q.message.chat.id, user, cat);
        }
        if (dept === 'subscriber') {
          const user = await upsertUser(env, q.from);
          if (type === 'physical' || type === 'legal') await savePrefs(env, user.telegram_id, { entityType: type });
          return sendMessage(env, q.message.chat.id,
            `👥 <b>${escapeHtml(categoryMeta(cat, user.language || 'uz').title)}</b>`,
            { reply_markup: inlineKeyboard([[{ text:L(user.language||'uz','Davom etish','Продолжить'), callback_data:`issue:subscriber:${type}:${cat}` }],[{text:L(user.language||'uz','⬅️ Yordam','⬅️ Помощь'),callback_data:'home:departments'}]]) });
        }
        return sendMessage(env, q.message.chat.id,
          `✅ <b>${escapeHtml(categoryMeta(cat, (await userLang(env,q.from.id))).title)}</b>`,
          { reply_markup: inlineKeyboard([[{ text:'➡️', callback_data:`issue:${dept}:${type}:${cat}` }],[{text:'⬅️',callback_data:'home:departments'}]]) });
      }
      if (data.startsWith('assist:')) {
        if (!await claimUpdate(env, update.update_id)) return true;
        return beginExpressAssist(env, q);
      }
      if (data.startsWith('uxsend:')) {
        if (!await claimUpdate(env, update.update_id)) return true;
        const [, mode, department, entityType, category] = data.split(':');
        const user = await upsertUser(env, q.from);
        const d = {
          department, entityType, category, identifierMode: mode,
          accountLogin: mode === 'login' ? user.account_login : undefined,
          address: mode === 'address' ? user.address : undefined
        };
        await answerCallback(env, q.id);
        if (category === 'other') {
          await setSession(env, user.telegram_id, 'ux_details', d);
          await sendMessage(env, q.message.chat.id, L(user.language || 'uz',
            '📝 Muammoni 1–3 gapda yozing:', '📝 Опишите проблему в 1–3 предложениях:'));
          return true;
        }
        await createExpressTicket(env, q.message, user, d);
        return true;
      }
      if (data.startsWith('uxinput:')) {
        if (!await claimUpdate(env, update.update_id)) return true;
        const [, mode, department, entityType, category] = data.split(':');
        const user = await upsertUser(env, q.from);
        await setSession(env, user.telegram_id, 'ux_manual_value', { department, entityType, category, identifierMode: mode });
        await answerCallback(env, q.id);
        await sendMessage(env, q.message.chat.id, mode === 'login'
          ? L(user.language || 'uz', '🔐 Login yoki shartnoma raqamini yuboring. <b>Parol yubormang.</b>', '🔐 Отправьте логин или номер договора. <b>Пароль не отправляйте.</b>')
          : L(user.language || 'uz', '📍 Ulanish manzilini yozing:', '📍 Напишите адрес подключения:'));
        return true;
      }
      if (data.startsWith('uxdup:continue:')) {
        if (!await claimUpdate(env, update.update_id)) return true;
        return continueDuplicate(env, q, data.split(':')[2]);
      }
      if (data === 'uxdup:new') {
        if (!await claimUpdate(env, update.update_id)) return true;
        const user = await upsertUser(env, q.from);
        const s = await getSession(env, user.telegram_id);
        const d = sessionData(s);
        await answerCallback(env, q.id);
        if (s?.state !== 'ux_duplicate' || !d?.pending) {
          await clearSession(env, user.telegram_id);
          return showServiceHub(env, q.message.chat.id, user);
        }
        await createExpressTicket(env, q.message, user, d.pending, true);
        return true;
      }
    }
  }

  const msg = update?.message;
  if (!msg || msg.from?.is_bot) return false;

  if (isGroup(msg.chat)) {
    return handleOperatorText(env, msg);
  }

  if (isPrivate(msg.chat)) {
    const text = String(msg.text || '').trim();
    const start = text.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/i);
    if (start) {
      await saveSource(env, msg.from.id, start[1] || 'direct');
      return false;
    }

    const active = await hasActiveTicket(env, msg.from.id);
    if (active && !text.startsWith('/')) {
      if (!allowRate(msg.from.id)) {
        if (!await claimUpdate(env, update.update_id)) return true;
        const lang = await userLang(env, msg.from.id);
        await sendMessage(env, msg.chat.id, L(lang,
          '⏳ Juda ko‘p xabar yuborildi. 10 soniya kutib, davom eting — murojaatingiz saqlanib turibdi.',
          '⏳ Слишком много сообщений. Подождите 10 секунд и продолжите — обращение сохранено.'));
        return true;
      }
      return false;
    }

    const user = await upsertUser(env, msg.from);
    const s = await getSession(env, user.telegram_id);
    if (s?.state === 'ux_describe') {
      if (!await claimUpdate(env, update.update_id)) return true;
      return handleDescribeMessage(env, msg, user);
    }
    if (s?.state === 'ux_manual_value') {
      if (!await claimUpdate(env, update.update_id)) return true;
      return handleManualValue(env, msg, user, s);
    }
    if (s?.state === 'ux_details') {
      if (!await claimUpdate(env, update.update_id)) return true;
      return handleDetails(env, msg, user, s);
    }
    if (s?.state === 'ux_duplicate') {
      if (!text.startsWith('/')) {
        if (!await claimUpdate(env, update.update_id)) return true;
        await sendMessage(env, msg.chat.id, L(user.language || 'uz',
          '⬆️ Yuqoridagi tugmalardan birini tanlang: mavjud murojaatni davom ettirish yoki yangi yaratish.',
          '⬆️ Выберите кнопку выше: продолжить существующее обращение или создать новое.'));
        return true;
      }
    }

    if (!s && text && !text.startsWith('/') && /^(yordam|help|помощь|operator|оператор|muammo|проблема)$/i.test(text)) {
      if (!await claimUpdate(env, update.update_id)) return true;
      return showServiceHub(env, msg.chat.id, user);
    }
  }
  return false;
}

export async function runV16Maintenance(env) {
  await ensureV16Schema(env);
  await repairBrokenTopics(env);
  await alertBlockedUsers(env);
  await env.DB.prepare("DELETE FROM fn16_processed WHERE created_at < datetime('now','-7 day')").run();
  for (const [k, arr] of rateBuckets.entries()) {
    const fresh = arr.filter(x => Date.now() - x < 60000);
    if (fresh.length) rateBuckets.set(k, fresh); else rateBuckets.delete(k);
  }
}

export async function v16Health(env) {
  await ensureV16Schema(env);
  const [prefs, sources, alerts] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) n FROM fn16_prefs').first(),
    env.DB.prepare('SELECT COUNT(*) n FROM fn16_sources').first(),
    env.DB.prepare('SELECT COUNT(*) n FROM fn16_alerts').first()
  ]);
  return {
    mode: 'customer-service-hub-express-intake-duplicate-guard-operator-copilot',
    saved_preferences: prefs?.n || 0,
    tracked_sources: sources?.n || 0,
    delivery_alerts: alerts?.n || 0
  };
}

export const __test = {
  HELP_CATEGORIES,
  serviceHubKeyboard,
  shorten,
  ASK_TEMPLATES
};
