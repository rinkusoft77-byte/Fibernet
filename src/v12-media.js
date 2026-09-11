import {
  addMessage, getTicket, getTicketBySupportMessage, getUser, setSupportMessage
} from './v5-db.js';
import { ensureV11Schema } from './v11-support.js';
import { L, operatorName } from './v8-ui.js';
import { escapeHtml, sendMessage, tg } from './telegram.js';

const now = () => new Date().toISOString();
let ready = false;
const ENV_CHAT_KEYS = {
  tech: 'TECH_CHAT_ID', accounting: 'ACCOUNTING_CHAT_ID',
  subscriber: 'SUBSCRIBER_CHAT_ID', connection: 'CONNECTION_CHAT_ID', general: 'SUPPORT_CHAT_ID'
};

export function mediaKind(msg = {}) {
  if (msg.sticker) return 'sticker';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
  if (msg.video_note) return 'video_note';
  if (msg.animation) return 'animation';
  if (msg.voice) return 'voice';
  if (msg.audio) return 'audio';
  if (msg.document) return 'document';
  return null;
}

export function isSupportedMedia(msg = {}) { return Boolean(mediaKind(msg)); }

function isPrivate(chat) { return chat?.type === 'private'; }
function isGroup(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
function bodyOf(msg) { return String(msg?.caption || '').trim(); }
function adminIds(env) { return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String); }
function isAdmin(env, id) { return adminIds(env).includes(String(id)); }

