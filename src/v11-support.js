import {
  addMessage, closeTicket, deliveryDone, getTicket, getTicketBySupportMessage,
  getUser, setStage, setSupportMessage
} from './v5-db.js';
import { getDepartmentChat } from './v7-routing.js';
import { categoryMeta, departmentMeta, L, operatorName } from './v8-ui.js';
import {
  answerCallback, editMessage, escapeHtml, inlineKeyboard, sendMessage, tg
} from './telegram.js';

const now = () => new Date().toISOString();
let ready = false;
const ENV_CHAT_KEYS = {
  tech: 'TECH_CHAT_ID', accounting: 'ACCOUNTING_CHAT_ID',
  subscriber: 'SUBSCRIBER_CHAT_ID', connection: 'CONNECTION_CHAT_ID', general: 'SUPPORT_CHAT_ID'
};

export async function ensureV11Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn11_bridge (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      ticket_no TEXT NOT NULL,
      direction TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(chat_id,message_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn11_bridge_ticket ON fn11_bridge(ticket_no)`,
    `CREATE TABLE IF NOT EXISTS fn11_user_live (
      telegram_id INTEGER PRIMARY KEY,
      ticket_no TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn11_operator_compose (
      chat_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      ticket_no TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(chat_id,operator_id)
    )`,
    `CREATE TABLE IF NOT EXISTS fn11_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id INTEGER,
      event TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn11_events_ticket ON fn11_events(ticket_no,id DESC)`,
    `CREATE TABLE IF NOT EXISTS fn11_processed (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

function isGroup(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
function isPrivate(chat) { return chat?.type === 'private'; }
function adminIds(env) { return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String); }
function isAdmin(env, id) { return adminIds(env).includes(String(id)); }
function hasMedia(msg) { return Boolean(msg?.photo || msg?.document || msg?.video || msg?.voice || msg?.audio || msg?.animation || msg?.video_note); }
function bodyOf(msg) { return String(msg?.text || msg?.caption || '').trim(); }
function personName(u) { return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : String(u?.telegram_id || '—')); }
function stageLabel(stage) {
  return ({
    new: '🆕 Yangi / Новая',
    in_progress: '🟠 Jarayonda / В работе',
    waiting_customer: '⏳ Mijoz javobi / Ответ клиента',
    resolved: '✅ Hal qilindi / Решено',
    closed: '⚫️ Yopildi / Закрыто'
  })[stage] || String(stage || '—');
}

async function event(env, ticketNo, actorType, actorId, name, data = null) {
  await ensureV11Schema(env);
  return env.DB.prepare('INSERT INTO fn11_events(ticket_no,actor_type,actor_id,event,data) VALUES(?,?,?,?,?)')
    .bind(ticketNo, actorType, actorId || null, name, data ? JSON.stringify(data) : null).run();
}

async function claimUpdate(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  await ensureV11Schema(env);
  try {
    await env.DB.prepare('INSERT INTO fn11_processed(update_id) VALUES(?)').bind(updateId).run();
    return true;
  } catch (e) {
    const s = String(e).toLowerCase();
    if (s.includes('unique') || s.includes('constraint')) return false;
    throw e;
  }
}

async function bridge(env, chatId, messageId, ticketNo, direction) {
  if (!chatId || !messageId || !ticketNo) return;
  await ensureV11Schema(env);
  await env.DB.prepare(`INSERT INTO fn11_bridge(chat_id,message_id,ticket_no,direction)
    VALUES(?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET ticket_no=excluded.ticket_no,direction=excluded.direction`)
    .bind(chatId, messageId, ticketNo, direction).run();
}

async function ticketByBridge(env, chatId, messageId) {
  await ensureV11Schema(env);
  const row = await env.DB.prepare('SELECT ticket_no FROM fn11_bridge WHERE chat_id=? AND message_id=?')
    .bind(chatId, messageId).first();
  if (row?.ticket_no) return getTicket(env, row.ticket_no);
  const legacy = await getTicketBySupportMessage(env, chatId, messageId);
  if (legacy) await bridge(env, chatId, messageId, legacy.ticket_no, 'ticket_card');
  return legacy || null;
}

async function setUserLive(env, telegramId, ticketNo) {
  await ensureV11Schema(env);
  return env.DB.prepare(`INSERT INTO fn11_user_live(telegram_id,ticket_no,updated_at) VALUES(?,?,?)
    ON CONFLICT(telegram_id) DO UPDATE SET ticket_no=excluded.ticket_no,updated_at=excluded.updated_at`)
    .bind(telegramId, ticketNo, now()).run();
}
async function getUserLive(env, telegramId) {
  await ensureV11Schema(env);
  return env.DB.prepare(`SELECT * FROM fn11_user_live WHERE telegram_id=?
    AND datetime(updated_at) >= datetime('now','-24 hours')`).bind(telegramId).first();
}
async function clearUserLive(env, telegramId) {
  await ensureV11Schema(env);
  return env.DB.prepare('DELETE FROM fn11_user_live WHERE telegram_id=?').bind(telegramId).run();
}
async function setCompose(env, chatId, operatorId, ticketNo) {
  await ensureV11Schema(env);
  return env.DB.prepare(`INSERT INTO fn11_operator_compose(chat_id,operator_id,ticket_no,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(chat_id,operator_id) DO UPDATE SET ticket_no=excluded.ticket_no,updated_at=excluded.updated_at`)
    .bind(chatId, operatorId, ticketNo, now()).run();
}
async function getCompose(env, chatId, operatorId) {
  await ensureV11Schema(env);
  return env.DB.prepare(`SELECT * FROM fn11_operator_compose WHERE chat_id=? AND operator_id=?
    AND datetime(updated_at) >= datetime('now','-10 minutes')`).bind(chatId, operatorId).first();
}
async function clearCompose(env, chatId, operatorId) {
  await ensureV11Schema(env);
  return env.DB.prepare('DELETE FROM fn11_operator_compose WHERE chat_id=? AND operator_id=?').bind(chatId, operatorId).run();
}

async function atomicClaim(env, ticketNo, op) {
  const r = await env.DB.prepare(`UPDATE fn5_tickets
    SET assigned_to=?,assigned_name=?,stage=CASE WHEN stage='new' THEN 'in_progress' ELSE stage END,updated_at=?
    WHERE ticket_no=? AND status='open' AND (assigned_to IS NULL OR assigned_to=?)`)
    .bind(op.id, op.name || null, now(), ticketNo, op.id).run();
  return (r.meta?.changes || 0) > 0;
}

async function resolveDepartmentChat(env, department) {
  const bound = await getDepartmentChat(env, department);
  if (bound?.chat_id) return bound.chat_id;
  const key = ENV_CHAT_KEYS[department] || 'SUPPORT_CHAT_ID';
  return env[key] || env.SUPPORT_CHAT_ID || null;
}

function operatorKeyboard(no) {
  return inlineKeyboard([
    [{ text: '👨‍💻 Qabul qilish', callback_data: `op:claim:${no}` }, { text: '💬 Javob berish', callback_data: `op:reply:${no}` }],
    [{ text: '⏳ Mijozni kutish', callback_data: `op:wait:${no}` }, { text: '✅ Hal qilindi', callback_data: `op:resolve:${no}` }],
    [{ text: '↗️ Boshqa bo‘lim', callback_data: `op:transfer:${no}` }, { text: '❌ Yopish', callback_data: `op:close:${no}` }]
  ]);
}

function transferKeyboard(no, current) {
  const defs = [
    ['tech', '🛠 Texnik'], ['subscriber', '👥 Abonent'],
    ['accounting', '💳 Buxgalteriya'], ['connection', '🔌 Ulanish']
  ].filter(([d]) => d !== current);
  return inlineKeyboard([
    ...defs.map(([d, title]) => [{ text: title, callback_data: `opmove:${d}:${no}` }]),
    [{ text: '❌ Bekor qilish', callback_data: `opcancel:${no}` }]
  ]);
}

async function ticketCardText(env, t) {
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  const d = departmentMeta(t.department, lang);
  const c = categoryMeta(t.category, lang);
  const p = t.priority === 'critical' ? '🚨' : t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
  return [
    `${p} <b>${escapeHtml(String(t.priority || 'normal').toUpperCase())} · ${escapeHtml(t.ticket_no)}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    `${d.icon} <b>${escapeHtml(d.title)}</b>`,
    `${c.icon} ${escapeHtml(c.title)}`,
    `📌 <b>${stageLabel(t.stage)}</b>`,
    t.assigned_name ? `👨‍💻 Operator: <b>${escapeHtml(t.assigned_name)}</b>` : '👨‍💻 Operator: <b>—</b>',
    '',
    `👤 <b>${escapeHtml(personName(u))}</b>`,
    u?.username ? `🔗 @${escapeHtml(u.username)}` : null,
    `🆔 Telegram: <code>${t.telegram_id}</code>`,
    `🔐 Login/shartnoma: <code>${escapeHtml(t.account_login || '—')}</code>`,
    `📍 Manzil: ${escapeHtml(t.address || '—')}`,
    `📞 Telefon: <b>${escapeHtml(t.phone || '—')}</b>`,
    '',
    `📝 <b>${L(lang, 'Murojaat', 'Обращение')}:</b>`,
    escapeHtml(t.description || '—'),
    '',
    '💬 <i>Javob berish uchun shu ticketga Reply qiling yoki “Javob berish”ni bosing.</i>'
  ].filter(Boolean).join('\n');
}

async function refreshCard(env, ticketNo) {
  const t = await getTicket(env, ticketNo);
  if (!t?.support_chat_id || !t?.support_message_id) return;
  try {
    await editMessage(env, t.support_chat_id, t.support_message_id, await ticketCardText(env, t), {
      reply_markup: t.status === 'open' ? operatorKeyboard(ticketNo) : { inline_keyboard: [] }
    });
    await bridge(env, t.support_chat_id, t.support_message_id, ticketNo, 'ticket_card');
  } catch (e) {
    console.warn('v11 refresh card ignored', String(e));
  }
}

async function sendTicketCard(env, ticketNo, department = null) {
  let t = await getTicket(env, ticketNo);
  if (!t) return false;
  const chatId = await resolveDepartmentChat(env, department || t.department);
  if (!chatId) return false;
  const sent = await sendMessage(env, chatId, await ticketCardText(env, t), { reply_markup: operatorKeyboard(ticketNo) });
  await setSupportMessage(env, ticketNo, chatId, sent.message_id);
  await bridge(env, chatId, sent.message_id, ticketNo, 'ticket_card');
  try { await deliveryDone(env, ticketNo); } catch {}
  return true;
}

async function reactOk(env, chatId, messageId) {
  try {
    await tg(env, 'setMessageReaction', {
      chat_id: chatId, message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '👍' }]
    });
  } catch {}
}

async function operatorToCustomer(env, msg, t) {
  if (!t || t.status !== 'open') return true;
  const op = { id: msg.from.id, name: operatorName(msg.from) };
  if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) {
    await sendMessage(env, msg.chat.id,
      `⚠️ <code>${escapeHtml(t.ticket_no)}</code> boshqa operatorga biriktirilgan: <b>${escapeHtml(t.assigned_name || String(t.assigned_to))}</b>`,
      { reply_to_message_id: msg.message_id });
    return true;
  }
  if (!t.assigned_to) {
    const ok = await atomicClaim(env, t.ticket_no, op);
    if (!ok) {
      const current = await getTicket(env, t.ticket_no);
      await sendMessage(env, msg.chat.id, `⚠️ Ticketni ${escapeHtml(current?.assigned_name || 'boshqa operator')} qabul qilib ulgurgan.`);
      return true;
    }
    t = await getTicket(env, t.ticket_no);
  }

  const body = bodyOf(msg);
  const media = hasMedia(msg);
  if (!body && !media) return true;
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  try {
    if (media) {
      await sendMessage(env, t.telegram_id,
        `👨‍💻 <b>FiberNet ${L(lang, 'operatori', 'оператор')}</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>`);
      await tg(env, 'copyMessage', { chat_id: t.telegram_id, from_chat_id: msg.chat.id, message_id: msg.message_id });
    } else {
      await sendMessage(env, t.telegram_id,
        `👨‍💻 <b>FiberNet ${L(lang, 'operatori', 'оператор')}</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\n${escapeHtml(body)}`);
    }
    await addMessage(env, t.ticket_no, 'operator', op.id, body || '[attachment]', msg.message_id);
    await setStage(env, t.ticket_no, 'waiting_customer', op);
    await setUserLive(env, t.telegram_id, t.ticket_no);
    await clearCompose(env, msg.chat.id, op.id);
    await event(env, t.ticket_no, 'operator', op.id, 'operator_reply', { media });
    await reactOk(env, msg.chat.id, msg.message_id);
    await refreshCard(env, t.ticket_no);
  } catch (e) {
    await sendMessage(env, msg.chat.id,
      `⚠️ Mijozga yuborilmadi: <code>${escapeHtml(String(e).slice(0,240))}</code>`,
      { reply_to_message_id: msg.message_id });
  }
  return true;
}

async function customerToOperator(env, msg, t) {
  if (!t || String(t.telegram_id) !== String(msg.from.id)) return false;
  if (t.status !== 'open') {
    await clearUserLive(env, msg.from.id);
    await sendMessage(env, msg.chat.id, '⚠️ Bu murojaat yopilgan. Yangi murojaat uchun /start dan Bo‘limlar orqali kiring.');
    return true;
  }
  let chatId = t.support_chat_id;
  if (!chatId) {
    if (!await sendTicketCard(env, t.ticket_no)) {
      await sendMessage(env, msg.chat.id, '⚠️ Operator guruhi hozircha ulanmagan. Murojaatingiz saqlangan.');
      return true;
    }
    t = await getTicket(env, t.ticket_no);
    chatId = t.support_chat_id;
  }
  const u = await getUser(env, t.telegram_id);
  const body = bodyOf(msg);
  const media = hasMedia(msg);
  const reply = t.support_message_id ? { reply_parameters: { message_id: t.support_message_id, allow_sending_without_reply: true } } : {};
  try {
    if (media) {
      const head = await sendMessage(env, chatId,
        `💬 <b>${escapeHtml(t.ticket_no)} · mijoz</b>\n👤 ${escapeHtml(personName(u))}`,
        reply);
      await bridge(env, chatId, head.message_id, t.ticket_no, 'customer');
      const copied = await tg(env, 'copyMessage', {
        chat_id: chatId, from_chat_id: msg.chat.id, message_id: msg.message_id,
        ...(head?.message_id ? { reply_parameters: { message_id: head.message_id, allow_sending_without_reply: true } } : {})
      });
      if (copied?.message_id) await bridge(env, chatId, copied.message_id, t.ticket_no, 'customer_media');
    } else {
      const sent = await sendMessage(env, chatId,
        `💬 <b>${escapeHtml(t.ticket_no)} · mijoz</b>\n👤 ${escapeHtml(personName(u))}\n\n${escapeHtml(body)}`,
        reply);
      await bridge(env, chatId, sent.message_id, t.ticket_no, 'customer');
    }
    await addMessage(env, t.ticket_no, 'user', msg.from.id, body || '[attachment]', msg.message_id);
    await setStage(env, t.ticket_no, 'in_progress');
    await setUserLive(env, msg.from.id, t.ticket_no);
    await event(env, t.ticket_no, 'user', msg.from.id, t.stage === 'resolved' ? 'reopened_by_customer' : 'customer_reply', { media });
    await reactOk(env, msg.chat.id, msg.message_id);
    await refreshCard(env, t.ticket_no);
    return true;
  } catch (e) {
    await sendMessage(env, msg.chat.id, `⚠️ Operatorga yuborishda xato. Keyinroq yana urinib ko‘ring.`);
    console.error('v11 customer relay', String(e));
    return true;
  }
}

async function transferTicket(env, q, target, t) {
  const op = { id: q.from.id, name: operatorName(q.from) };
  if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) {
    await answerCallback(env, q.id, 'Faqat ticketni qabul qilgan operator yoki admin');
    return true;
  }
  const oldChat = t.support_chat_id, oldMsg = t.support_message_id, oldDept = t.department;
  await env.DB.prepare(`UPDATE fn5_tickets SET department=?,assigned_to=NULL,assigned_name=NULL,stage='new',support_chat_id=NULL,support_message_id=NULL,updated_at=? WHERE ticket_no=? AND status='open'`)
    .bind(target, now(), t.ticket_no).run();
  await event(env, t.ticket_no, 'operator', op.id, 'transferred', { from: oldDept, to: target });
  const ok = await sendTicketCard(env, t.ticket_no, target);
  if (!ok) {
    await env.DB.prepare(`UPDATE fn5_tickets SET department=?,support_chat_id=?,support_message_id=?,updated_at=? WHERE ticket_no=?`)
      .bind(oldDept, oldChat || null, oldMsg || null, now(), t.ticket_no).run();
    await answerCallback(env, q.id, 'Yangi bo‘lim guruhi ulanmagan');
    return true;
  }
  await answerCallback(env, q.id, 'Boshqa bo‘limga o‘tkazildi');
  try { await tg(env, 'editMessageReplyMarkup', { chat_id: oldChat, message_id: oldMsg, reply_markup: { inline_keyboard: [] } }); } catch {}
  try {
    await sendMessage(env, oldChat,
      `↗️ <code>${escapeHtml(t.ticket_no)}</code> → <b>${escapeHtml(departmentMeta(target, 'uz').title)}</b> bo‘limiga o‘tkazildi.`,
      oldMsg ? { reply_parameters: { message_id: oldMsg, allow_sending_without_reply: true } } : {});
  } catch {}
  return true;
}

async function handleOperatorCallback(env, q) {
  const data = String(q.data || '');
  if (!isGroup(q.message?.chat)) return false;
  if (data.startsWith('opcancel:')) { await answerCallback(env, q.id, 'Bekor qilindi'); return true; }
  if (data.startsWith('opmove:')) {
    const [, target, no] = data.split(':');
    const t = await getTicket(env, no);
    if (!t || t.status !== 'open') { await answerCallback(env, q.id, 'Ticket yopilgan yoki topilmadi'); return true; }
    if (t.support_chat_id && String(t.support_chat_id) !== String(q.message.chat.id)) { await answerCallback(env, q.id, 'Ticket boshqa guruhda'); return true; }
    return transferTicket(env, q, target, t);
  }
  if (!data.startsWith('op:')) return false;
  const [, action, no] = data.split(':');
  let t = await getTicket(env, no);
  if (!t || t.status !== 'open') { await answerCallback(env, q.id, 'Ticket yopilgan yoki topilmadi'); return true; }
  if (t.support_chat_id && String(t.support_chat_id) !== String(q.message.chat.id)) { await answerCallback(env, q.id, 'Ticket boshqa guruhga ko‘chirilgan'); return true; }
  await bridge(env, q.message.chat.id, q.message.message_id, no, 'ticket_card');
  const op = { id: q.from.id, name: operatorName(q.from) };

  if (action === 'claim') {
    const ok = await atomicClaim(env, no, op);
    if (!ok) {
      t = await getTicket(env, no);
      await answerCallback(env, q.id, `Band: ${t?.assigned_name || 'boshqa operator'}`);
      return true;
    }
    await event(env, no, 'operator', op.id, 'claimed');
    await answerCallback(env, q.id, 'Murojaat sizga biriktirildi');
    await refreshCard(env, no);
    const u = await getUser(env, t.telegram_id);
    try { await sendMessage(env, t.telegram_id, L(u?.language || 'uz', `👨‍💻 Operator murojaatingizni qabul qildi.\n🎫 <code>${no}</code>`, `👨‍💻 Оператор принял ваше обращение.\n🎫 <code>${no}</code>`)); } catch {}
    return true;
  }

  if (action === 'reply') {
    if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) {
      await answerCallback(env, q.id, `Band: ${t.assigned_name || 'boshqa operator'}`);
      return true;
    }
    if (!t.assigned_to) await atomicClaim(env, no, op);
    await setCompose(env, q.message.chat.id, op.id, no);
    await answerCallback(env, q.id, 'Keyingi xabaringiz mijozga boradi. Yoki ticketga Reply qiling.');
    await refreshCard(env, no);
    return true;
  }

  if (action === 'wait') {
    if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) { await answerCallback(env, q.id, 'Boshqa operatorga biriktirilgan'); return true; }
    if (!t.assigned_to) await atomicClaim(env, no, op);
    await setStage(env, no, 'waiting_customer', op);
    await setUserLive(env, t.telegram_id, no);
    await event(env, no, 'operator', op.id, 'waiting_customer');
    await answerCallback(env, q.id, 'Mijoz javobi kutilmoqda');
    await refreshCard(env, no);
    const u = await getUser(env, t.telegram_id);
    try { await sendMessage(env, t.telegram_id, L(u?.language || 'uz', `⏳ Operator <code>${no}</code> bo‘yicha javobingizni kutmoqda. Oddiy xabar yozsangiz shu murojaatga yuboriladi.`, `⏳ Оператор ждёт ваш ответ по <code>${no}</code>. Просто напишите сообщение — оно попадёт в это обращение.`)); } catch {}
    return true;
  }

  if (action === 'resolve') {
    if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) { await answerCallback(env, q.id, 'Boshqa operatorga biriktirilgan'); return true; }
    if (!t.assigned_to) await atomicClaim(env, no, op);
    await setStage(env, no, 'resolved', op);
    await setUserLive(env, t.telegram_id, no);
    await event(env, no, 'operator', op.id, 'resolved');
    await answerCallback(env, q.id, 'Hal qilindi');
    await refreshCard(env, no);
    const u = await getUser(env, t.telegram_id);
    try {
      await sendMessage(env, t.telegram_id,
        L(u?.language || 'uz', `✅ <b>Murojaat hal qilindi</b>\n🎫 <code>${no}</code>\n\nMuammo davom etsa oddiy xabar yozing — ticket qayta ochiladi.`, `✅ <b>Обращение решено</b>\n🎫 <code>${no}</code>\n\nЕсли проблема осталась, просто напишите сообщение — обращение возобновится.`));
    } catch {}
    return true;
  }

  if (action === 'transfer') {
    if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) { await answerCallback(env, q.id, 'Boshqa operatorga biriktirilgan'); return true; }
    await answerCallback(env, q.id, 'Bo‘limni tanlang');
    await sendMessage(env, q.message.chat.id,
      `↗️ <b>${escapeHtml(no)}</b> qaysi bo‘limga o‘tkazilsin?`,
      { reply_markup: transferKeyboard(no, t.department), reply_to_message_id: q.message.message_id });
    return true;
  }

  if (action === 'close') {
    if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) { await answerCallback(env, q.id, 'Faqat qabul qilgan operator yoki admin'); return true; }
    await closeTicket(env, no);
    await clearCompose(env, q.message.chat.id, op.id);
    await clearUserLive(env, t.telegram_id);
    await event(env, no, 'operator', op.id, 'closed');
    await answerCallback(env, q.id, 'Murojaat yopildi');
    await refreshCard(env, no);
    const u = await getUser(env, t.telegram_id);
    try { await sendMessage(env, t.telegram_id, L(u?.language || 'uz', `✅ Murojaat yopildi: <code>${no}</code>`, `✅ Обращение закрыто: <code>${no}</code>`)); } catch {}
    return true;
  }
  return false;
}

async function handleGroupMessage(env, msg) {
  if (!isGroup(msg.chat) || msg.from?.is_bot) return false;
  const text = String(msg.text || '').trim();
  if (/^\/(setup|bind|unbind|routes|where|queue|tickets|stats|cancelreply)(?:@\w+)?\b/i.test(text)) return false;

  let t = null;
  if (msg.reply_to_message?.message_id) t = await ticketByBridge(env, msg.chat.id, msg.reply_to_message.message_id);

  const move = text.match(/^\/move(?:@\w+)?\s+(tech|subscriber|accounting|connection)$/i);
  if (move && t) {
    const fakeQ = { id: `cmd-${msg.message_id}`, from: msg.from, message: msg };
    // Commands do not have a callback id, so transfer directly without answerCallback.
    const op = { id: msg.from.id, name: operatorName(msg.from) };
    if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) {
      await sendMessage(env, msg.chat.id, '⚠️ Ticket boshqa operatorga biriktirilgan.', { reply_to_message_id: msg.message_id });
      return true;
    }
    const oldChat = t.support_chat_id, oldMsg = t.support_message_id, oldDept = t.department;
    await env.DB.prepare(`UPDATE fn5_tickets SET department=?,assigned_to=NULL,assigned_name=NULL,stage='new',support_chat_id=NULL,support_message_id=NULL,updated_at=? WHERE ticket_no=? AND status='open'`)
      .bind(move[1].toLowerCase(), now(), t.ticket_no).run();
    const ok = await sendTicketCard(env, t.ticket_no, move[1].toLowerCase());
    if (!ok) {
      await env.DB.prepare(`UPDATE fn5_tickets SET department=?,support_chat_id=?,support_message_id=?,updated_at=? WHERE ticket_no=?`)
        .bind(oldDept, oldChat || null, oldMsg || null, now(), t.ticket_no).run();
      await sendMessage(env, msg.chat.id, '⚠️ Yangi bo‘lim guruhi ulanmagan.');
    } else {
      await event(env, t.ticket_no, 'operator', op.id, 'transferred', { from: oldDept, to: move[1].toLowerCase() });
      await sendMessage(env, msg.chat.id, `↗️ ${escapeHtml(t.ticket_no)} boshqa bo‘limga o‘tkazildi.`);
    }
    return true;
  }

  if (!t) {
    const s = await getCompose(env, msg.chat.id, msg.from.id);
    if (s?.ticket_no) t = await getTicket(env, s.ticket_no);
  }
  if (!t) return false;
  return operatorToCustomer(env, msg, t);
}

async function handlePrivateCallback(env, q) {
  const data = String(q.data || '');
  if (!data.startsWith('ticket:reply:') || !isPrivate(q.message?.chat)) return false;
  const no = data.slice('ticket:reply:'.length);
  const t = await getTicket(env, no);
  if (!t || String(t.telegram_id) !== String(q.from.id) || t.status !== 'open') {
    await answerCallback(env, q.id, 'Murojaat yopilgan yoki topilmadi');
    return true;
  }
  await setUserLive(env, q.from.id, no);
  await answerCallback(env, q.id, 'Suhbat rejimi yoqildi');
  const u = await getUser(env, q.from.id);
  await sendMessage(env, q.message.chat.id,
    L(u?.language || 'uz',
      `💬 <b>Operator bilan suhbat</b>\n🎫 <code>${escapeHtml(no)}</code>\n\nEndi oddiy matn, rasm, fayl yoki voice yuboring — shu ticket operatoriga boradi. Suhbat rejimidan chiqish: /stop`,
      `💬 <b>Диалог с оператором</b>\n🎫 <code>${escapeHtml(no)}</code>\n\nТеперь отправляйте текст, фото, файл или голосовое — всё попадёт оператору этого обращения. Выйти: /stop`));
  return true;
}

async function handlePrivateMessage(env, msg) {
  if (!isPrivate(msg.chat) || msg.from?.is_bot) return false;
  const text = String(msg.text || '').trim();
  if (/^\/start(?:@\w+)?(?:\s+.*)?$/i.test(text) || /^\/cancel(?:@\w+)?$/i.test(text)) {
    await clearUserLive(env, msg.from.id);
    return false;
  }
  if (/^\/stop(?:@\w+)?$/i.test(text)) {
    await clearUserLive(env, msg.from.id);
    await sendMessage(env, msg.chat.id, '✅ Operator bilan faol suhbat rejimi yopildi. Ticket o‘zi ochiq qoladi.');
    return true;
  }
  const s = await getUserLive(env, msg.from.id);
  if (!s?.ticket_no) return false;
  const t = await getTicket(env, s.ticket_no);
  if (!t) { await clearUserLive(env, msg.from.id); return false; }
  return customerToOperator(env, msg, t);
}

export async function handleV11Update(env, update) {
  let relevant = false;
  if (update.callback_query) {
    const d = String(update.callback_query.data || '');
    relevant = d.startsWith('op:') || d.startsWith('opmove:') || d.startsWith('opcancel:') || d.startsWith('ticket:reply:');
  } else if (update.message) {
    relevant = isGroup(update.message.chat) || isPrivate(update.message.chat);
  }
  if (!relevant) return false;
  await ensureV11Schema(env);

  if (update.callback_query) {
    const d = String(update.callback_query.data || '');
    const handled = d.startsWith('ticket:reply:')
      ? await handlePrivateCallback(env, update.callback_query)
      : await handleOperatorCallback(env, update.callback_query);
    if (handled) {
      if (!await claimUpdate(env, update.update_id)) return true;
      return true;
    }
    return false;
  }

  if (update.message) {
    // Decide first, then mark processed only when v11 actually owns this update.
    let handled = false;
    if (isGroup(update.message.chat)) handled = await handleGroupMessage(env, update.message);
    else if (isPrivate(update.message.chat)) handled = await handlePrivateMessage(env, update.message);
    if (handled) {
      if (!await claimUpdate(env, update.update_id)) return true;
      return true;
    }
  }
  return false;
}

export async function runV11Maintenance(env) {
  await ensureV11Schema(env);
  await env.DB.prepare("DELETE FROM fn11_processed WHERE created_at < datetime('now','-7 day')").run();
  await env.DB.prepare("DELETE FROM fn11_operator_compose WHERE datetime(updated_at) < datetime('now','-10 minutes')").run();
  await env.DB.prepare("DELETE FROM fn11_user_live WHERE datetime(updated_at) < datetime('now','-24 hours')").run();

  const rows = await env.DB.prepare(`SELECT ticket_no,priority,created_at,support_chat_id,support_message_id
    FROM fn5_tickets WHERE status='open' AND assigned_to IS NULL AND support_chat_id IS NOT NULL`).all();
  const thresholds = { critical: 3, high: 5, normal: 10, low: 20 };
  const nowMs = Date.now();
  for (const t of rows.results || []) {
    const mins = Math.floor((nowMs - new Date(t.created_at).getTime()) / 60000);
    if (mins < (thresholds[t.priority] || 10)) continue;
    const sent = await env.DB.prepare(`SELECT 1 ok FROM fn11_events WHERE ticket_no=? AND event='sla_alert' LIMIT 1`).bind(t.ticket_no).first();
    if (sent) continue;
    try {
      const m = await sendMessage(env, t.support_chat_id,
        `⏰ <b>SLA ogohlantirish</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n⏱ ${mins} daqiqadan beri operator qabul qilmagan.`,
        t.support_message_id ? { reply_parameters: { message_id: t.support_message_id, allow_sending_without_reply: true } } : {});
      await bridge(env, t.support_chat_id, m.message_id, t.ticket_no, 'sla_alert');
      await event(env, t.ticket_no, 'system', null, 'sla_alert', { minutes: mins });
    } catch (e) { console.warn('v11 sla alert', String(e)); }
  }
}

export const __test = { stageLabel, operatorKeyboard, transferKeyboard };
