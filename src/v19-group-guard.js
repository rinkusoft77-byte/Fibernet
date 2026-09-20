import {
  addMessage, assignTicket, getTicket, getTicketBySupportMessage, getUser, setStage
} from './v5-db.js';
import {
  getDepartmentByChat, unbindDepartment
} from './v7-routing.js';
import { L, operatorName } from './v8-ui.js';
import { answerCallback, escapeHtml, inlineKeyboard, sendMessage, tg } from './telegram.js';

const now = () => new Date().toISOString();
let ready = false;
const adminCache = new Map();

const OPERATOR_COMMANDS = new Set([
  'where','queue','tickets','stats','cancelreply',
  'prohelp','dashboard','next','my','unassigned','overdue','online','offline','agents',
  'note','priority','release','timeline',
  'agent','available','away','skills','capacity','smartnext','macros','v15help',
  'topichelp','claim','resolve','close','use',
  'panel','find','assign','snooze','sla','tag','undo','deleteboth','quick','ask','summary','operatorhelp',
  'profiles','client'
]);

const MANAGER_COMMANDS = new Set([
  'setup','bind','unbind','routes'
]);

export function commandName(text = '') {
  const m = String(text).trim().match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/);
  return m ? m[1].toLowerCase() : null;
}

export function extractTicketNo(value = '') {
  return String(value).toUpperCase().match(/FN-\d{6}-[A-Z0-9]{6}/)?.[0] || null;
}

export function isKnownOperatorCommand(name) {
  return Boolean(name && (OPERATOR_COMMANDS.has(name) || MANAGER_COMMANDS.has(name)));
}

function isGroup(chat) {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

function globalAdminIds(env) {
  return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String);
}

function isGlobalAdmin(env, userId) {
  return globalAdminIds(env).includes(String(userId));
}