async function ensureSchema(env) {
  if (ready) return;
  await ensureV11Schema(env);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fn12_media_processed (
    update_id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  ready = true;
}

async function claimUpdate(env, updateId) {
  await ensureSchema(env);
  if (!Number.isInteger(updateId)) return true;
  try {
    await env.DB.prepare('INSERT INTO fn12_media_processed(update_id) VALUES(?)').bind(updateId).run();
    return true;
  } catch (e) {
    const s = String(e).toLowerCase();
    if (s.includes('unique') || s.includes('constraint')) return false;
    throw e;
  }
}

async function bridge(env, chatId, messageId, ticketNo, direction) {
  if (!chatId || !messageId) return;
  await env.DB.prepare(`INSERT INTO fn11_bridge(chat_id,message_id,ticket_no,direction)
    VALUES(?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET ticket_no=excluded.ticket_no,direction=excluded.direction`)
    .bind(chatId, messageId, ticketNo, direction).run();
}

async function event(env, ticketNo, actorType, actorId, name, data = null) {
  await env.DB.prepare('INSERT INTO fn11_events(ticket_no,actor_type,actor_id,event,data) VALUES(?,?,?,?,?)')
    .bind(ticketNo, actorType, actorId || null, name, data ? JSON.stringify(data) : null).run();
}

async function setUserLive(env, telegramId, ticketNo) {
  await env.DB.prepare(`INSERT INTO fn11_user_live(telegram_id,ticket_no,updated_at) VALUES(?,?,?)
    ON CONFLICT(telegram_id) DO UPDATE SET ticket_no=excluded.ticket_no,updated_at=excluded.updated_at`)
    .bind(telegramId, ticketNo, now()).run();
}

async function getUserLive(env, telegramId) {
  return env.DB.prepare(`SELECT * FROM fn11_user_live WHERE telegram_id=?
    AND datetime(updated_at)>=datetime('now','-24 hours')`).bind(telegramId).first();
}

async function getCompose(env, chatId, operatorId) {
  return env.DB.prepare(`SELECT * FROM fn11_operator_compose WHERE chat_id=? AND operator_id=?
    AND datetime(updated_at)>=datetime('now','-10 minutes')`).bind(chatId, operatorId).first();
}

async function clearCompose(env, chatId, operatorId) {
  return env.DB.prepare('DELETE FROM fn11_operator_compose WHERE chat_id=? AND operator_id=?').bind(chatId, operatorId).run();
}

async function ticketByReply(env, chatId, messageId) {
  const b = await env.DB.prepare('SELECT ticket_no FROM fn11_bridge WHERE chat_id=? AND message_id=?')
    .bind(chatId, messageId).first();
  if (b?.ticket_no) return getTicket(env, b.ticket_no);
  return getTicketBySupportMessage(env, chatId, messageId);
}

async function resolveDepartmentChat(env, department) {
  const row = await env.DB.prepare('SELECT chat_id FROM fn7_department_chats WHERE department=?')
    .bind(department).first();
  if (row?.chat_id) return row.chat_id;
  const key = ENV_CHAT_KEYS[department] || 'SUPPORT_CHAT_ID';
  return env[key] || env.SUPPORT_CHAT_ID || null;
}

async function atomicClaim(env, ticketNo, op) {
  const r = await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=?,assigned_name=?,
    stage=CASE WHEN stage='new' THEN 'in_progress' ELSE stage END,updated_at=?
    WHERE ticket_no=? AND status='open' AND (assigned_to IS NULL OR assigned_to=?)`)
    .bind(op.id, op.name, now(), ticketNo, op.id).run();
  return (r.meta?.changes || 0) > 0;
}

async function reactOk(env, chatId, messageId) {
  try {
    await tg(env, 'setMessageReaction', {
      chat_id: chatId, message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '👍' }]
    });
  } catch {}
}

async function customerMedia(env, msg) {
  const live = await getUserLive(env, msg.from.id);
  if (!live?.ticket_no) return false;
  let t = await getTicket(env, live.ticket_no);
  if (!t || String(t.telegram_id) !== String(msg.from.id)) return false;
  if (t.status !== 'open') return false;

  let chatId = t.support_chat_id;
  if (!chatId) {
    chatId = await resolveDepartmentChat(env, t.department);
    if (!chatId) {
      const u = await getUser(env, t.telegram_id);
      await sendMessage(env, msg.chat.id, L(u?.language || 'uz',
        '⚠️ Operator guruhi hozircha ulanmagan. Media yuborilmadi.',
        '⚠️ Группа операторов пока не подключена. Медиа не отправлено.'));
      return true;
    }
    const u = await getUser(env, t.telegram_id);
    const card = await sendMessage(env, chatId,
      `🎫 <b>${escapeHtml(t.ticket_no)}</b>\n👤 ${escapeHtml([u?.first_name,u?.last_name].filter(Boolean).join(' ') || String(t.telegram_id))}\n📝 Media davomiy murojaat`);
    await setSupportMessage(env, t.ticket_no, chatId, card.message_id);
    await bridge(env, chatId, card.message_id, t.ticket_no, 'ticket_card');
    t = await getTicket(env, t.ticket_no);
  }

  const kind = mediaKind(msg);
  const u = await getUser(env, t.telegram_id);
  const head = await sendMessage(env, chatId,
    `💬 <b>${escapeHtml(t.ticket_no)} · mijoz</b>\n👤 ${escapeHtml([u?.first_name,u?.last_name].filter(Boolean).join(' ') || String(t.telegram_id))}\n📎 ${escapeHtml(kind)}`,
    t.support_message_id ? { reply_parameters: { message_id: t.support_message_id, allow_sending_without_reply: true } } : {});
  await bridge(env, chatId, head.message_id, t.ticket_no, 'customer');
  const copied = await tg(env, 'copyMessage', {
    chat_id: chatId,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
    reply_parameters: { message_id: head.message_id, allow_sending_without_reply: true }
  });
  if (copied?.message_id) await bridge(env, chatId, copied.message_id, t.ticket_no, `customer_${kind}`);
  await addMessage(env, t.ticket_no, 'user', msg.from.id, bodyOf(msg) || `[${kind}]`, msg.message_id);
  await env.DB.prepare("UPDATE fn5_tickets SET stage='in_progress',updated_at=? WHERE ticket_no=? AND status='open'")
    .bind(now(), t.ticket_no).run();
  await setUserLive(env, msg.from.id, t.ticket_no);
  await event(env, t.ticket_no, 'user', msg.from.id, 'customer_media', { kind });
  await reactOk(env, msg.chat.id, msg.message_id);
  return true;
}

async function operatorMedia(env, msg) {
  let t = null;
  if (msg.reply_to_message?.message_id) t = await ticketByReply(env, msg.chat.id, msg.reply_to_message.message_id);
  if (!t) {
    const compose = await getCompose(env, msg.chat.id, msg.from.id);
    if (compose?.ticket_no) t = await getTicket(env, compose.ticket_no);
  }
  if (!t) return false;
  if (t.status !== 'open') return true;
  if (t.support_chat_id && String(t.support_chat_id) !== String(msg.chat.id)) return false;

  const op = { id: msg.from.id, name: operatorName(msg.from) };
  if (t.assigned_to && String(t.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) {
    await sendMessage(env, msg.chat.id,
      `⚠️ <code>${escapeHtml(t.ticket_no)}</code> boshqa operatorga biriktirilgan: <b>${escapeHtml(t.assigned_name || String(t.assigned_to))}</b>`,
      { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
    return true;
  }
  if (!t.assigned_to && !await atomicClaim(env, t.ticket_no, op)) return true;

  const kind = mediaKind(msg);
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  await sendMessage(env, t.telegram_id,
    `👨‍💻 <b>FiberNet ${L(lang, 'operatori', 'оператор')}</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n📎 ${escapeHtml(kind)}`);
  await tg(env, 'copyMessage', {
    chat_id: t.telegram_id,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id
  });
  await bridge(env, msg.chat.id, msg.message_id, t.ticket_no, `operator_${kind}`);
  await addMessage(env, t.ticket_no, 'operator', op.id, bodyOf(msg) || `[${kind}]`, msg.message_id);
  await env.DB.prepare("UPDATE fn5_tickets SET stage='waiting_customer',assigned_to=COALESCE(assigned_to,?),assigned_name=COALESCE(assigned_name,?),updated_at=? WHERE ticket_no=? AND status='open'")
    .bind(op.id, op.name, now(), t.ticket_no).run();
  await setUserLive(env, t.telegram_id, t.ticket_no);
  await clearCompose(env, msg.chat.id, op.id);
  await event(env, t.ticket_no, 'operator', op.id, 'operator_media', { kind });
  await reactOk(env, msg.chat.id, msg.message_id);
  return true;
}

export async function handleV12Media(env, update) {
  const msg = update?.message;
  if (!msg || msg.from?.is_bot || !isSupportedMedia(msg)) return false;
  if (!await claimUpdate(env, update.update_id)) return true;
  if (isPrivate(msg.chat)) return customerMedia(env, msg);
  if (isGroup(msg.chat)) return operatorMedia(env, msg);
  return false;
}

export async function cleanupV12Media(env) {
  await ensureSchema(env);
  return env.DB.prepare("DELETE FROM fn12_media_processed WHERE created_at < datetime('now','-7 day')").run();
}

export const __test = { mediaKind, isSupportedMedia };
