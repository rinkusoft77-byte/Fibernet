import {
  addMessage, clearSession, closeTicket, getTicket, getUser, setStage
} from './v5-db.js';
import { getDepartmentByChat, getDepartmentChat } from './v7-routing.js';
import { accessLabel, getAccess } from './v14-access.js';
import { categoryMeta, departmentMeta, L, operatorName } from './v8-ui.js';
import { escapeHtml, inlineKeyboard, sendMessage, tg } from './telegram.js';

const now = () => new Date().toISOString();
let ready = false;

const ENV_CHAT_KEYS = {
  tech: 'TECH_CHAT_ID',
  accounting: 'ACCOUNTING_CHAT_ID',
  subscriber: 'SUBSCRIBER_CHAT_ID',
  connection: 'CONNECTION_CHAT_ID',
  general: 'SUPPORT_CHAT_ID'
};

export const V15_SKILLS = [
  'ethernet', 'gpon', 'wifi', 'iptv', 'onu', 'lan',
  'billing', 'documents', 'subscriber', 'legal', 'connection'
];

const PRIORITY_WEIGHT = { critical: 4000, high: 3000, normal: 2000, low: 1000 };

export function normalizeSkills(value = '') {
  return [...new Set(String(value).toLowerCase().split(/[\s,;]+/)
    .map(x => x.trim()).filter(x => V15_SKILLS.includes(x)))];
}

export function requiredSkills(category = '', accessType = '') {
  const out = [];
  if (accessType === 'ethernet') out.push('ethernet');
  if (accessType === 'gpon_onu' || accessType === 'gpon_onuwifi') out.push('gpon');
  if (accessType === 'gpon_onu') out.push('onu');
  if (accessType === 'gpon_onuwifi') out.push('wifi');
  if (category === 'wifi') out.push('wifi');
  if (category === 'iptv') out.push('iptv');
  if (category === 'equipment') out.push('onu');
  if (category === 'lan') out.push('lan');
  if (['payment_missing', 'balance'].includes(category)) out.push('billing');
  if (['documents'].includes(category)) out.push('documents');
  if (['tariff_change', 'account_data', 'suspension', 'static_ip'].includes(category)) out.push('subscriber');
  if (category === 'legal_docs') out.push('legal');
  if (['connection', 'coverage'].includes(category)) out.push('connection');
  return [...new Set(out)];
}

export function assignmentScore({ priority = 'normal', created_at }, required = [], agentSkills = [], load = 0, capacity = 5) {
  const ageMin = Math.max(0, Math.floor((Date.now() - new Date(created_at || Date.now()).getTime()) / 60000));
  const matches = required.filter(x => agentSkills.includes(x)).length;
  const missing = required.length - matches;
  const spare = Math.max(0, capacity - load);
  return (PRIORITY_WEIGHT[priority] || 2000) + Math.min(ageMin, 720) + matches * 250 - missing * 90 + spare * 20 - load * 35;
}

function isPrivate(chat) { return chat?.type === 'private'; }
function isGroup(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
function adminIds(env) { return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String); }
function isAdmin(env, id) { return adminIds(env).includes(String(id)); }
function bodyOf(msg) { return String(msg?.text || msg?.caption || '').trim(); }

export function relayKind(msg = {}) {
  if (msg.text) return 'text';
  if (msg.sticker) return 'sticker';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
  if (msg.video_note) return 'video_note';
  if (msg.animation) return 'animation';
  if (msg.voice) return 'voice';
  if (msg.audio) return 'audio';
  if (msg.document) return 'document';
  if (msg.contact) return 'contact';
  if (msg.location) return 'location';
  if (msg.venue) return 'venue';
  if (msg.poll) return 'poll';
  if (msg.dice) return 'dice';
  return null;
}