export async function ensureV19Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn19_operator_acl (
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      display_name TEXT,
      username TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT,
      approved_by INTEGER,
      approved_at TEXT,
      revoked_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(chat_id,user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn19_acl_status ON fn19_operator_acl(chat_id,status,updated_at)`,
    `CREATE TABLE IF NOT EXISTS fn19_group_guard_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      user_id INTEGER,
      event TEXT NOT NULL,
      command TEXT,
      thread_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn19_guard_events ON fn19_group_guard_events(chat_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS fn19_reply_sessions (
      chat_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      ticket_no TEXT NOT NULL,
      prompt_message_id INTEGER,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(chat_id,operator_id)
    )`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

async function audit(env, chatId, userId, event, command = null, threadId = null) {
  try {
    await env.DB.prepare(`INSERT INTO fn19_group_guard_events(chat_id,user_id,event,command,thread_id)
      VALUES(?,?,?,?,?)`).bind(chatId || null, userId || null, event, command || null, threadId || null).run();
  } catch {}
}

async function aclRow(env, chatId, userId) {
  await ensureV19Schema(env);
  return env.DB.prepare('SELECT * FROM fn19_operator_acl WHERE chat_id=? AND user_id=?')
    .bind(chatId, userId).first();
}

async function telegramManager(env, chatId, userId) {
  if (!chatId || !userId) return false;
  const key = `${chatId}:${userId}`;
  const cached = adminCache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  let value = false;
  try {
    const m = await tg(env, 'getChatMember', { chat_id: chatId, user_id: userId });
    value = m?.status === 'creator' || m?.status === 'administrator';
  } catch {}
  adminCache.set(key, { value, until: Date.now() + 180000 });
  return value;
}

async function accessLevel(env, chatId, userId) {
  if (!userId) return 'none';
  if (isGlobalAdmin(env, userId)) return 'manager';
  const row = await aclRow(env, chatId, userId);
  if (row?.status === 'approved') return 'operator';
  if (await telegramManager(env, chatId, userId)) return 'manager';
  return 'none';
}

async function isManager(env, chatId, userId) {
  return (await accessLevel(env, chatId, userId)) === 'manager';
}

async function upsertApproved(env, chatId, user, approvedBy) {
  const id = Number(user?.id ?? user);
  if (!Number.isFinite(id)) throw new Error('Invalid operator id');
  const display = typeof user === 'object'
    ? operatorName(user)
    : null;
  const username = typeof user === 'object' ? (user.username || null) : null;
  await env.DB.prepare(`INSERT INTO fn19_operator_acl(
    chat_id,user_id,display_name,username,status,requested_at,approved_by,approved_at,revoked_at,updated_at
  ) VALUES(?,?,?,?, 'approved',NULL,?,?,NULL,?)
  ON CONFLICT(chat_id,user_id) DO UPDATE SET
    display_name=COALESCE(excluded.display_name,fn19_operator_acl.display_name),
    username=COALESCE(excluded.username,fn19_operator_acl.username),
    status='approved',approved_by=excluded.approved_by,approved_at=excluded.approved_at,
    revoked_at=NULL,updated_at=excluded.updated_at`)
    .bind(chatId, id, display, username, approvedBy || null, now(), now()).run();
  try {
    await env.DB.prepare(`UPDATE fn15_agents SET status=CASE WHEN status='offline' THEN 'away' ELSE status END,updated_at=?
      WHERE chat_id=? AND operator_id=?`).bind(now(), chatId, id).run();
  } catch {}
  adminCache.delete(`${chatId}:${id}`);
}

async function revokeOperator(env, chatId, userId, revokedBy) {
  await env.DB.prepare(`INSERT INTO fn19_operator_acl(chat_id,user_id,status,revoked_at,updated_at)
    VALUES(?,?,'revoked',?,?)
    ON CONFLICT(chat_id,user_id) DO UPDATE SET status='revoked',revoked_at=excluded.revoked_at,
      approved_by=?,updated_at=excluded.updated_at`)
    .bind(chatId, userId, now(), now(), revokedBy || null).run();
  try {
    await env.DB.prepare(`UPDATE fn15_agents SET status='away',updated_at=? WHERE chat_id=? AND operator_id=?`)
      .bind(now(), chatId, userId).run();
  } catch {}
  const dep = await getDepartmentByChat(env, chatId);
  let released = 0;
  if (dep?.department) {
    const r = await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=NULL,assigned_name=NULL,
      stage=CASE WHEN stage='waiting_customer' THEN stage ELSE 'new' END,updated_at=?
      WHERE status='open' AND department=? AND assigned_to=?`)
      .bind(now(), dep.department, userId).run();
    released = Number(r.meta?.changes || 0);
  }
  return released;
}

async function requestAccess(env, msg) {
  const dep = await getDepartmentByChat(env, msg.chat.id);
  if (!dep?.department) {
    await sendMessage(env, msg.chat.id, '⚠️ Bu guruh hali FiberNet bo‘limiga ulanmagan. Admin avval /setup qilsin.');
    return true;
  }
  const row = await aclRow(env, msg.chat.id, msg.from.id);
  if (row?.status === 'approved') {
    await sendMessage(env, msg.chat.id, '✅ Sizda operator ruxsati allaqachon bor.');
    return true;
  }
  await env.DB.prepare(`INSERT INTO fn19_operator_acl(
    chat_id,user_id,display_name,username,status,requested_at,updated_at
  ) VALUES(?,?,?,?, 'pending',?,?)
  ON CONFLICT(chat_id,user_id) DO UPDATE SET
    display_name=excluded.display_name,username=excluded.username,status='pending',
    requested_at=excluded.requested_at,revoked_at=NULL,updated_at=excluded.updated_at`)
    .bind(msg.chat.id, msg.from.id, operatorName(msg.from), msg.from.username || null, now(), now()).run();

  await audit(env, msg.chat.id, msg.from.id, 'operator_access_requested', 'oprequest', msg.message_thread_id || null);
  await sendMessage(env, msg.chat.id, [
    '🔐 <b>Operator ruxsati so‘raldi</b>',
    `👤 ${escapeHtml(operatorName(msg.from))}`,
    msg.from.username ? `🔗 @${escapeHtml(msg.from.username)}` : null,
    `🆔 <code>${msg.from.id}</code>`,
    '',
    'Guruh admini tasdiqlashi kerak.'
  ].filter(Boolean).join('\n'), {
    reply_markup: inlineKeyboard([
      [{ text:'✅ Ruxsat berish', callback_data:`v19acl:approve:${msg.from.id}` },
       { text:'❌ Rad etish', callback_data:`v19acl:reject:${msg.from.id}` }]
    ])
  });
  return true;
}

async function aclCallback(env, q) {
  const data = String(q.data || '');
  if (!data.startsWith('v19acl:') || !isGroup(q.message?.chat)) return false;
  const [, action, rawId] = data.split(':');
  const targetId = Number(rawId);
  if (!await isManager(env, q.message.chat.id, q.from.id)) {
    await answerCallback(env, q.id, 'Faqat guruh admini');
    await audit(env, q.message.chat.id, q.from.id, 'blocked_acl_callback', action, q.message.message_thread_id || null);
    return true;
  }
  if (!Number.isFinite(targetId)) {
    await answerCallback(env, q.id, 'Noto‘g‘ri ID');
    return true;
  }
  if (action === 'approve') {
    const row = await aclRow(env, q.message.chat.id, targetId);
    await upsertApproved(env, q.message.chat.id, {
      id: targetId,
      first_name: row?.display_name || String(targetId),
      username: row?.username || undefined
    }, q.from.id);
    await answerCallback(env, q.id, 'Operator tasdiqlandi');
    await sendMessage(env, q.message.chat.id,
      `✅ <b>${escapeHtml(row?.display_name || String(targetId))}</b> operator sifatida tasdiqlandi.`);
    return true;
  }
  if (action === 'reject') {
    const released = await revokeOperator(env, q.message.chat.id, targetId, q.from.id);
    await answerCallback(env, q.id, 'Ruxsat berilmadi');
    await sendMessage(env, q.message.chat.id,
      `❌ Operator ruxsati rad etildi.${released ? `\n♻️ ${released} ta ticket navbatga qaytarildi.` : ''}`);
    return true;
  }
  return true;
}

function targetFromAdminCommand(msg, arg) {
  if (msg.reply_to_message?.from?.id && !msg.reply_to_message.from.is_bot) {
    return { id: msg.reply_to_message.from.id, user: msg.reply_to_message.from };
  }
  if (String(arg || '').toLowerCase() === 'me') return { id: msg.from.id, user: msg.from };
  if (/^\d+$/.test(String(arg || '').trim())) return { id: Number(arg), user: Number(arg) };
  return null;
}