export async function ensureV15Schema(env) {
  if (ready) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS fn15_topics (
      ticket_no TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      topic_name TEXT,
      state TEXT NOT NULL DEFAULT 'creating',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id,thread_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn15_topics_thread ON fn15_topics(chat_id,thread_id)`,
    `CREATE TABLE IF NOT EXISTS fn15_agents (
      chat_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      operator_name TEXT,
      username TEXT,
      skills TEXT NOT NULL DEFAULT '[]',
      capacity INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'online',
      last_assigned_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(chat_id,operator_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn15_agents_status ON fn15_agents(chat_id,status,updated_at)`,
    `CREATE TABLE IF NOT EXISTS fn15_macros (
      macro_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      text_uz TEXT NOT NULL,
      text_ru TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn15_mirrors (
      source_chat_id INTEGER NOT NULL,
      source_message_id INTEGER NOT NULL,
      target_chat_id INTEGER NOT NULL,
      target_message_id INTEGER NOT NULL,
      ticket_no TEXT NOT NULL,
      direction TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(source_chat_id,source_message_id,target_chat_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn15_mirror_source ON fn15_mirrors(source_chat_id,source_message_id)`,
    `CREATE TABLE IF NOT EXISTS fn15_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      ticket_no TEXT NOT NULL,
      direction TEXT NOT NULL,
      source_chat_id INTEGER NOT NULL,
      source_message_id INTEGER NOT NULL,
      target_chat_id INTEGER NOT NULL,
      target_thread_id INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn15_outbox_due ON fn15_outbox(next_try_at)`,
    `CREATE TABLE IF NOT EXISTS fn15_processed (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn15_incident_alerts (
      incident_key TEXT PRIMARY KEY,
      last_alert_at TEXT NOT NULL,
      count_at_alert INTEGER NOT NULL DEFAULT 0
    )`
  ];
  for (const sql of statements) await env.DB.prepare(sql).run();

  const macros = [
    ['restart', 'Qurilmani qayta yoqish',
      'Iltimos, ONU/router quvvatini 60 soniyaga o‘chirib, qayta yoqing. Qurilma to‘liq ishga tushgach internetni yana tekshiring.',
      'Пожалуйста, выключите питание ONU/роутера на 60 секунд и включите снова. После полной загрузки устройства проверьте интернет ещё раз.'],
    ['los', 'LOS qizil',
      'Agar ONU’da LOS qizil yonayotgan yoki miltillayotgan bo‘lsa, optik kabelni bukmang va ulagichni ajratmang. Liniya signali texnik tomonidan tekshirilishi kerak.',
      'Если на ONU индикатор LOS горит или мигает красным, не перегибайте оптический кабель и не отсоединяйте коннектор. Требуется проверка линии техником.'],
    ['wifi5', 'Wi-Fi 5 GHz',
      'Router/ONU yonida 5 GHz tarmog‘ida tekshirib ko‘ring. 5 GHz tezroq, 2.4 GHz esa uzoqroq masofa uchun qulay.',
      'Проверьте соединение рядом с роутером/ONU в сети 5 GHz. 5 GHz быстрее, а 2.4 GHz лучше работает на большем расстоянии.'],
    ['cable', 'Kabel tekshiruvi',
      'Ethernet kabelni ikki tomondan qayta ulang, boshqa LAN portni sinang va imkon bo‘lsa boshqa kabel bilan tekshiring.',
      'Переподключите Ethernet-кабель с обеих сторон, попробуйте другой LAN-порт и, если возможно, другой кабель.'],
    ['payment', 'To‘lov tekshiruvi',
      'To‘lov cheki, abonent login/shartnoma raqami, summa va to‘lov vaqtini tayyorlab yuboring. Parol yubormang.',
      'Подготовьте чек, логин/номер договора, сумму и время платежа. Пароль отправлять не нужно.']
  ];
  for (const m of macros) {
    await env.DB.prepare(`INSERT INTO fn15_macros(macro_key,title,text_uz,text_ru,enabled,updated_at)
      VALUES(?,?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(macro_key) DO NOTHING`).bind(...m).run();
  }
  ready = true;
}

async function claimUpdate(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  await ensureV15Schema(env);
  try {
    await env.DB.prepare('INSERT INTO fn15_processed(update_id) VALUES(?)').bind(updateId).run();
    return true;
  } catch (e) {
    const s = String(e).toLowerCase();
    if (s.includes('unique') || s.includes('constraint')) return false;
    throw e;
  }
}

async function routeChat(env, department) {
  const bound = await getDepartmentChat(env, department);
  if (bound?.chat_id) return bound.chat_id;
  const key = ENV_CHAT_KEYS[department] || 'SUPPORT_CHAT_ID';
  return env[key] || env.SUPPORT_CHAT_ID || null;
}

async function event(env, ticketNo, actorType, actorId, name, data = null) {
  try {
    await env.DB.prepare('INSERT INTO fn11_events(ticket_no,actor_type,actor_id,event,data) VALUES(?,?,?,?,?)')
      .bind(ticketNo, actorType, actorId || null, name, data ? JSON.stringify(data) : null).run();
  } catch {}
}

async function setUserLive(env, telegramId, ticketNo) {
  try {
    await env.DB.prepare(`INSERT INTO fn11_user_live(telegram_id,ticket_no,updated_at) VALUES(?,?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET ticket_no=excluded.ticket_no,updated_at=excluded.updated_at`)
      .bind(telegramId, ticketNo, now()).run();
  } catch {}
}

async function activeUserTicket(env, telegramId) {
  // Never infer a customer reply from "has an open ticket" or a recent live
  // pointer. Only an explicit ticket_reply session may bridge private chat to
  // an operator topic.
  const session = await env.DB.prepare('SELECT state,data FROM fn5_sessions WHERE telegram_id=?')
    .bind(telegramId).first();
  if (!session || session.state !== 'ticket_reply') return null;
  try {
    const data = JSON.parse(session.data || '{}');
    if (!data.ticketNo) return null;
    const t = await getTicket(env, data.ticketNo);
    if (t?.status === 'open' && String(t.telegram_id) === String(telegramId)) return t;
  } catch {}
  return null;
}

async function topicForTicket(env, ticketNo) {
  await ensureV15Schema(env);
  return env.DB.prepare('SELECT * FROM fn15_topics WHERE ticket_no=?').bind(ticketNo).first();
}

async function topicFromMessage(env, msg) {
  if (!msg?.message_thread_id) return null;
  const row = await env.DB.prepare(`SELECT ticket_no FROM fn15_topics
    WHERE chat_id=? AND thread_id=? AND state='open'`).bind(msg.chat.id, msg.message_thread_id).first();
  return row?.ticket_no ? getTicket(env, row.ticket_no) : null;
}

function priorityIcon(priority) {
  return priority === 'critical' ? '🚨' : priority === 'high' ? '🔴' : priority === 'low' ? '🟢' : '🟡';
}

function topicButtons(no) {
  return inlineKeyboard([
    [{ text: '👨‍💻 Qabul qilish', callback_data: `op:claim:${no}` }, { text: '✅ Hal qilindi', callback_data: `op:resolve:${no}` }],
    [{ text: '↗️ Boshqa bo‘lim', callback_data: `op:transfer:${no}` }, { text: '❌ Yopish', callback_data: `op:close:${no}` }]
  ]);
}

async function topicHeader(env, t) {
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  const a = await getAccess(env, t.telegram_id);
  let verifiedProfile = null;
  try {
    verifiedProfile = await env.DB.prepare(`SELECT given_name,family_name,status FROM fn18_profiles
      WHERE telegram_id=? AND status='approved'`).bind(t.telegram_id).first();
  } catch {}
  const verifiedName = verifiedProfile
    ? [verifiedProfile.given_name, verifiedProfile.family_name].filter(Boolean).join(' ')
    : null;
  const d = departmentMeta(t.department, lang);
  const c = categoryMeta(t.category, lang);
  const access = a?.access_type ? accessLabel(a.access_type, lang) : L(lang, 'Ko‘rsatilmagan', 'Не указано');
  return [
    `${priorityIcon(t.priority)} <b>${escapeHtml(t.ticket_no)}</b>`,
    `${d.icon} <b>${escapeHtml(d.title)}</b> · ${c.icon} ${escapeHtml(c.title)}`,
    `🌐 ${escapeHtml(access)}`,
    t.assigned_name ? `👨‍💻 ${escapeHtml(t.assigned_name)}` : '👨‍💻 Unassigned',
    '',
    verifiedName ? `✅ <b>${escapeHtml(verifiedName)}</b> · tasdiqlangan profil`
      : `👤 <b>${escapeHtml([u?.first_name, u?.last_name].filter(Boolean).join(' ') || String(t.telegram_id))}</b>`,
    u?.username ? `🔗 @${escapeHtml(u.username)}` : null,
    `🔐 <code>${escapeHtml(t.account_login || '—')}</code>`,
    `📍 ${escapeHtml(t.address || '—')}`,
    `📞 ${escapeHtml(t.phone || '—')}`,
    '',
    `📝 ${escapeHtml(t.description || '—')}`,
    '',
    '💬 Shu topic ichida oddiy xabar/media yuboring — mijozga boradi.',
    '🔒 Ichki izoh uchun xabarni // bilan boshlang. Qo‘shimcha funksiyalar: /operatorhelp'
  ].filter(Boolean).join('\n');
}

function topicName(t, u, accessType) {
  const who = u?.username ? `@${u.username}` : ([u?.first_name, u?.last_name].filter(Boolean).join(' ') || String(t.telegram_id));
  const acc = accessType === 'ethernet' ? 'MET' : accessType?.startsWith('gpon') ? 'GPON' : '';
  return `${priorityIcon(t.priority)} ${t.ticket_no} ${acc} · ${who}`.replace(/\s+/g, ' ').slice(0, 128);
}

async function saveMirror(env, sourceChatId, sourceMessageId, targetChatId, targetMessageId, ticketNo, direction) {
  await env.DB.prepare(`INSERT INTO fn15_mirrors(source_chat_id,source_message_id,target_chat_id,target_message_id,ticket_no,direction)
    VALUES(?,?,?,?,?,?) ON CONFLICT(source_chat_id,source_message_id,target_chat_id)
    DO UPDATE SET target_message_id=excluded.target_message_id,ticket_no=excluded.ticket_no,direction=excluded.direction`)
    .bind(sourceChatId, sourceMessageId, targetChatId, targetMessageId, ticketNo, direction).run();
}

async function enqueueCopy(env, { ticketNo, direction, sourceChatId, sourceMessageId, targetChatId, targetThreadId = null }, error) {
  const key = `${direction}:${sourceChatId}:${sourceMessageId}:${targetChatId}:${targetThreadId || 0}`;
  await env.DB.prepare(`INSERT INTO fn15_outbox(dedupe_key,ticket_no,direction,source_chat_id,source_message_id,target_chat_id,target_thread_id,last_error)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(dedupe_key) DO UPDATE SET last_error=excluded.last_error,next_try_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`)
    .bind(key, ticketNo, direction, sourceChatId, sourceMessageId, targetChatId, targetThreadId, String(error || '').slice(0, 500)).run();
}

async function copyReliable(env, spec) {
  try {
    const copied = await tg(env, 'copyMessage', {
      chat_id: spec.targetChatId,
      from_chat_id: spec.sourceChatId,
      message_id: spec.sourceMessageId,
      ...(spec.targetThreadId ? { message_thread_id: spec.targetThreadId } : {})
    });
    if (copied?.message_id) {
      await saveMirror(env, spec.sourceChatId, spec.sourceMessageId, spec.targetChatId, copied.message_id, spec.ticketNo, spec.direction);
    }
    return { ok: true, messageId: copied?.message_id || null };
  } catch (e) {
    await enqueueCopy(env, spec, e);
    return { ok: false, error: String(e) };
  }
}

async function atomicClaim(env, t, op) {
  const r = await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=?,assigned_name=?,
    stage=CASE WHEN stage='new' THEN 'in_progress' ELSE stage END,updated_at=?
    WHERE ticket_no=? AND status='open' AND (assigned_to IS NULL OR assigned_to=?)`)
    .bind(op.id, op.name, now(), t.ticket_no, op.id).run();
  return (r.meta?.changes || 0) > 0;
}

async function notifyCustomerAssigned(env, t, op) {
  const u = await getUser(env, t.telegram_id);
  try {
    await sendMessage(env, t.telegram_id, L(u?.language || 'uz',
      `👨‍💻 <b>Operator biriktirildi</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\n${escapeHtml(op.name)} murojaatingizni ko‘rib chiqmoqda.`,
      `👨‍💻 <b>Назначен оператор</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\n${escapeHtml(op.name)} рассматривает ваше обращение.`));
  } catch {}
}

async function agentLoadMap(env) {
  const r = await env.DB.prepare(`SELECT assigned_to,COUNT(*) n FROM fn5_tickets
    WHERE status='open' AND assigned_to IS NOT NULL GROUP BY assigned_to`).all();
  return new Map((r.results || []).map(x => [String(x.assigned_to), Number(x.n || 0)]));
}

async function autoAssign(env, t, topic = null) {
  if (!t || t.status !== 'open' || t.assigned_to) return null;
  const chatId = topic?.chat_id || t.support_chat_id || await routeChat(env, t.department);
  if (!chatId) return null;
  let agentsR;
  try {
    agentsR = await env.DB.prepare(`SELECT a.* FROM fn15_agents a
      JOIN fn19_operator_acl acl ON acl.chat_id=a.chat_id AND acl.user_id=a.operator_id
      WHERE a.chat_id=? AND a.status='online' AND acl.status='approved'
        AND datetime(a.updated_at)>=datetime('now','-12 hours')`).bind(chatId).all();
  } catch {
    // v19 ACL is the security boundary for auto-assignment. If it is not ready,
    // keep the ticket unassigned instead of routing it to an unverified member.
    agentsR = { results: [] };
  }
  const agents = agentsR.results || [];
  if (!agents.length) return null;
  const access = await getAccess(env, t.telegram_id);
  const required = requiredSkills(t.category, access?.access_type || '');
  const loads = await agentLoadMap(env);
  const scored = agents.map(a => {
    let skills = [];
    try { skills = JSON.parse(a.skills || '[]'); } catch {}
    const load = loads.get(String(a.operator_id)) || 0;
    return {
      agent: a, load,
      score: load >= Number(a.capacity || 5) ? -Infinity :
        assignmentScore(t, required, skills, load, Number(a.capacity || 5))
    };
  }).filter(x => Number.isFinite(x.score)).sort((a, b) =>
    b.score - a.score || String(a.agent.last_assigned_at || '').localeCompare(String(b.agent.last_assigned_at || ''))
  );
  const best = scored[0];
  if (!best) return null;
  const op = { id: best.agent.operator_id, name: best.agent.operator_name || best.agent.username || String(best.agent.operator_id) };
  if (!await atomicClaim(env, t, op)) return null;
  await env.DB.prepare('UPDATE fn15_agents SET last_assigned_at=?,updated_at=? WHERE chat_id=? AND operator_id=?')
    .bind(now(), now(), chatId, op.id).run();
  await event(env, t.ticket_no, 'system', null, 'auto_assigned_v15', {
    operator_id: op.id, skills: required, score: best.score, load: best.load
  });
  await notifyCustomerAssigned(env, t, op);
  if (topic?.thread_id) {
    try {
      await sendMessage(env, chatId,
        `🤖 <b>Smart routing</b> → ${escapeHtml(op.name)}\n🎯 Skills: ${escapeHtml(required.join(', ') || 'general')}\n📦 Load: ${best.load}/${best.agent.capacity}`,
        { message_thread_id: topic.thread_id });
    } catch {}
  }
  return op;
}

export async function ensureTopicForTicket(env, ticketNo) {
  await ensureV15Schema(env);
  let t = await getTicket(env, ticketNo);
  if (!t || t.status !== 'open') return null;

  let existing = await topicForTicket(env, ticketNo);
  if (existing?.thread_id && existing.state === 'open') {
    if (!t.support_chat_id || String(t.support_chat_id) === String(existing.chat_id)) return existing;
    try { await tg(env, 'closeForumTopic', { chat_id: existing.chat_id, message_thread_id: existing.thread_id }); } catch {}
    await env.DB.prepare('DELETE FROM fn15_topics WHERE ticket_no=?').bind(ticketNo).run();
    existing = null;
  }
  if (existing?.state === 'creating') return null;
  if (existing?.state === 'unsupported') {
    const age = Date.now() - new Date(existing.updated_at || 0).getTime();
    if (age < 6 * 3600000) return null;
    await env.DB.prepare('DELETE FROM fn15_topics WHERE ticket_no=?').bind(ticketNo).run();
  }

  const chatId = t.support_chat_id || await routeChat(env, t.department);
  if (!chatId) return null;
  const lock = await env.DB.prepare(`INSERT INTO fn15_topics(ticket_no,chat_id,state,updated_at)
    VALUES(?,?,'creating',CURRENT_TIMESTAMP) ON CONFLICT(ticket_no) DO NOTHING`).bind(ticketNo, chatId).run();
  if ((lock.meta?.changes || 0) === 0) return topicForTicket(env, ticketNo);

  try {
    const chat = await tg(env, 'getChat', { chat_id: chatId });
    if (!chat?.is_forum) throw new Error('operator group is not forum-enabled');
    const u = await getUser(env, t.telegram_id);
    const access = await getAccess(env, t.telegram_id);
    const name = topicName(t, u, access?.access_type || '');
    const topic = await tg(env, 'createForumTopic', { chat_id: chatId, name });
    await env.DB.prepare(`UPDATE fn15_topics SET thread_id=?,topic_name=?,state='open',updated_at=CURRENT_TIMESTAMP
      WHERE ticket_no=?`).bind(topic.message_thread_id, name, ticketNo).run();

    const header = await sendMessage(env, chatId, await topicHeader(env, t), {
      message_thread_id: topic.message_thread_id,
      reply_markup: topicButtons(ticketNo)
    });
    try {
      await tg(env, 'pinChatMessage', {
        chat_id: chatId,
        message_id: header.message_id,
        disable_notification: true
      });
    } catch (e) {
      console.warn('v15 topic pin ignored', String(e));
    }
    try {
      await env.DB.prepare(`INSERT INTO fn11_bridge(chat_id,message_id,ticket_no,direction)
        VALUES(?,?,?,'topic_header') ON CONFLICT(chat_id,message_id) DO UPDATE SET ticket_no=excluded.ticket_no`)
        .bind(chatId, header.message_id, ticketNo).run();
    } catch {}
    const saved = await topicForTicket(env, ticketNo);
    await event(env, ticketNo, 'system', null, 'forum_topic_created', { chat_id: chatId, thread_id: topic.message_thread_id });
    t = await getTicket(env, ticketNo);
    await autoAssign(env, t, saved);
    return saved;
  } catch (e) {
    await env.DB.prepare(`UPDATE fn15_topics SET state='unsupported',updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?`)
      .bind(ticketNo).run();
    console.warn('v15 topic unavailable', ticketNo, String(e));
    return null;
  }
}

async function registerAgent(env, msg, patch = {}) {
  await ensureV15Schema(env);
  const current = await env.DB.prepare('SELECT * FROM fn15_agents WHERE chat_id=? AND operator_id=?')
    .bind(msg.chat.id, msg.from.id).first();
  let skills = current?.skills || '[]';
  if (patch.skills) skills = JSON.stringify(patch.skills);
  const capacity = patch.capacity ?? current?.capacity ?? 5;
  const status = patch.status ?? current?.status ?? 'online';
  await env.DB.prepare(`INSERT INTO fn15_agents(chat_id,operator_id,operator_name,username,skills,capacity,status,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,operator_id) DO UPDATE SET operator_name=excluded.operator_name,username=excluded.username,
      skills=excluded.skills,capacity=excluded.capacity,status=excluded.status,updated_at=excluded.updated_at`)
    .bind(msg.chat.id, msg.from.id, operatorName(msg.from), msg.from.username || null, skills, capacity, status, now()).run();
  return env.DB.prepare('SELECT * FROM fn15_agents WHERE chat_id=? AND operator_id=?').bind(msg.chat.id, msg.from.id).first();
}

async function agentCard(env, msg) {
  const a = await registerAgent(env, msg);
  let skills = [];
  try { skills = JSON.parse(a.skills || '[]'); } catch {}
  const load = await env.DB.prepare(`SELECT COUNT(*) n FROM fn5_tickets WHERE status='open' AND assigned_to=?`)
    .bind(msg.from.id).first();
  await sendMessage(env, msg.chat.id, [
    '👨‍💻 <b>Operator profili</b>',
    `👤 ${escapeHtml(a.operator_name || operatorName(msg.from))}`,
    `🟢 Status: <b>${escapeHtml(a.status)}</b>`,
    `📦 Load: <b>${load?.n || 0}/${a.capacity}</b>`,
    `🎯 Skills: <code>${escapeHtml(skills.join(', ') || 'general')}</code>`,
    '',
    'Sozlash: /skills gpon,wifi,iptv · /capacity 5 · /available · /away'
  ].join('\n'));
}

async function smartNext(env, msg) {
  const dep = await getDepartmentByChat(env, msg.chat.id);
  if (!dep?.department) {
    await sendMessage(env, msg.chat.id, '⚠️ Avval guruhni /setup orqali bo‘limga ulang.');
    return true;
  }
  const a = await registerAgent(env, msg, { status: 'online' });
  const loadRow = await env.DB.prepare(`SELECT COUNT(*) n FROM fn5_tickets WHERE status='open' AND assigned_to=?`)
    .bind(msg.from.id).first();
  const load = Number(loadRow?.n || 0);
  if (load >= Number(a.capacity || 5)) {
    await sendMessage(env, msg.chat.id, `📦 Capacity to‘liq: <b>${load}/${a.capacity}</b>. Avval mavjud ticketlardan birini yakunlang.`);
    return true;
  }

  const r = await env.DB.prepare(`SELECT * FROM fn5_tickets WHERE status='open' AND assigned_to IS NULL AND department=?
    ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,id ASC LIMIT 40`)
    .bind(dep.department).all();
  const rows = r.results || [];
  if (!rows.length) {
    await sendMessage(env, msg.chat.id, '✅ Qabul qilinmagan ticket yo‘q.');
    return true;
  }
  let skills = [];
  try { skills = JSON.parse(a.skills || '[]'); } catch {}
  const scored = [];
  for (const t of rows) {
    const access = await getAccess(env, t.telegram_id);
    const req = requiredSkills(t.category, access?.access_type || '');
    scored.push({ t, req, score: assignmentScore(t, req, skills, load, Number(a.capacity || 5)) });
  }
  scored.sort((x, y) => y.score - x.score || x.t.id - y.t.id);
  const chosen = scored[0];
  const op = { id: msg.from.id, name: operatorName(msg.from) };
  if (!await atomicClaim(env, chosen.t, op)) return smartNext(env, msg);
  await env.DB.prepare('UPDATE fn15_agents SET last_assigned_at=?,updated_at=? WHERE chat_id=? AND operator_id=?')
    .bind(now(), now(), msg.chat.id, msg.from.id).run();
  await event(env, chosen.t.ticket_no, 'operator', msg.from.id, 'smartnext_claim', { required: chosen.req, score: chosen.score });
  const topic = await ensureTopicForTicket(env, chosen.t.ticket_no);
  await notifyCustomerAssigned(env, chosen.t, op);
  await sendMessage(env, msg.chat.id,
    `✅ <b>SmartNext</b> → <code>${escapeHtml(chosen.t.ticket_no)}</code>\n🎯 ${escapeHtml(chosen.req.join(', ') || 'general')}\n⭐ Score: ${chosen.score}`,
    topic?.thread_id ? { message_thread_id: topic.thread_id } : {});
  return true;
}

async function macroList(env, msg) {
  const r = await env.DB.prepare('SELECT macro_key,title FROM fn15_macros WHERE enabled=1 ORDER BY macro_key').all();
  const body = (r.results || []).map(x => `/<code>use ${escapeHtml(x.macro_key)}</code> — ${escapeHtml(x.title)}`).join('\n');
  await sendMessage(env, msg.chat.id, `⚡ <b>Quick replies</b>\n\n${body || '—'}`,
    msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {});
}

async function useMacro(env, msg, t, key) {
  const m = await env.DB.prepare('SELECT * FROM fn15_macros WHERE macro_key=? AND enabled=1').bind(key).first();
  if (!m) {
    await sendMessage(env, msg.chat.id, '⚠️ Macro topilmadi. /macros',
      msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {});
    return true;
  }
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  const text = lang === 'ru' ? m.text_ru : m.text_uz;
  await sendMessage(env, t.telegram_id,
    `👨‍💻 <b>FiberNet ${L(lang, 'operatori', 'оператор')}</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\n${escapeHtml(text)}`);
  await addMessage(env, t.ticket_no, 'operator', msg.from.id, `[macro:${key}] ${text}`, msg.message_id);
  await setStage(env, t.ticket_no, 'waiting_customer', { id: msg.from.id, name: operatorName(msg.from) });
  await setUserLive(env, t.telegram_id, t.ticket_no);
  await event(env, t.ticket_no, 'operator', msg.from.id, 'macro_reply', { key });
  return true;
}

async function topicCommand(env, msg, t) {
  const text = String(msg.text || '').trim();
  if (!text.startsWith('/')) return false;
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.replace(/@\w+$/, '').toLowerCase();
  const arg = rest.join(' ').trim();
  const op = { id: msg.from.id, name: operatorName(msg.from) };

  if (cmd === '/topichelp') {
    await sendMessage(env, msg.chat.id, [
      '🧵 <b>FiberNet Topic Helpdesk</b>',
      '',
      '/claim — ticketni olish',
      '/release — navbatga qaytarish',
      '/resolve — hal qilindi',
      '/close — yopish va topicni yopish',
      '/note matn — ichki izoh',
      '/priority critical|high|normal|low',
      '/macros — tayyor javoblar',
      '/use key — tayyor javobni mijozga yuborish',
      '',
      'Oddiy text/media/sticker → mijozga yuboriladi.'
    ].join('\n'), { message_thread_id: msg.message_thread_id });
    return true;
  }

  if (cmd === '/claim') {
    const ok = await atomicClaim(env, t, op);
    await sendMessage(env, msg.chat.id, ok ? `✅ ${escapeHtml(op.name)} ticketni qabul qildi.` : '⚠️ Ticket boshqa operatorga biriktirilgan.',
      { message_thread_id: msg.message_thread_id });
    if (ok) {
      await event(env, t.ticket_no, 'operator', op.id, 'topic_claim');
      await notifyCustomerAssigned(env, t, op);
    }
    return true;
  }

  if (cmd === '/release') {
    if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) {
      await sendMessage(env, msg.chat.id, '⛔ Faqat biriktirilgan operator yoki admin.', { message_thread_id: msg.message_thread_id });
      return true;
    }
    await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=NULL,assigned_name=NULL,stage='new',updated_at=? WHERE ticket_no=? AND status='open'`)
      .bind(now(), t.ticket_no).run();
    await event(env, t.ticket_no, 'operator', op.id, 'topic_release');
    await sendMessage(env, msg.chat.id, '♻️ Ticket navbatga qaytarildi.', { message_thread_id: msg.message_thread_id });
    return true;
  }

  if (cmd === '/resolve') {
    if (!t.assigned_to) await atomicClaim(env, t, op);
    await setStage(env, t.ticket_no, 'resolved', op);
    await event(env, t.ticket_no, 'operator', op.id, 'topic_resolve');
    const u = await getUser(env, t.telegram_id);
    await sendMessage(env, t.telegram_id, L(u?.language || 'uz',
      `✅ <b>Murojaat hal qilindi</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\nMuammo davom etsa shu botga yozing.`,
      `✅ <b>Обращение решено</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\nЕсли проблема осталась, напишите в этот бот.`));
    await sendMessage(env, msg.chat.id, '✅ Hal qilindi.', { message_thread_id: msg.message_thread_id });
    return true;
  }

  if (cmd === '/close') {
    if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) {
      await sendMessage(env, msg.chat.id, '⛔ Faqat biriktirilgan operator yoki admin.', { message_thread_id: msg.message_thread_id });
      return true;
    }
    await closeTicket(env, t.ticket_no);
    await event(env, t.ticket_no, 'operator', op.id, 'topic_close');
    const u = await getUser(env, t.telegram_id);
    try { await sendMessage(env, t.telegram_id, L(u?.language || 'uz',
      `✅ Murojaat yopildi: <code>${escapeHtml(t.ticket_no)}</code>`,
      `✅ Обращение закрыто: <code>${escapeHtml(t.ticket_no)}</code>`)); } catch {}
    await sendMessage(env, msg.chat.id, '⚫️ Ticket yopildi. Topic ham yopiladi.', { message_thread_id: msg.message_thread_id });
    try { await tg(env, 'closeForumTopic', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id }); } catch {}
    await env.DB.prepare(`UPDATE fn15_topics SET state='closed',updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?`).bind(t.ticket_no).run();
    return true;
  }

  if (cmd === '/priority') {
    const p = arg.toLowerCase();
    if (!['critical', 'high', 'normal', 'low'].includes(p)) {
      await sendMessage(env, msg.chat.id, 'Format: /priority critical|high|normal|low', { message_thread_id: msg.message_thread_id });
      return true;
    }
    await env.DB.prepare('UPDATE fn5_tickets SET priority=?,updated_at=? WHERE ticket_no=? AND status=\'open\'')
      .bind(p, now(), t.ticket_no).run();
    await event(env, t.ticket_no, 'operator', op.id, 'topic_priority', { priority: p });
    await sendMessage(env, msg.chat.id, `✅ Priority → <b>${p}</b>`, { message_thread_id: msg.message_thread_id });
    return true;
  }

  if (cmd === '/note') {
    if (!arg) {
      await sendMessage(env, msg.chat.id, 'Format: /note ichki izoh', { message_thread_id: msg.message_thread_id });
      return true;
    }
    try {
      await env.DB.prepare(`INSERT INTO fn13_internal_notes(ticket_no,operator_id,operator_name,note)
        VALUES(?,?,?,?)`).bind(t.ticket_no, op.id, op.name, arg.slice(0, 1500)).run();
    } catch {}
    await event(env, t.ticket_no, 'operator', op.id, 'topic_note', { note: arg.slice(0, 300) });
    await sendMessage(env, msg.chat.id, '📝 Ichki izoh saqlandi. Mijoz buni ko‘rmaydi.', { message_thread_id: msg.message_thread_id });
    return true;
  }

  if (cmd === '/macros') return macroList(env, msg);
  if (cmd === '/use') return useMacro(env, msg, t, arg.toLowerCase());
  return false;
}

async function operatorTopicRelay(env, msg, t) {
  if (!relayKind(msg)) return false;
  const op = { id: msg.from.id, name: operatorName(msg.from) };
  if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) {
    await sendMessage(env, msg.chat.id,
      `⛔ Ticket <b>${escapeHtml(t.assigned_name || String(t.assigned_to))}</b> operatoriga biriktirilgan.`,
      { message_thread_id: msg.message_thread_id });
    return true;
  }
  if (!t.assigned_to && !await atomicClaim(env, t, op)) return true;

  const spec = {
    ticketNo: t.ticket_no,
    direction: 'operator_to_user',
    sourceChatId: msg.chat.id,
    sourceMessageId: msg.message_id,
    targetChatId: t.telegram_id
  };
  const r = await copyReliable(env, spec);
  if (!r.ok) {
    await sendMessage(env, msg.chat.id, '⏳ Xabar delivery queue’ga qo‘yildi. Bot avtomatik qayta urinadi.',
      { message_thread_id: msg.message_thread_id });
    return true;
  }
  await addMessage(env, t.ticket_no, 'operator', op.id, bodyOf(msg) || `[${relayKind(msg)}]`, msg.message_id);
  await setStage(env, t.ticket_no, 'waiting_customer', op);
  await setUserLive(env, t.telegram_id, t.ticket_no);
  await event(env, t.ticket_no, 'operator', op.id, 'topic_reply', { kind: relayKind(msg) });
  try {
    await tg(env, 'setMessageReaction', { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] });
  } catch {}
  return true;
}

async function userTopicRelay(env, msg, t, topic) {
  const kind = relayKind(msg);
  if (!kind) return false;
  const spec = {
    ticketNo: t.ticket_no,
    direction: 'user_to_operator',
    sourceChatId: msg.chat.id,
    sourceMessageId: msg.message_id,
    targetChatId: topic.chat_id,
    targetThreadId: topic.thread_id
  };
  const r = await copyReliable(env, spec);
  if (!r.ok) {
    // The exact submitted message is already queued. End the explicit reply
    // session so subsequent bot navigation/text cannot leak to the group.
    await clearSession(env, msg.from.id);
    const u = await getUser(env, t.telegram_id);
    await sendMessage(env, msg.chat.id, L(u?.language || 'uz',
      '⏳ Xabaringiz saqlandi. Operator guruhiga yuborish avtomatik qayta urinadi.',
      '⏳ Сообщение сохранено. Бот автоматически повторит отправку оператору.'));
    return true;
  }
  await clearSession(env, msg.from.id);
  await addMessage(env, t.ticket_no, 'user', msg.from.id, bodyOf(msg) || `[${kind}]`, msg.message_id);
  await setStage(env, t.ticket_no, 'in_progress');
  await setUserLive(env, msg.from.id, t.ticket_no);
  await event(env, t.ticket_no, 'user', msg.from.id, 'topic_customer_reply', { kind });
  try {
    await tg(env, 'setMessageReaction', { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] });
  } catch {}
  return true;
}

async function syncEditedMessage(env, msg) {
  if (!msg?.chat?.id || !msg.message_id) return false;
  const r = await env.DB.prepare(`SELECT * FROM fn15_mirrors WHERE source_chat_id=? AND source_message_id=?`)
    .bind(msg.chat.id, msg.message_id).all();
  const rows = r.results || [];
  if (!rows.length) return false;
  for (const m of rows) {
    try {
      if (msg.text != null) {
        await tg(env, 'editMessageText', {
          chat_id: m.target_chat_id,
          message_id: m.target_message_id,
          text: msg.text,
          entities: msg.entities || undefined
        });
      } else if (msg.caption != null) {
        await tg(env, 'editMessageCaption', {
          chat_id: m.target_chat_id,
          message_id: m.target_message_id,
          caption: msg.caption,
          caption_entities: msg.caption_entities || undefined
        });
      }
      await event(env, m.ticket_no, isPrivate(msg.chat) ? 'user' : 'operator', msg.from?.id || null, 'message_edit_synced');
    } catch (e) {
      console.warn('v15 edit sync ignored', String(e));
    }
  }
  return true;
}

async function handleGroupProfessionalCommand(env, msg) {
  if (!isGroup(msg.chat) || msg.from?.is_bot || !msg.text) return false;
  const text = msg.text.trim();
  const dep = await getDepartmentByChat(env, msg.chat.id);
  if (!dep?.department && !/^\/(agent|skills|capacity|available|away|smartnext|v15help)(?:@\w+)?\b/i.test(text)) return false;

  const skillMatch = text.match(/^\/skills(?:@\w+)?(?:\s+(.+))?$/i);
  if (skillMatch) {
    const skills = normalizeSkills(skillMatch[1] || '');
    const a = await registerAgent(env, msg, { skills });
    await sendMessage(env, msg.chat.id,
      `🎯 Skills saqlandi: <code>${escapeHtml(skills.join(', ') || 'general')}</code>\n📦 Capacity: ${a.capacity}`);
    return true;
  }

  const cap = text.match(/^\/capacity(?:@\w+)?\s+(\d{1,2})$/i);
  if (cap) {
    const n = Math.max(1, Math.min(20, Number(cap[1])));
    await registerAgent(env, msg, { capacity: n });
    await sendMessage(env, msg.chat.id, `📦 Operator capacity → <b>${n}</b>`);
    return true;
  }

  if (/^\/available(?:@\w+)?$/i.test(text)) {
    await registerAgent(env, msg, { status: 'online' });
    await sendMessage(env, msg.chat.id, '🟢 Operator online. Smart routing sizga ticket bera oladi.');
    return true;
  }
  if (/^\/away(?:@\w+)?$/i.test(text)) {
    await registerAgent(env, msg, { status: 'away' });
    await sendMessage(env, msg.chat.id, '🟡 Operator away. Yangi auto-assignment berilmaydi.');
    return true;
  }
  if (/^\/agent(?:@\w+)?$/i.test(text)) { await agentCard(env, msg); return true; }
  if (/^\/smartnext(?:@\w+)?$/i.test(text)) return smartNext(env, msg);
  if (/^\/macros(?:@\w+)?$/i.test(text)) { await macroList(env, msg); return true; }
  if (/^\/v15help(?:@\w+)?$/i.test(text)) {
    await sendMessage(env, msg.chat.id, [
      '🧠 <b>FiberNet Professional Routing</b>',
      '',
      '/agent — profil/load',
      '/available · /away — status',
      '/skills gpon,wifi,iptv — mutaxassislik',
      '/capacity 5 — bir vaqtdagi ticket limiti',
      '/smartnext — skill + priority + SLA bo‘yicha keyingi ticket',
      '/macros — quick replies',
      '',
      'Forum Topics yoqilgan bo‘lsa har ticket alohida topic’da ishlaydi.'
    ].join('\n'));
    return true;
  }
  return false;
}

async function detectIncidentBurst(env, t) {
  if (!t || t.department !== 'tech' || t.category !== 'no_internet') return;
  const access = await getAccess(env, t.telegram_id);
  const kind = access?.access_type || 'unknown';
  const r = await env.DB.prepare(`SELECT COUNT(*) n FROM fn5_tickets x
    LEFT JOIN fn14_user_access a ON a.telegram_id=x.telegram_id
    WHERE x.department='tech' AND x.category='no_internet'
      AND datetime(x.created_at)>=datetime('now','-15 minutes')
      AND COALESCE(a.access_type,'unknown')=?`).bind(kind).first();
  const count = Number(r?.n || 0);
  if (count < 5) return;
  const key = `no_internet:${kind}`;
  const old = await env.DB.prepare('SELECT * FROM fn15_incident_alerts WHERE incident_key=?').bind(key).first();
  if (old && Date.now() - new Date(old.last_alert_at).getTime() < 30 * 60000) return;
  await env.DB.prepare(`INSERT INTO fn15_incident_alerts(incident_key,last_alert_at,count_at_alert)
    VALUES(?,?,?) ON CONFLICT(incident_key) DO UPDATE SET last_alert_at=excluded.last_alert_at,count_at_alert=excluded.count_at_alert`)
    .bind(key, now(), count).run();
  const chatId = await routeChat(env, 'tech');
  if (!chatId) return;
  await sendMessage(env, chatId, [
    '🚨 <b>Ehtimoliy ommaviy nosozlik</b>',
    `🌐 Tarmoq: <b>${escapeHtml(accessLabel(kind, 'uz'))}</b>`,
    `📈 Oxirgi 15 daqiqada “Internet yo‘q”: <b>${count}</b>`,
    '',
    'Bir xil hudud/uzel bo‘yicha ekanini tekshiring. Zarur bo‘lsa ommaviy incident sifatida boshqaring.'
  ].join('\n'));
  await event(env, t.ticket_no, 'system', null, 'incident_burst_alert', { access_type: kind, count });
}

async function observeTicketAfterUpdate(env, update) {
  const userId = update?.message?.chat?.type === 'private' ? update.message.from?.id :
    update?.callback_query?.message?.chat?.type === 'private' ? update.callback_query.from?.id : null;
  let ticketNo = null;
  const cb = String(update?.callback_query?.data || '');
  const m = cb.match(/(FN-\d{6}-[A-Z0-9]{6})/i);
  if (m) ticketNo = m[1].toUpperCase();
  if (!ticketNo && userId) {
    const row = await env.DB.prepare(`SELECT ticket_no FROM fn5_tickets WHERE telegram_id=? AND status='open' ORDER BY id DESC LIMIT 1`)
      .bind(userId).first();
    ticketNo = row?.ticket_no || null;
  }
  if (!ticketNo) return;
  const t = await getTicket(env, ticketNo);
  if (!t) return;
  if (t.status === 'open') {
    const topic = await ensureTopicForTicket(env, ticketNo);
    if (topic) await detectIncidentBurst(env, t);
  } else {
    const topic = await topicForTicket(env, ticketNo);
    if (topic?.thread_id && topic.state === 'open') {
      try { await tg(env, 'closeForumTopic', { chat_id: topic.chat_id, message_thread_id: topic.thread_id }); } catch {}
      await env.DB.prepare(`UPDATE fn15_topics SET state='closed',updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?`).bind(ticketNo).run();
    }
  }
}

async function retryOutbox(env) {
  const r = await env.DB.prepare(`SELECT * FROM fn15_outbox WHERE datetime(next_try_at)<=datetime('now')
    ORDER BY id ASC LIMIT 30`).all();
  for (const x of r.results || []) {
    try {
      const copied = await tg(env, 'copyMessage', {
        chat_id: x.target_chat_id,
        from_chat_id: x.source_chat_id,
        message_id: x.source_message_id,
        ...(x.target_thread_id ? { message_thread_id: x.target_thread_id } : {})
      });
      if (copied?.message_id) {
        await saveMirror(env, x.source_chat_id, x.source_message_id, x.target_chat_id, copied.message_id, x.ticket_no, x.direction);
      }
      await env.DB.prepare('DELETE FROM fn15_outbox WHERE id=?').bind(x.id).run();
      await event(env, x.ticket_no, 'system', null, 'outbox_delivered', { direction: x.direction, attempts: x.attempts });
    } catch (e) {
      await env.DB.prepare(`UPDATE fn15_outbox SET attempts=attempts+1,last_error=?,
        next_try_at=datetime('now',CASE WHEN attempts<2 THEN '+1 minute' WHEN attempts<5 THEN '+5 minutes' ELSE '+20 minutes' END),
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(String(e).slice(0, 500), x.id).run();
    }
  }
}

async function closeFinishedTopics(env) {
  const r = await env.DB.prepare(`SELECT p.* FROM fn15_topics p JOIN fn5_tickets t ON t.ticket_no=p.ticket_no
    WHERE p.state='open' AND t.status='closed' LIMIT 30`).all();
  for (const x of r.results || []) {
    try { await tg(env, 'closeForumTopic', { chat_id: x.chat_id, message_thread_id: x.thread_id }); } catch {}
    await env.DB.prepare(`UPDATE fn15_topics SET state='closed',updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?`).bind(x.ticket_no).run();
  }
}

export async function handleV15Update(env, update) {
  await ensureV15Schema(env);

  if (update?.edited_message) return syncEditedMessage(env, update.edited_message);

  const msg = update?.message;
  if (!msg || msg.from?.is_bot) return false;

  if (isGroup(msg.chat)) {
    if (await handleGroupProfessionalCommand(env, msg)) return true;
    if (!msg.message_thread_id) return false;
    const t = await topicFromMessage(env, msg);
    if (!t) return false;
    if (!await claimUpdate(env, update.update_id)) return true;
    if (await topicCommand(env, msg, t)) return true;
    return operatorTopicRelay(env, msg, t);
  }

  if (isPrivate(msg.chat)) {
    const text = String(msg.text || '').trim();
    if (text.startsWith('/')) return false;
    const t = await activeUserTicket(env, msg.from.id);
    if (!t) return false;
    const topic = await ensureTopicForTicket(env, t.ticket_no);
    if (!topic?.thread_id || topic.state !== 'open') return false;
    if (!await claimUpdate(env, update.update_id)) return true;
    return userTopicRelay(env, msg, t, topic);
  }

  return false;
}

export async function observeV15After(env, update) {
  await ensureV15Schema(env);
  await observeTicketAfterUpdate(env, update);
}

export async function runV15Maintenance(env) {
  await ensureV15Schema(env);
  await retryOutbox(env);
  await closeFinishedTopics(env);
  await env.DB.prepare("DELETE FROM fn15_processed WHERE created_at < datetime('now','-7 day')").run();
  await env.DB.prepare("DELETE FROM fn15_mirrors WHERE created_at < datetime('now','-30 day')").run();
  await env.DB.prepare("DELETE FROM fn15_agents WHERE datetime(updated_at) < datetime('now','-30 day')").run();
}

export async function v15Health(env) {
  await ensureV15Schema(env);
  const [topics, agents, outbox] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) n FROM fn15_topics WHERE state='open'").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM fn15_agents WHERE status='online' AND datetime(updated_at)>=datetime('now','-12 hours')").first(),
    env.DB.prepare('SELECT COUNT(*) n FROM fn15_outbox').first()
  ]);
  return {
    mode: 'forum-topics-smart-routing-macros-outbox-edit-sync-incident-detection',
    open_topics: topics?.n || 0,
    online_agents: agents?.n || 0,
    pending_outbox: outbox?.n || 0,
    skills: V15_SKILLS
  };
}

export const __test = { normalizeSkills, requiredSkills, assignmentScore, relayKind };