async function managerCommands(env, msg, cmd) {
  const text = String(msg.text || '').trim();
  const arg = text.replace(/^\/\w+(?:@\w+)?\s*/i, '').trim();

  if (cmd === 'oprequest') return requestAccess(env, msg);
  if (cmd === 'whoami') {
    const level = await accessLevel(env, msg.chat.id, msg.from.id);
    await sendMessage(env, msg.chat.id,
      `🔐 Sizning group rolingiz: <b>${escapeHtml(level)}</b>\n🆔 <code>${msg.from.id}</code>`);
    return true;
  }

  if (!['opadd','opremove','operators','guard','guardlog'].includes(cmd)) return false;
  if (!await isManager(env, msg.chat.id, msg.from.id)) {
    await sendMessage(env, msg.chat.id, '⛔ Bu buyruq faqat guruh admini uchun.');
    await audit(env, msg.chat.id, msg.from.id, 'blocked_manager_command', cmd, msg.message_thread_id || null);
    return true;
  }

  if (cmd === 'opadd') {
    const target = targetFromAdminCommand(msg, arg);
    if (!target) {
      await sendMessage(env, msg.chat.id,
        'Format: operator xabariga <b>Reply</b> qilib <code>/opadd</code>, yoki <code>/opadd me</code>, yoki <code>/opadd TELEGRAM_ID</code>.');
      return true;
    }
    await upsertApproved(env, msg.chat.id, target.user, msg.from.id);
    await sendMessage(env, msg.chat.id, `✅ <code>${target.id}</code> operator sifatida ruxsat oldi.`);
    return true;
  }

  if (cmd === 'opremove') {
    const target = targetFromAdminCommand(msg, arg);
    if (!target) {
      await sendMessage(env, msg.chat.id,
        'Format: operator xabariga Reply → <code>/opremove</code> yoki <code>/opremove TELEGRAM_ID</code>.');
      return true;
    }
    const released = await revokeOperator(env, msg.chat.id, target.id, msg.from.id);
    await sendMessage(env, msg.chat.id,
      `🚫 <code>${target.id}</code> operator ruxsati olib tashlandi.${released ? `\n♻️ ${released} ta ticket navbatga qaytarildi.` : ''}`);
    return true;
  }

  if (cmd === 'operators') {
    const r = await env.DB.prepare(`SELECT * FROM fn19_operator_acl WHERE chat_id=?
      ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,display_name`)
      .bind(msg.chat.id).all();
    const rows = r.results || [];
    await sendMessage(env, msg.chat.id, [
      '👥 <b>Operator ACL</b>',
      '',
      ...(rows.length ? rows.map(x =>
        `${x.status === 'approved' ? '✅' : x.status === 'pending' ? '⏳' : '🚫'} ${escapeHtml(x.display_name || String(x.user_id))} · <code>${x.user_id}</code>`
      ) : ['—']),
      '',
      'Adminlar Telegram statusi orqali ham boshqaruv huquqiga ega.'
    ].join('\n'));
    return true;
  }

  if (cmd === 'guard') {
    const dep = await getDepartmentByChat(env, msg.chat.id);
    const acl = await env.DB.prepare(`SELECT
      SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending
      FROM fn19_operator_acl WHERE chat_id=?`).bind(msg.chat.id).first();
    const blocked = await env.DB.prepare(`SELECT COUNT(*) n FROM fn19_group_guard_events
      WHERE chat_id=? AND datetime(created_at)>=datetime('now','-24 hours')
      AND event LIKE 'blocked%'`).bind(msg.chat.id).first();
    let topics = { n:0 }, outbox = { n:0 };
    try { topics = await env.DB.prepare("SELECT COUNT(*) n FROM fn15_topics WHERE chat_id=? AND state='open'").bind(msg.chat.id).first(); } catch {}
    try { outbox = await env.DB.prepare("SELECT COUNT(*) n FROM fn17_outbox WHERE target_chat_id=?").bind(msg.chat.id).first(); } catch {}
    await sendMessage(env, msg.chat.id, [
      '🛡 <b>FiberNet Group Guard</b>',
      `🏢 Bo‘lim: <b>${escapeHtml(dep?.department || 'ulanmagan')}</b>`,
      `✅ Approved operators: <b>${acl?.approved || 0}</b>`,
      `⏳ Pending: <b>${acl?.pending || 0}</b>`,
      `🧵 Open ticket topics: <b>${topics?.n || 0}</b>`,
      `📨 Pending delivery: <b>${outbox?.n || 0}</b>`,
      `🚫 Blocked actions 24h: <b>${blocked?.n || 0}</b>`,
      '',
      'Oddiy group chat xabarlari mijozga yuborilmaydi. Faqat ticket topic yoki ticket card reply ishlaydi.'
    ].join('\n'));
    return true;
  }

  if (cmd === 'guardlog') {
    const r = await env.DB.prepare(`SELECT event,user_id,command,thread_id,created_at
      FROM fn19_group_guard_events WHERE chat_id=? ORDER BY id DESC LIMIT 15`)
      .bind(msg.chat.id).all();
    await sendMessage(env, msg.chat.id, [
      '🛡 <b>Guard log</b>',
      '',
      ...((r.results || []).map(x =>
        `• ${escapeHtml(x.event)} · <code>${x.user_id || '—'}</code>${x.command ? ` · /${escapeHtml(x.command)}` : ''}`
      )),
      ...((r.results || []).length ? [] : ['—'])
    ].join('\n'));
    return true;
  }
  return false;
}

async function mappedTopic(env, chatId, threadId) {
  if (!threadId) return null;
  try {
    return await env.DB.prepare(`SELECT * FROM fn15_topics WHERE chat_id=? AND thread_id=? AND state='open'`)
      .bind(chatId, threadId).first();
  } catch {
    return null;
  }
}

async function validateTicketCallback(env, q) {
  const no = extractTicketNo(q.data || '');
  if (!no) return true;
  let t;
  try { t = await getTicket(env, no); } catch { return false; }
  if (!t || t.status !== 'open') {
    await answerCallback(env, q.id, 'Ticket yopilgan yoki topilmadi');
    return false;
  }
  if (t.support_chat_id && String(t.support_chat_id) !== String(q.message.chat.id)) {
    await answerCallback(env, q.id, 'Bu ticket boshqa operator guruhiga tegishli');
    return false;
  }
  const topic = await mappedTopic(env, q.message.chat.id, q.message.message_thread_id);
  if (topic && topic.ticket_no !== no) {
    await answerCallback(env, q.id, 'Tugma boshqa ticketga tegishli');
    return false;
  }
  return true;
}

async function clearLegacyReplySession(env, chatId, userId) {
  try {
    await env.DB.prepare('DELETE FROM fn7_operator_sessions WHERE chat_id=? AND operator_id=?')
      .bind(chatId, userId).run();
  } catch {}
}

async function beginSafeReply(env, q, ticketNo) {
  const t = await getTicket(env, ticketNo);
  if (!t || t.status !== 'open') {
    await answerCallback(env, q.id, 'Ticket yopilgan yoki topilmadi');
    return true;
  }
  const topic = await mappedTopic(env, q.message.chat.id, q.message.message_thread_id);
  await clearLegacyReplySession(env, q.message.chat.id, q.from.id);
  if (topic?.ticket_no === ticketNo) {
    await answerCallback(env, q.id, 'Shu topicga yozing');
    await sendMessage(env, q.message.chat.id,
      `✍️ <b>${escapeHtml(operatorName(q.from))}</b>, javobni shu ticket topic ichiga oddiy xabar/media qilib yuboring.\n🔒 Boshqa gruppa xabarlari mijozga ketmaydi.`,
      { message_thread_id: q.message.message_thread_id });
    return true;
  }
  const expires = new Date(Date.now() + 10 * 60000).toISOString();
  await env.DB.prepare(`INSERT INTO fn19_reply_sessions(chat_id,operator_id,ticket_no,prompt_message_id,expires_at)
    VALUES(?,?,?,NULL,?)
    ON CONFLICT(chat_id,operator_id) DO UPDATE SET ticket_no=excluded.ticket_no,prompt_message_id=NULL,
      expires_at=excluded.expires_at,created_at=CURRENT_TIMESTAMP`)
    .bind(q.message.chat.id, q.from.id, ticketNo, expires).run();
  const prompt = await sendMessage(env, q.message.chat.id, [
    `✍️ <b>${escapeHtml(ticketNo)}</b> uchun xavfsiz javob rejimi`,
    '',
    '<b>Faqat shu xabarga Reply qilib</b> yuborgan text/media mijozga ketadi.',
    'Gruppaga yozilgan boshqa xabarlar mijozga yuborilmaydi.',
    '⏱ 10 daqiqada bekor bo‘ladi. /cancelreply'
  ].join('\n'), { reply_to_message_id:q.message.message_id });
  await env.DB.prepare(`UPDATE fn19_reply_sessions SET prompt_message_id=? WHERE chat_id=? AND operator_id=?`)
    .bind(prompt.message_id, q.message.chat.id, q.from.id).run();
  await answerCallback(env, q.id, 'Reply rejimi yoqildi');
  return true;
}

async function claimIfNeeded(env, t, from) {
  if (t.assigned_to && String(t.assigned_to) !== String(from.id) && !isGlobalAdmin(env, from.id)) {
    return false;
  }
  if (!t.assigned_to) {
    await assignTicket(env, t.ticket_no, { id:from.id, name:operatorName(from) });
  }
  return true;
}

async function relayFallbackReply(env, msg, t) {
  if (!await claimIfNeeded(env, t, msg.from)) {
    await sendMessage(env, msg.chat.id,
      `⛔ Ticket <b>${escapeHtml(t.assigned_name || String(t.assigned_to))}</b> operatoriga biriktirilgan.`);
    return true;
  }
  try {
    await tg(env, 'copyMessage', {
      chat_id:t.telegram_id,
      from_chat_id:msg.chat.id,
      message_id:msg.message_id
    });
    await addMessage(env, t.ticket_no, 'operator', msg.from.id,
      String(msg.text || msg.caption || '').trim() || '[media]', msg.message_id);
    await setStage(env, t.ticket_no, 'waiting_customer', { id:msg.from.id, name:operatorName(msg.from) });
    const u = await getUser(env, t.telegram_id);
    try {
      await sendMessage(env, t.telegram_id, L(u?.language || 'uz',
        `💬 Operator javob berdi. 🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\nJavob yozish uchun shu botga oddiy xabar/media yuboring.`,
        `💬 Оператор ответил. 🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\nЧтобы ответить, отправьте обычное сообщение или медиа в этот бот.`));
    } catch {}
    try {
      await tg(env, 'setMessageReaction', {
        chat_id:msg.chat.id,message_id:msg.message_id,reaction:[{type:'emoji',emoji:'👍'}]
      });
    } catch {}
  } catch (e) {
    await sendMessage(env, msg.chat.id, `⚠️ Mijozga yuborilmadi: <code>${escapeHtml(String(e).slice(0,180))}</code>`);
  }
  return true;
}

async function handleSafeReplySession(env, msg) {
  const s = await env.DB.prepare(`SELECT * FROM fn19_reply_sessions
    WHERE chat_id=? AND operator_id=? AND datetime(expires_at)>datetime('now')`)
    .bind(msg.chat.id, msg.from.id).first();
  if (!s) return false;
  if (commandName(msg.text) === 'cancelreply') {
    await env.DB.prepare('DELETE FROM fn19_reply_sessions WHERE chat_id=? AND operator_id=?')
      .bind(msg.chat.id, msg.from.id).run();
    await clearLegacyReplySession(env, msg.chat.id, msg.from.id);
    await sendMessage(env, msg.chat.id, '❎ Xavfsiz javob rejimi bekor qilindi.');
    return true;
  }
  if (msg.reply_to_message?.message_id !== s.prompt_message_id) {
    return false;
  }
  const t = await getTicket(env, s.ticket_no);
  await env.DB.prepare('DELETE FROM fn19_reply_sessions WHERE chat_id=? AND operator_id=?')
    .bind(msg.chat.id, msg.from.id).run();
  if (!t || t.status !== 'open') {
    await sendMessage(env, msg.chat.id, '⚠️ Ticket yopilgan yoki topilmadi.');
    return true;
  }
  return relayFallbackReply(env, msg, t);
}

async function handleDirectCardReply(env, msg) {
  const repliedId = msg.reply_to_message?.message_id;
  if (!repliedId) return false;
  let t = null;
  try { t = await getTicketBySupportMessage(env, msg.chat.id, repliedId); } catch {}
  if (!t || t.status !== 'open') return false;
  return relayFallbackReply(env, msg, t);
}

async function handleBotMembership(env, update) {
  const m = update?.my_chat_member;
  if (!m || !isGroup(m.chat)) return false;
  await ensureV19Schema(env);
  const status = m.new_chat_member?.status;
  if (status === 'left' || status === 'kicked') {
    const dep = await getDepartmentByChat(env, m.chat.id);
    if (dep?.department) {
      await unbindDepartment(env, dep.department);
      await audit(env, m.chat.id, m.from?.id || null, 'group_unbound_bot_removed');
    }
    return true;
  }
  if (['member','administrator','creator'].includes(status)) {
    const dep = await getDepartmentByChat(env, m.chat.id);
    if (!dep) {
      try {
        await sendMessage(env, m.chat.id,
          '🛡 <b>FiberNet Group Guard</b> yoqildi.\n\nBot guruhni nomiga qarab avtomatik bo‘limga bog‘lamaydi. Guruh admini <code>/setup</code> yuborib bo‘limni tanlashi kerak.');
      } catch {}
    }
    return true;
  }
  return true;
}

async function groupMessageGuard(env, msg) {
  if (!msg || !isGroup(msg.chat) || msg.from?.is_bot) return false;
  await ensureV19Schema(env);
  const cmd = commandName(msg.text);

  if (cmd && ['oprequest','whoami','opadd','opremove','operators','guard','guardlog'].includes(cmd)) {
    return managerCommands(env, msg, cmd);
  }

  const dep = await getDepartmentByChat(env, msg.chat.id);

  if (!dep?.department) {
    if (cmd === 'setup') {
      if (!await isManager(env, msg.chat.id, msg.from.id)) {
        await sendMessage(env, msg.chat.id, '⛔ /setup faqat guruh admini uchun.');
        await audit(env, msg.chat.id, msg.from.id, 'blocked_setup', cmd, msg.message_thread_id || null);
        return true;
      }
      return false;
    }
    if (cmd) {
      await audit(env, msg.chat.id, msg.from.id, 'blocked_unbound_group_command', cmd, msg.message_thread_id || null);
    }
    return true;
  }

  const level = await accessLevel(env, msg.chat.id, msg.from.id);
  if (level === 'none') {
    await audit(env, msg.chat.id, msg.from.id,
      cmd ? 'blocked_unauthorized_command' : 'blocked_unauthorized_message',
      cmd, msg.message_thread_id || null);
    if (cmd) {
      await sendMessage(env, msg.chat.id,
        '⛔ Siz operator sifatida tasdiqlanmagansiz. Ruxsat so‘rash uchun <code>/oprequest</code> yuboring.');
    }
    return true;
  }

  if (cmd && MANAGER_COMMANDS.has(cmd) && level !== 'manager') {
    await sendMessage(env, msg.chat.id, '⛔ Bu buyruq faqat guruh admini uchun.');
    await audit(env, msg.chat.id, msg.from.id, 'blocked_manager_command', cmd, msg.message_thread_id || null);
    return true;
  }

  if (await handleSafeReplySession(env, msg)) return true;

  if (cmd === 'cancelreply') {
    await env.DB.prepare('DELETE FROM fn19_reply_sessions WHERE chat_id=? AND operator_id=?')
      .bind(msg.chat.id, msg.from.id).run();
    await clearLegacyReplySession(env, msg.chat.id, msg.from.id);
    await sendMessage(env, msg.chat.id, '❎ Javob rejimi bekor qilindi.');
    return true;
  }

  const topic = await mappedTopic(env, msg.chat.id, msg.message_thread_id);
  if (topic) return false;

  if (await handleDirectCardReply(env, msg)) return true;

  if (cmd) {
    if (isKnownOperatorCommand(cmd)) return false;
    await audit(env, msg.chat.id, msg.from.id, 'blocked_unknown_command', cmd, msg.message_thread_id || null);
    await sendMessage(env, msg.chat.id,
      `⚠️ Noma’lum operator komandasi: <code>/${escapeHtml(cmd)}</code>\nYordam: <code>/operatorhelp</code> yoki <code>/panel</code>.`);
    return true;
  }

  // Critical invariant: ordinary messages outside a mapped ticket topic/card
  // are group discussion only and MUST NEVER reach a customer.
  return true;
}

async function groupEditedGuard(env, msg) {
  if (!msg || !isGroup(msg.chat) || msg.from?.is_bot) return false;
  const dep = await getDepartmentByChat(env, msg.chat.id);
  if (!dep?.department) return true;
  const level = await accessLevel(env, msg.chat.id, msg.from.id);
  if (level === 'none') {
    await audit(env, msg.chat.id, msg.from.id, 'blocked_unauthorized_edit', null, msg.message_thread_id || null);
    return true;
  }
  const topic = await mappedTopic(env, msg.chat.id, msg.message_thread_id);
  return topic ? false : true;
}

async function groupCallbackGuard(env, q) {
  if (!q?.message?.chat || !isGroup(q.message.chat)) return false;
  await ensureV19Schema(env);

  if (String(q.data || '').startsWith('v19acl:')) return aclCallback(env, q);

  const dep = await getDepartmentByChat(env, q.message.chat.id);
  const data = String(q.data || '');

  if (data.startsWith('bindhere:')) {
    if (!await isManager(env, q.message.chat.id, q.from.id)) {
      await answerCallback(env, q.id, 'Faqat guruh admini');
      await audit(env, q.message.chat.id, q.from.id, 'blocked_bind_callback', 'bindhere', q.message.message_thread_id || null);
      return true;
    }
    return false;
  }

  if (!dep?.department) {
    await answerCallback(env, q.id, 'Bu guruh FiberNet bo‘limiga ulanmagan');
    await audit(env, q.message.chat.id, q.from.id, 'blocked_unbound_callback', null, q.message.message_thread_id || null);
    return true;
  }

  const level = await accessLevel(env, q.message.chat.id, q.from.id);
  if (level === 'none') {
    await answerCallback(env, q.id, 'Operator ruxsati yo‘q');
    await audit(env, q.message.chat.id, q.from.id, 'blocked_unauthorized_callback', null, q.message.message_thread_id || null);
    return true;
  }

  if (!await validateTicketCallback(env, q)) {
    await audit(env, q.message.chat.id, q.from.id, 'blocked_ticket_context_callback', null, q.message.message_thread_id || null);
    return true;
  }

  const m = data.match(/^op:reply:(FN-\d{6}-[A-Z0-9]{6})$/i);
  if (m) return beginSafeReply(env, q, m[1].toUpperCase());

  return false;
}

export async function handleV19GroupGuard(env, update) {
  await ensureV19Schema(env);

  if (update?.my_chat_member && isGroup(update.my_chat_member.chat)) {
    return handleBotMembership(env, update);
  }
  if (update?.callback_query?.message?.chat && isGroup(update.callback_query.message.chat)) {
    return groupCallbackGuard(env, update.callback_query);
  }
  if (update?.edited_message?.chat && isGroup(update.edited_message.chat)) {
    return groupEditedGuard(env, update.edited_message);
  }
  if (update?.message?.chat && isGroup(update.message.chat)) {
    return groupMessageGuard(env, update.message);
  }
  return false;
}

export async function runV19Maintenance(env) {
  await ensureV19Schema(env);
  await env.DB.prepare("DELETE FROM fn19_reply_sessions WHERE datetime(expires_at)<=datetime('now')").run();
  await env.DB.prepare("DELETE FROM fn19_group_guard_events WHERE created_at < datetime('now','-14 day')").run();
  try {
    // Old reply sessions were broad "next group message" sessions. They are
    // intentionally disabled in v19; safe reply sessions above replace them.
    await env.DB.prepare("DELETE FROM fn7_operator_sessions WHERE datetime(updated_at) < datetime('now','-10 minutes')").run();
  } catch {}
  const t = Date.now();
  for (const [k,v] of adminCache.entries()) if (!v || v.until <= t) adminCache.delete(k);
}

export async function v19Health(env) {
  await ensureV19Schema(env);
  const [approved,pending,blocked,sessions] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) n FROM fn19_operator_acl WHERE status='approved'").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM fn19_operator_acl WHERE status='pending'").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM fn19_group_guard_events WHERE event LIKE 'blocked%' AND datetime(created_at)>=datetime('now','-24 hours')").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM fn19_reply_sessions WHERE datetime(expires_at)>datetime('now')").first()
  ]);
  return {
    mode:'strict-group-firewall-operator-acl-safe-reply-context-validation',
    approved_operators:approved?.n || 0,
    pending_operator_requests:pending?.n || 0,
    blocked_actions_24h:blocked?.n || 0,
    safe_reply_sessions:sessions?.n || 0
  };
}

export const __test = {
  commandName,
  extractTicketNo,
  isKnownOperatorCommand
};
