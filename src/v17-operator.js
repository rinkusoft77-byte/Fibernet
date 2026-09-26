import {
  addMessage, clearSession, closeTicket, getSession, getTicket, getUser, sessionData, setStage
} from './v5-db.js';
import { getDepartmentByChat } from './v7-routing.js';
import { L, operatorName } from './v8-ui.js';
import { ensureTopicForTicket } from './v15-helpdesk.js';
import { markOperatorActivity } from './v21-conversation.js';
import { answerCallback, escapeHtml, inlineKeyboard, sendMessage, tg } from './telegram.js';

const now = () => new Date().toISOString();
let ready = false;

function isPrivate(chat) { return chat?.type === 'private'; }
function isGroup(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
function adminIds(env) { return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String); }
function isAdmin(env, id) { return adminIds(env).includes(String(id)); }
function bodyOf(msg) { return String(msg?.text || msg?.caption || '').trim(); }

export function explicitReplyTicketNo(session) {
  if (!session || session.state !== 'ticket_reply') return null;
  const d = sessionData(session);
  return d?.ticketNo ? String(d.ticketNo) : null;
}

function customerReplyKeyboard(ticketNo) {
  return inlineKeyboard([[
    { text:'💬 Operatorga javob / Ответить', callback_data:`ticket:reply:${ticketNo}` }
  ]]);
}

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

export async function ensureV17Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn17_processed (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn17_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      ticket_no TEXT NOT NULL,
      direction TEXT NOT NULL,
      source_chat_id INTEGER NOT NULL,
      source_message_id INTEGER NOT NULL,
      target_chat_id INTEGER NOT NULL,
      target_thread_id INTEGER,
      reply_to_target_message_id INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn17_outbox_due ON fn17_outbox(next_try_at)`,
    `CREATE TABLE IF NOT EXISTS fn17_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      operator_name TEXT,
      state TEXT NOT NULL DEFAULT 'internal',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn17_drafts_ticket ON fn17_drafts(ticket_no,state,id DESC)`,
    `CREATE TABLE IF NOT EXISTS fn17_snoozes (
      ticket_no TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      wake_at TEXT NOT NULL,
      created_by INTEGER,
      created_by_name TEXT,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn17_snooze_due ON fn17_snoozes(wake_at)`,
    `CREATE TABLE IF NOT EXISTS fn17_tags (
      ticket_no TEXT NOT NULL,
      tag TEXT NOT NULL,
      added_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(ticket_no,tag)
    )`,
    `CREATE TABLE IF NOT EXISTS fn17_operator_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT,
      operator_id INTEGER,
      event TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

async function claimUpdate(env, id) {
  if (!Number.isInteger(id)) return true;
  await ensureV17Schema(env);
  try {
    await env.DB.prepare('INSERT INTO fn17_processed(update_id) VALUES(?)').bind(id).run();
    return true;
  } catch (e) {
    const s = String(e).toLowerCase();
    if (s.includes('unique') || s.includes('constraint')) return false;
    throw e;
  }
}

async function logEvent(env, ticketNo, operatorId, event, data = null) {
  try {
    await env.DB.prepare('INSERT INTO fn17_operator_events(ticket_no,operator_id,event,data) VALUES(?,?,?,?)')
      .bind(ticketNo || null, operatorId || null, event, data ? JSON.stringify(data) : null).run();
  } catch {}
  try {
    if (ticketNo) {
      await env.DB.prepare('INSERT INTO fn11_events(ticket_no,actor_type,actor_id,event,data) VALUES(?,?,?,?,?)')
        .bind(ticketNo, operatorId ? 'operator' : 'system', operatorId || null, `v17_${event}`, data ? JSON.stringify(data) : null).run();
    }
  } catch {}
}

async function topicTicket(env, msg) {
  if (!msg?.message_thread_id) return null;
  const row = await env.DB.prepare(`SELECT ticket_no FROM fn15_topics
    WHERE chat_id=? AND thread_id=? AND state='open'`).bind(msg.chat.id, msg.message_thread_id).first();
  return row?.ticket_no ? getTicket(env, row.ticket_no) : null;
}

async function activeUserTicket(env, telegramId) {
  // Strict rule: a private user message belongs to an operator ticket ONLY
  // after the user explicitly pressed "Operatorga javob / Ответить оператору".
  // An open ticket, recent live pointer, or normal bot conversation is never
  // enough to forward private messages to an operator group.
  const s = await getSession(env, telegramId);
  const no = explicitReplyTicketNo(s);
  if (!no) return null;
  const t = await getTicket(env, no);
  if (!t || t.status !== 'open' || String(t.telegram_id) !== String(telegramId)) return null;
  return t;
}

async function setUserLive(env, telegramId, ticketNo) {
  try {
    await env.DB.prepare(`INSERT INTO fn11_user_live(telegram_id,ticket_no,updated_at) VALUES(?,?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET ticket_no=excluded.ticket_no,updated_at=excluded.updated_at`)
      .bind(telegramId, ticketNo, now()).run();
  } catch {}
}

async function saveMirror(env, sourceChatId, sourceMessageId, targetChatId, targetMessageId, ticketNo, direction) {
  await env.DB.prepare(`INSERT INTO fn15_mirrors(source_chat_id,source_message_id,target_chat_id,target_message_id,ticket_no,direction)
    VALUES(?,?,?,?,?,?) ON CONFLICT(source_chat_id,source_message_id,target_chat_id)
    DO UPDATE SET target_message_id=excluded.target_message_id,ticket_no=excluded.ticket_no,direction=excluded.direction`)
    .bind(sourceChatId, sourceMessageId, targetChatId, targetMessageId, ticketNo, direction).run();
}

async function mirrorForReply(env, sourceChatId, repliedMessageId, targetChatId) {
  if (!repliedMessageId) return null;
  return env.DB.prepare(`SELECT * FROM fn15_mirrors
    WHERE target_chat_id=? AND target_message_id=? AND source_chat_id=?
    ORDER BY created_at DESC LIMIT 1`)
    .bind(sourceChatId, repliedMessageId, targetChatId).first();
}

async function enqueue(env, spec, error) {
  const key = `${spec.direction}:${spec.sourceChatId}:${spec.sourceMessageId}:${spec.targetChatId}:${spec.targetThreadId || 0}`;
  await env.DB.prepare(`INSERT INTO fn17_outbox(
    dedupe_key,ticket_no,direction,source_chat_id,source_message_id,target_chat_id,target_thread_id,
    reply_to_target_message_id,last_error,next_try_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT(dedupe_key) DO UPDATE SET
    reply_to_target_message_id=excluded.reply_to_target_message_id,last_error=excluded.last_error,
    next_try_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`)
    .bind(key, spec.ticketNo, spec.direction, spec.sourceChatId, spec.sourceMessageId,
      spec.targetChatId, spec.targetThreadId || null, spec.replyToTargetMessageId || null,
      String(error || '').slice(0, 500)).run();
}

async function copyReliable(env, spec) {
  const payload = {
    chat_id: spec.targetChatId,
    from_chat_id: spec.sourceChatId,
    message_id: spec.sourceMessageId,
    ...(spec.targetThreadId ? { message_thread_id: spec.targetThreadId } : {}),
    ...(spec.replyToTargetMessageId ? {
      reply_parameters: { message_id: spec.replyToTargetMessageId, allow_sending_without_reply: true }
    } : {}),
    ...(spec.replyMarkup ? { reply_markup: spec.replyMarkup } : {})
  };
  try {
    const copied = await tg(env, 'copyMessage', payload);
    if (copied?.message_id) {
      await saveMirror(env, spec.sourceChatId, spec.sourceMessageId, spec.targetChatId,
        copied.message_id, spec.ticketNo, spec.direction);
    }
    return { ok: true, messageId: copied?.message_id || null };
  } catch (e) {
    await enqueue(env, spec, e);
    return { ok: false, error: String(e) };
  }
}

async function replyTargetForOperator(env, msg, t) {
  const replied = msg.reply_to_message?.message_id;
  if (!replied) return null;
  const m = await mirrorForReply(env, msg.chat.id, replied, t.telegram_id);
  return m?.source_message_id || null;
}

async function replyTargetForUser(env, msg, topic) {
  const replied = msg.reply_to_message?.message_id;
  if (!replied) return null;
  const m = await mirrorForReply(env, msg.chat.id, replied, topic.chat_id);
  return m?.source_message_id || null;
}

async function atomicClaim(env, t, from) {
  const name = operatorName(from);
  const r = await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=?,assigned_name=?,
    stage=CASE WHEN stage='new' THEN 'in_progress' ELSE stage END,updated_at=?
    WHERE ticket_no=? AND status='open' AND assigned_to IS NULL`)
    .bind(from.id, name, now(), t.ticket_no).run();
  if ((r.meta?.changes || 0) > 0) {
    await logEvent(env, t.ticket_no, from.id, 'claim');
    return true;
  }
  const fresh = await getTicket(env, t.ticket_no);
  return String(fresh?.assigned_to) === String(from.id);
}

async function customerAssignedNotice(env, t, operatorId, name) {
  const u = await getUser(env, t.telegram_id);
  try {
    await sendMessage(env, t.telegram_id, L(u?.language || 'uz',
      `👨‍💻 <b>Operator biriktirildi</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\n${escapeHtml(name)} murojaatingizni davom ettiradi.`,
      `👨‍💻 <b>Назначен оператор</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\n${escapeHtml(name)} продолжит работу с обращением.`));
  } catch {}
}

function draftKeyboard(draftId, ticketNo) {
  return inlineKeyboard([
    [{ text:'📤 Mijozga yuborish', callback_data:`v17:draftsend:${draftId}` }],
    [{ text:'🙋 Handoff so‘rash', callback_data:`v17:handoff:${ticketNo}` }]
  ]);
}

async function saveInternalDraft(env, msg, t) {
  const r = await env.DB.prepare(`INSERT INTO fn17_drafts(
    ticket_no,chat_id,thread_id,message_id,operator_id,operator_name
  ) VALUES(?,?,?,?,?,?)`)
    .bind(t.ticket_no, msg.chat.id, msg.message_thread_id, msg.message_id, msg.from.id, operatorName(msg.from)).run();
  const id = r.meta?.last_row_id;
  await logEvent(env, t.ticket_no, msg.from.id, 'internal_collaboration', { message_id: msg.message_id, draft_id: id });
  await sendMessage(env, msg.chat.id, [
    '🔒 <b>Ichki xabar</b> — mijoz buni ko‘rmadi.',
    t.assigned_name ? `👨‍💻 Ticket egasi: <b>${escapeHtml(t.assigned_name)}</b>` : null,
    'Ticket egasi/admin xohlasa bir bosishda mijozga yuborishi mumkin.'
  ].filter(Boolean).join('\n'), {
    message_thread_id: msg.message_thread_id,
    reply_to_message_id: msg.message_id,
    reply_markup: draftKeyboard(id, t.ticket_no)
  });
  return true;
}

async function operatorRelay(env, msg, t) {
  if (!relayKind(msg)) return false;
  const owner = t.assigned_to ? String(t.assigned_to) : null;
  const me = String(msg.from.id);

  if (owner && owner !== me) {
    return saveInternalDraft(env, msg, t);
  }

  if (!owner) {
    const claimed = await atomicClaim(env, t, msg.from);
    if (!claimed) {
      const fresh = await getTicket(env, t.ticket_no);
      if (String(fresh?.assigned_to) !== me) return saveInternalDraft(env, msg, fresh);
    } else {
      await customerAssignedNotice(env, t, msg.from.id, operatorName(msg.from));
      t = await getTicket(env, t.ticket_no);
    }
  }

  const replyTo = await replyTargetForOperator(env, msg, t);
  const r = await copyReliable(env, {
    ticketNo: t.ticket_no,
    direction: 'operator_to_user',
    sourceChatId: msg.chat.id,
    sourceMessageId: msg.message_id,
    targetChatId: t.telegram_id,
    replyToTargetMessageId: replyTo,
    replyMarkup: customerReplyKeyboard(t.ticket_no)
  });

  if (!r.ok) {
    await sendMessage(env, msg.chat.id,
      '⏳ Xabar saqlandi. Telegram vaqtincha qabul qilmasa bot avtomatik qayta yuboradi.',
      { message_thread_id: msg.message_thread_id, reply_to_message_id: msg.message_id });
    return true;
  }

  await addMessage(env, t.ticket_no, 'operator', msg.from.id, bodyOf(msg) || `[${relayKind(msg)}]`, msg.message_id);
  await setStage(env, t.ticket_no, 'waiting_customer', { id: msg.from.id, name: operatorName(msg.from) });
  await setUserLive(env, t.telegram_id, t.ticket_no);
  await markOperatorActivity(env, t.ticket_no);
  await logEvent(env, t.ticket_no, msg.from.id, 'reply', { kind: relayKind(msg), quoted: Boolean(replyTo) });
  try {
    await tg(env, 'setMessageReaction', {
      chat_id: msg.chat.id, message_id: msg.message_id,
      reaction: [{ type:'emoji', emoji:'👍' }]
    });
  } catch {}
  return true;
}

async function userRelay(env, msg, t, topic) {
  if (!relayKind(msg)) return false;
  const replyTo = await replyTargetForUser(env, msg, topic);
  const r = await copyReliable(env, {
    ticketNo: t.ticket_no,
    direction: 'user_to_operator',
    sourceChatId: msg.chat.id,
    sourceMessageId: msg.message_id,
    targetChatId: topic.chat_id,
    targetThreadId: topic.thread_id,
    replyToTargetMessageId: replyTo
  });

  // One explicit reply action sends exactly one user message/media item.
  // Clear the routing session even when delivery was queued: the submitted
  // message is already persisted in the outbox and must not make later bot
  // navigation/messages leak into the operator group.
  await clearSession(env, msg.from.id);

  if (!r.ok) {
    const u = await getUser(env, t.telegram_id);
    await sendMessage(env, msg.chat.id, L(u?.language || 'uz',
      '⏳ Xabaringiz saqlandi. Yetkazish avtomatik qayta urinadi.',
      '⏳ Сообщение сохранено. Доставка будет повторена автоматически.'));
    return true;
  }
  await addMessage(env, t.ticket_no, 'user', msg.from.id, bodyOf(msg) || `[${relayKind(msg)}]`, msg.message_id);
  await setStage(env, t.ticket_no, 'in_progress');
  await setUserLive(env, msg.from.id, t.ticket_no);
  await logEvent(env, t.ticket_no, null, 'customer_reply', { kind: relayKind(msg), quoted: Boolean(replyTo) });
  try {
    await tg(env, 'setMessageReaction', {
      chat_id: msg.chat.id, message_id: msg.message_id,
      reaction: [{ type:'emoji', emoji:'👍' }]
    });
  } catch {}
  if (r.messageId) {
    try {
      await tg(env, 'setMessageReaction', {
        chat_id: topic.chat_id, message_id: r.messageId,
        reaction: [{ type:'emoji', emoji:'👀' }]
      });
    } catch {}
  }
  return true;
}

function assignmentKeyboard(agents, ticketNo) {
  const rows = [];
  for (const a of agents.slice(0, 10)) {
    rows.push([{
      text: `${a.status === 'online' ? '🟢' : '🟡'} ${a.operator_name || a.username || a.operator_id} · ${a.load}/${a.capacity}`,
      callback_data: `v17:assign:${ticketNo}:${a.operator_id}`
    }]);
  }
  rows.push([{ text:'♻️ Navbatga qaytarish', callback_data:`v17:unassign:${ticketNo}` }]);
  return inlineKeyboard(rows);
}

async function showAssignMenu(env, q, ticketNo) {
  const t = await getTicket(env, ticketNo);
  if (!t) { await answerCallback(env, q.id, 'Ticket topilmadi'); return true; }
  const agentsR = await env.DB.prepare(`SELECT a.*,
    (SELECT COUNT(*) FROM fn5_tickets t WHERE t.status='open' AND t.assigned_to=a.operator_id) load
    FROM fn15_agents a
    JOIN fn19_operator_acl acl ON acl.chat_id=a.chat_id AND acl.user_id=a.operator_id AND acl.status='approved'
    WHERE a.chat_id=? AND a.status IN ('online','away')
    ORDER BY CASE a.status WHEN 'online' THEN 0 ELSE 1 END,load ASC,a.operator_name ASC LIMIT 10`)
    .bind(q.message.chat.id).all();
  await answerCallback(env, q.id, 'Operator tanlang');
  await sendMessage(env, q.message.chat.id,
    `👥 <b>Operatorga biriktirish</b>\n🎫 <code>${escapeHtml(ticketNo)}</code>\n\n🟢 online · 🟡 away`,
    {
      ...(q.message.message_thread_id ? { message_thread_id:q.message.message_thread_id } : {}),
      reply_markup: assignmentKeyboard(agentsR.results || [], ticketNo)
    });
  return true;
}

async function assignToAgent(env, q, ticketNo, operatorId) {
  const t = await getTicket(env, ticketNo);
  if (!t) { await answerCallback(env, q.id, 'Ticket topilmadi'); return true; }
  const allowed = !t.assigned_to || String(t.assigned_to) === String(q.from.id) || isAdmin(env, q.from.id);
  if (!allowed) { await answerCallback(env, q.id, 'Faqat ticket egasi yoki admin qayta biriktira oladi'); return true; }
  const a = await env.DB.prepare(`SELECT a.* FROM fn15_agents a
    JOIN fn19_operator_acl acl ON acl.chat_id=a.chat_id AND acl.user_id=a.operator_id AND acl.status='approved'
    WHERE a.chat_id=? AND a.operator_id=?`)
    .bind(q.message.chat.id, operatorId).first();
  if (!a) { await answerCallback(env, q.id, 'Tasdiqlangan operator topilmadi'); return true; }
  const name = a.operator_name || a.username || String(a.operator_id);
  await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=?,assigned_name=?,stage='in_progress',updated_at=?
    WHERE ticket_no=? AND status='open'`).bind(a.operator_id, name, now(), ticketNo).run();
  await logEvent(env, ticketNo, q.from.id, 'assign', { to:a.operator_id, name });
  await customerAssignedNotice(env, t, a.operator_id, name);
  await answerCallback(env, q.id, 'Biriktirildi');
  await sendMessage(env, q.message.chat.id,
    `👨‍💻 <b>${escapeHtml(name)}</b> ticketga biriktirildi.`,
    q.message.message_thread_id ? { message_thread_id:q.message.message_thread_id } : {});
  return true;
}

async function unassign(env, q, ticketNo) {
  const t = await getTicket(env, ticketNo);
  if (!t) { await answerCallback(env, q.id, 'Ticket topilmadi'); return true; }
  if (t.assigned_to && String(t.assigned_to) !== String(q.from.id) && !isAdmin(env, q.from.id)) {
    await answerCallback(env, q.id, 'Faqat ticket egasi yoki admin');
    return true;
  }
  await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=NULL,assigned_name=NULL,stage='new',updated_at=?
    WHERE ticket_no=? AND status='open'`).bind(now(), ticketNo).run();
  await logEvent(env, ticketNo, q.from.id, 'unassign');
  await answerCallback(env, q.id, 'Navbatga qaytarildi');
  await sendMessage(env, q.message.chat.id, '♻️ Ticket umumiy navbatga qaytarildi.',
    q.message.message_thread_id ? { message_thread_id:q.message.message_thread_id } : {});
  return true;
}

function priorityKeyboard(no) {
  return inlineKeyboard([
    [{ text:'🚨 Critical', callback_data:`v17:priority:${no}:critical` },
     { text:'🔴 High', callback_data:`v17:priority:${no}:high` }],
    [{ text:'🟡 Normal', callback_data:`v17:priority:${no}:normal` },
     { text:'🟢 Low', callback_data:`v17:priority:${no}:low` }]
  ]);
}

function snoozeKeyboard(no) {
  return inlineKeyboard([
    [{ text:'⏰ 15 min', callback_data:`v17:snooze:${no}:15` },
     { text:'⏰ 1 soat', callback_data:`v17:snooze:${no}:60` }],
    [{ text:'🌙 4 soat', callback_data:`v17:snooze:${no}:240` },
     { text:'📅 24 soat', callback_data:`v17:snooze:${no}:1440` }]
  ]);
}

async function slaText(env, no) {
  const t = await getTicket(env, no);
  if (!t) return 'Ticket topilmadi.';
  const limits = { critical:10, high:20, normal:45, low:90 };
  const target = limits[t.priority] || 45;
  const age = Math.max(0, Math.round((Date.now() - new Date(t.created_at).getTime()) / 60000));
  const first = await env.DB.prepare(`SELECT created_at FROM fn5_messages
    WHERE ticket_no=? AND sender_type='operator' ORDER BY id ASC LIMIT 1`).bind(no).first();
  const firstMin = first ? Math.max(0, Math.round((new Date(first.created_at).getTime() - new Date(t.created_at).getTime()) / 60000)) : null;
  const left = first ? null : target - age;
  return [
    `⏱ <b>SLA · ${escapeHtml(no)}</b>`,
    `🎯 Target first response: <b>${target} min</b>`,
    `🕒 Ticket yoshi: <b>${age} min</b>`,
    firstMin != null ? `✅ Birinchi javob: <b>${firstMin} min</b>` :
      left >= 0 ? `⏳ Qolgan vaqt: <b>${left} min</b>` : `🚨 SLA o‘tgan: <b>${Math.abs(left)} min</b>`,
    `📌 Stage: <b>${escapeHtml(t.stage)}</b>`
  ].join('\n');
}

async function sendDraft(env, q, draftId) {
  const d = await env.DB.prepare('SELECT * FROM fn17_drafts WHERE id=?').bind(draftId).first();
  if (!d || d.state !== 'internal') { await answerCallback(env, q.id, 'Draft allaqachon yuborilgan'); return true; }
  const t = await getTicket(env, d.ticket_no);
  if (!t || t.status !== 'open') { await answerCallback(env, q.id, 'Ticket yopilgan'); return true; }
  const allowed = !t.assigned_to || String(t.assigned_to) === String(q.from.id) || isAdmin(env, q.from.id);
  if (!allowed) { await answerCallback(env, q.id, 'Ticket egasi yoki admin yubora oladi'); return true; }
  if (!t.assigned_to) await atomicClaim(env, t, q.from);
  const originalReply = q.message?.reply_to_message?.reply_to_message?.message_id || null;
  let replyTo = null;
  if (originalReply) {
    const m = await mirrorForReply(env, d.chat_id, originalReply, t.telegram_id);
    replyTo = m?.source_message_id || null;
  }
  const r = await copyReliable(env, {
    ticketNo: t.ticket_no,
    direction:'operator_to_user',
    sourceChatId:d.chat_id,
    sourceMessageId:d.message_id,
    targetChatId:t.telegram_id,
    replyToTargetMessageId:replyTo
  });
  if (!r.ok) { await answerCallback(env, q.id, 'Queue’ga qo‘yildi'); return true; }
  await env.DB.prepare("UPDATE fn17_drafts SET state='sent',sent_at=? WHERE id=?").bind(now(), draftId).run();
  await addMessage(env, t.ticket_no, 'operator', q.from.id, '[approved internal draft]', d.message_id);
  await setStage(env, t.ticket_no, 'waiting_customer', { id:q.from.id, name:operatorName(q.from) });
  await setUserLive(env, t.telegram_id, t.ticket_no);
  await logEvent(env, t.ticket_no, q.from.id, 'draft_approved', { draft_id:draftId, author_id:d.operator_id });
  await answerCallback(env, q.id, 'Mijozga yuborildi');
  return true;
}

async function requestHandoff(env, q, no) {
  const t = await getTicket(env, no);
  await answerCallback(env, q.id, 'Handoff so‘rovi yuborildi');
  await sendMessage(env, q.message.chat.id, [
    '🙋 <b>Handoff so‘rovi</b>',
    `${escapeHtml(operatorName(q.from))} ticketni qabul qilish/hamkorlik qilishni so‘radi.`,
    t?.assigned_name ? `Hozirgi egasi: <b>${escapeHtml(t.assigned_name)}</b>` : 'Ticket hozir unassigned.'
  ].join('\n'), q.message.message_thread_id ? { message_thread_id:q.message.message_thread_id } : {});
  await logEvent(env, no, q.from.id, 'handoff_request');
  return true;
}

async function undoReply(env, msg, t, both = false) {
  const replied = msg.reply_to_message?.message_id;
  if (!replied) {
    await sendMessage(env, msg.chat.id, '↩️ /undo ni mijozga yuborilgan xabarga Reply qilib ishlating.',
      { message_thread_id:msg.message_thread_id });
    return true;
  }
  const m = await env.DB.prepare(`SELECT * FROM fn15_mirrors
    WHERE source_chat_id=? AND source_message_id=? AND target_chat_id=? AND direction='operator_to_user'
    ORDER BY created_at DESC LIMIT 1`).bind(msg.chat.id, replied, t.telegram_id).first();
  if (!m) {
    await sendMessage(env, msg.chat.id, '⚠️ Bu xabarning mijoz tomondagi nusxasi topilmadi.',
      { message_thread_id:msg.message_thread_id });
    return true;
  }
  try {
    await tg(env, 'deleteMessage', { chat_id:t.telegram_id, message_id:m.target_message_id });
    if (both) {
      try { await tg(env, 'deleteMessage', { chat_id:msg.chat.id, message_id:replied }); } catch {}
    }
    await env.DB.prepare(`DELETE FROM fn15_mirrors WHERE source_chat_id=? AND source_message_id=? AND target_chat_id=?`)
      .bind(msg.chat.id, replied, t.telegram_id).run();
    await logEvent(env, t.ticket_no, msg.from.id, both ? 'delete_both' : 'undo_customer_copy', { source_message_id:replied });
    await sendMessage(env, msg.chat.id, both ? '🗑 Xabar ikki tomondan o‘chirishga yuborildi.' : '↩️ Mijoz tomondagi xabar o‘chirildi.',
      { message_thread_id:msg.message_thread_id });
  } catch (e) {
    await sendMessage(env, msg.chat.id, `⚠️ O‘chirib bo‘lmadi: ${escapeHtml(String(e).slice(0,180))}`,
      { message_thread_id:msg.message_thread_id });
  }
  return true;
}

async function addTag(env, msg, t, raw) {
  const tag = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,24);
  if (!tag) {
    const r = await env.DB.prepare('SELECT tag FROM fn17_tags WHERE ticket_no=? ORDER BY tag').bind(t.ticket_no).all();
    await sendMessage(env, msg.chat.id, `🏷 Tags: <code>${escapeHtml((r.results || []).map(x=>x.tag).join(', ') || '—')}</code>`,
      { message_thread_id:msg.message_thread_id });
    return true;
  }
  await env.DB.prepare(`INSERT INTO fn17_tags(ticket_no,tag,added_by) VALUES(?,?,?)
    ON CONFLICT(ticket_no,tag) DO NOTHING`).bind(t.ticket_no, tag, msg.from.id).run();
  await logEvent(env, t.ticket_no, msg.from.id, 'tag', { tag });
  await sendMessage(env, msg.chat.id, `🏷 <code>${tag}</code> qo‘shildi.`, { message_thread_id:msg.message_thread_id });
  return true;
}

async function topicCommands(env, msg, t) {
  const text = String(msg.text || '').trim();
  if (!text.startsWith('/')) return false;
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.replace(/@\w+$/,'').toLowerCase();
  const arg = rest.join(' ').trim();

  if (cmd === '/undo') return undoReply(env, msg, t, false);
  if (cmd === '/deleteboth') return undoReply(env, msg, t, true);
  if (cmd === '/assign') {
    const fakeQ = { id:'', from:msg.from, message:msg };
    const agentsR = await env.DB.prepare(`SELECT a.*,
      (SELECT COUNT(*) FROM fn5_tickets x WHERE x.status='open' AND x.assigned_to=a.operator_id) load
      FROM fn15_agents a
      JOIN fn19_operator_acl acl ON acl.chat_id=a.chat_id AND acl.user_id=a.operator_id AND acl.status='approved'
      WHERE a.chat_id=? AND a.status IN ('online','away')
      ORDER BY CASE a.status WHEN 'online' THEN 0 ELSE 1 END,load ASC,a.operator_name ASC LIMIT 10`)
      .bind(msg.chat.id).all();
    await sendMessage(env, msg.chat.id, '👥 <b>Operator tanlang</b>', {
      message_thread_id:msg.message_thread_id,
      reply_markup:assignmentKeyboard(agentsR.results || [], t.ticket_no)
    });
    return true;
  }
  if (cmd === '/snooze') {
    await sendMessage(env, msg.chat.id, '⏰ <b>Eslatma vaqtini tanlang</b>', {
      message_thread_id:msg.message_thread_id, reply_markup:snoozeKeyboard(t.ticket_no)
    });
    return true;
  }
  if (cmd === '/sla') {
    await sendMessage(env, msg.chat.id, await slaText(env, t.ticket_no), { message_thread_id:msg.message_thread_id });
    return true;
  }
  if (cmd === '/tag') return addTag(env, msg, t, arg);
  if (cmd === '/operatorhelp') {
    await sendMessage(env, msg.chat.id, [
      '🧰 <b>Operator Pro Tools</b>',
      '',
      'Oddiy xabar/media — ticket egasi yozsa mijozga ketadi.',
      'Boshqa operator yozsa — ichki collaboration bo‘lib qoladi.',
      '// izoh — ichki note',
      '/assign — boshqa operatorga biriktirish',
      '/snooze — ticketni keyin eslatish',
      '/sla — SLA holati',
      '/tag outage — teg qo‘shish',
      '/undo — Reply qilingan xabarni mijoz tomondan o‘chirish',
      '/deleteboth — ikki tomondan o‘chirishga urinish',
      '/quick · /ask · /summary — yordamchi panellar',
      '',
      'Reply qilib javob bersangiz mijozda ham quote/reply saqlanadi.'
    ].join('\n'), { message_thread_id:msg.message_thread_id });
    return true;
  }
  return false;
}

async function rootPanel(env, msg) {
  const dep = await getDepartmentByChat(env, msg.chat.id);
  if (!dep?.department) {
    await sendMessage(env, msg.chat.id, '⚠️ Guruh bo‘limga ulanmagan. /setup dan foydalaning.');
    return true;
  }
  const stats = await env.DB.prepare(`SELECT
    COUNT(*) total,
    SUM(CASE WHEN assigned_to IS NULL THEN 1 ELSE 0 END) unassigned,
    SUM(CASE WHEN priority IN ('critical','high') THEN 1 ELSE 0 END) urgent,
    SUM(CASE WHEN stage='waiting_customer' THEN 1 ELSE 0 END) waiting
    FROM fn5_tickets WHERE status='open' AND department=?`).bind(dep.department).first();
  const mine = await env.DB.prepare(`SELECT COUNT(*) n FROM fn5_tickets
    WHERE status='open' AND department=? AND assigned_to=?`).bind(dep.department, msg.from.id).first();
  await sendMessage(env, msg.chat.id, [
    '🎛 <b>FiberNet Operator Panel</b>',
    `🏢 ${escapeHtml(dep.department)}`,
    '',
    `📥 Open: <b>${stats?.total || 0}</b>`,
    `🆕 Unassigned: <b>${stats?.unassigned || 0}</b>`,
    `🚨 Critical/High: <b>${stats?.urgent || 0}</b>`,
    `⏳ Waiting customer: <b>${stats?.waiting || 0}</b>`,
    `👤 Mening ticketlarim: <b>${mine?.n || 0}</b>`,
    '',
    '🔎 Qidirish: <code>/find login|telefon|manzil|ticket</code>'
  ].join('\n'), {
    reply_markup:inlineKeyboard([
      [{ text:'🎯 Keyingi ticketni olish', callback_data:'v17:panel:next' }],
      [{ text:'🟢 Online', callback_data:'v17:panel:online' }, { text:'🟡 Away', callback_data:'v17:panel:away' }],
      [{ text:'📥 Unassigned', callback_data:'v17:panel:unassigned' }, { text:'👤 Mine', callback_data:'v17:panel:mine' }]
    ])
  });
  return true;
}

async function registerAgent(env, chatId, from, status = null) {
  const old = await env.DB.prepare('SELECT * FROM fn15_agents WHERE chat_id=? AND operator_id=?').bind(chatId, from.id).first();
  await env.DB.prepare(`INSERT INTO fn15_agents(chat_id,operator_id,operator_name,username,skills,capacity,status,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,operator_id) DO UPDATE SET operator_name=excluded.operator_name,username=excluded.username,
      status=excluded.status,updated_at=excluded.updated_at`)
    .bind(chatId, from.id, operatorName(from), from.username || null, old?.skills || '[]', old?.capacity || 5,
      status || old?.status || 'online', now()).run();
}

async function panelCallback(env, q, action) {
  const dep = await getDepartmentByChat(env, q.message.chat.id);
  if (!dep?.department) { await answerCallback(env, q.id, 'Guruh bo‘limga ulanmagan'); return true; }
  if (action === 'online' || action === 'away') {
    await registerAgent(env, q.message.chat.id, q.from, action === 'online' ? 'online' : 'away');
    await answerCallback(env, q.id, action === 'online' ? 'Online' : 'Away');
    return true;
  }
  if (action === 'unassigned' || action === 'mine') {
    const where = action === 'unassigned' ? 'assigned_to IS NULL' : 'assigned_to=?';
    const sql = `SELECT ticket_no,priority,category,created_at FROM fn5_tickets
      WHERE status='open' AND department=? AND ${where}
      ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,id ASC LIMIT 12`;
    const r = action === 'unassigned'
      ? await env.DB.prepare(sql).bind(dep.department).all()
      : await env.DB.prepare(sql).bind(dep.department,q.from.id).all();
    await answerCallback(env, q.id);
    await sendMessage(env, q.message.chat.id,
      `📋 <b>${action === 'unassigned' ? 'Unassigned' : 'Mening ticketlarim'}</b>\n\n${(r.results || []).map(x=>`${x.priority==='critical'?'🚨':x.priority==='high'?'🔴':'🟡'} <code>${x.ticket_no}</code> · ${escapeHtml(x.category)}`).join('\n') || '—'}`);
    return true;
  }
  if (action === 'next') {
    await registerAgent(env, q.message.chat.id, q.from, 'online');
    const a = await env.DB.prepare('SELECT * FROM fn15_agents WHERE chat_id=? AND operator_id=?').bind(q.message.chat.id,q.from.id).first();
    const load = await env.DB.prepare("SELECT COUNT(*) n FROM fn5_tickets WHERE status='open' AND assigned_to=?").bind(q.from.id).first();
    if (Number(load?.n || 0) >= Number(a?.capacity || 5)) {
      await answerCallback(env, q.id, `Capacity ${load?.n || 0}/${a?.capacity || 5}`);
      return true;
    }
    const t = await env.DB.prepare(`SELECT * FROM fn5_tickets WHERE status='open' AND department=? AND assigned_to IS NULL
      ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,id ASC LIMIT 1`)
      .bind(dep.department).first();
    if (!t) { await answerCallback(env,q.id,'Navbat bo‘sh'); return true; }
    const ok = await atomicClaim(env,t,q.from);
    if (!ok) { await answerCallback(env,q.id,'Boshqa operator oldi'); return true; }
    const topic = await ensureTopicForTicket(env,t.ticket_no);
    await customerAssignedNotice(env,t,q.from.id,operatorName(q.from));
    await answerCallback(env,q.id,'Ticket olindi');
    await sendMessage(env,q.message.chat.id,
      `✅ <b>${escapeHtml(t.ticket_no)}</b> sizga biriktirildi.`,
      topic?.thread_id ? { message_thread_id:topic.thread_id } : {});
    return true;
  }
  return false;
}

async function findTickets(env, msg, query) {
  const q = String(query || '').trim();
  if (q.length < 2) {
    await sendMessage(env,msg.chat.id,'🔎 Format: <code>/find 29374</code> yoki <code>/find Aviasozlar</code>');
    return true;
  }
  const dep = await getDepartmentByChat(env,msg.chat.id);
  const like = `%${q}%`;
  const r = await env.DB.prepare(`SELECT t.ticket_no,t.priority,t.stage,t.department,t.category,t.assigned_name,
      u.username,u.first_name,u.last_name,t.account_login,t.address,t.phone
    FROM fn5_tickets t LEFT JOIN fn5_users u ON u.telegram_id=t.telegram_id
    WHERE t.status='open'
      AND (? IS NULL OR t.department=?)
      AND (
        t.ticket_no LIKE ? OR COALESCE(t.account_login,'') LIKE ? OR COALESCE(t.address,'') LIKE ? OR
        COALESCE(t.phone,'') LIKE ? OR COALESCE(u.username,'') LIKE ? OR COALESCE(u.first_name,'') LIKE ? OR
        COALESCE(u.last_name,'') LIKE ?
      )
    ORDER BY t.id DESC LIMIT 10`)
    .bind(dep?.department || null,dep?.department || null,like,like,like,like,like,like,like).all();
  await sendMessage(env,msg.chat.id,[
    `🔎 <b>Qidiruv:</b> ${escapeHtml(q)}`,
    '',
    ...(r.results || []).map(x =>
      `${x.priority==='critical'?'🚨':x.priority==='high'?'🔴':'🟡'} <code>${x.ticket_no}</code> · ${escapeHtml(x.category)}\n👤 ${escapeHtml(x.username?'@'+x.username:[x.first_name,x.last_name].filter(Boolean).join(' ')||'—')} · 🔐 ${escapeHtml(x.account_login||'—')}\n👨‍💻 ${escapeHtml(x.assigned_name||'unassigned')}`
    ),
    ...(r.results?.length ? [] : ['—'])
  ].join('\n\n'));
  return true;
}

async function groupCommands(env,msg) {
  if (!msg.text) return false;
  const text=msg.text.trim();
  if (/^\/panel(?:@\w+)?$/i.test(text)) return rootPanel(env,msg);
  const f=text.match(/^\/find(?:@\w+)?(?:\s+(.+))?$/i);
  if (f) return findTickets(env,msg,f[1]||'');
  return false;
}

async function handleCallback(env,q) {
  if (!isGroup(q.message?.chat)) return false;
  const data=String(q.data||'');
  if (!data.startsWith('v17:')) return false;
  const p=data.split(':');
  const action=p[1];

  if (action==='assignmenu') return showAssignMenu(env,q,p[2]);
  if (action==='assign') return assignToAgent(env,q,p[2],p[3]);
  if (action==='unassign') return unassign(env,q,p[2]);
  if (action==='prioritymenu') {
    await answerCallback(env,q.id,'Priority');
    await sendMessage(env,q.message.chat.id,'🚦 <b>Priority tanlang</b>',{
      ...(q.message.message_thread_id?{message_thread_id:q.message.message_thread_id}:{}),
      reply_markup:priorityKeyboard(p[2])
    });
    return true;
  }
  if (action==='priority') {
    const no=p[2],level=p[3];
    if (!['critical','high','normal','low'].includes(level)) return true;
    const t=await getTicket(env,no);
    if (t?.assigned_to && String(t.assigned_to)!==String(q.from.id) && !isAdmin(env,q.from.id)) {
      await answerCallback(env,q.id,'Ticket egasi yoki admin'); return true;
    }
    await env.DB.prepare("UPDATE fn5_tickets SET priority=?,updated_at=? WHERE ticket_no=? AND status='open'")
      .bind(level,now(),no).run();
    await logEvent(env,no,q.from.id,'priority',{level});
    await answerCallback(env,q.id,`Priority: ${level}`);
    return true;
  }
  if (action==='snoozemenu') {
    await answerCallback(env,q.id,'Snooze');
    await sendMessage(env,q.message.chat.id,'⏰ <b>Qachon eslatay?</b>',{
      ...(q.message.message_thread_id?{message_thread_id:q.message.message_thread_id}:{}),
      reply_markup:snoozeKeyboard(p[2])
    });
    return true;
  }
  if (action==='snooze') {
    const no=p[2],mins=Math.max(5,Math.min(10080,Number(p[3])||60));
    const t=await getTicket(env,no);
    if (t?.assigned_to && String(t.assigned_to)!==String(q.from.id) && !isAdmin(env,q.from.id)) {
      await answerCallback(env,q.id,'Ticket egasi yoki admin'); return true;
    }
    const wake=new Date(Date.now()+mins*60000).toISOString();
    await env.DB.prepare(`INSERT INTO fn17_snoozes(ticket_no,chat_id,thread_id,wake_at,created_by,created_by_name)
      VALUES(?,?,?,?,?,?) ON CONFLICT(ticket_no) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,
      wake_at=excluded.wake_at,created_by=excluded.created_by,created_by_name=excluded.created_by_name,created_at=CURRENT_TIMESTAMP`)
      .bind(no,q.message.chat.id,q.message.message_thread_id||null,wake,q.from.id,operatorName(q.from)).run();
    await logEvent(env,no,q.from.id,'snooze',{minutes:mins});
    await answerCallback(env,q.id,`${mins} min`);
    await sendMessage(env,q.message.chat.id,`⏰ ${mins} daqiqadan keyin bot eslatadi.`,
      q.message.message_thread_id?{message_thread_id:q.message.message_thread_id}:{});
    return true;
  }
  if (action==='sla') {
    await answerCallback(env,q.id);
    await sendMessage(env,q.message.chat.id,await slaText(env,p[2]),
      q.message.message_thread_id?{message_thread_id:q.message.message_thread_id}:{});
    return true;
  }
  if (action==='draftsend') return sendDraft(env,q,p[2]);
  if (action==='handoff') return requestHandoff(env,q,p[2]);
  if (action==='panel') return panelCallback(env,q,p[2]);
  return false;
}

async function dueSnoozes(env) {
  const r=await env.DB.prepare(`SELECT * FROM fn17_snoozes WHERE datetime(wake_at)<=datetime('now') ORDER BY wake_at ASC LIMIT 30`).all();
  for (const s of r.results||[]) {
    const t=await getTicket(env,s.ticket_no);
    if (!t || t.status!=='open') {
      await env.DB.prepare('DELETE FROM fn17_snoozes WHERE ticket_no=?').bind(s.ticket_no).run();
      continue;
    }
    try {
      await sendMessage(env,s.chat_id,[
        '⏰ <b>Snooze tugadi</b>',
        `🎫 <code>${escapeHtml(s.ticket_no)}</code>`,
        s.created_by_name?`👨‍💻 ${escapeHtml(s.created_by_name)}`:null,
        'Ticketni qayta ko‘rib chiqish vaqti.'
      ].filter(Boolean).join('\n'),s.thread_id?{
        message_thread_id:s.thread_id,
        reply_markup:inlineKeyboard([
          [{text:'📋 Context',callback_data:`v16:summary:${s.ticket_no}`},
           {text:'⏰ Yana snooze',callback_data:`v17:snoozemenu:${s.ticket_no}`}],
          [{text:'✅ Hal qilindi',callback_data:`op:resolve:${s.ticket_no}`}]
        ])
      }:{});
    } catch {}
    await env.DB.prepare('DELETE FROM fn17_snoozes WHERE ticket_no=?').bind(s.ticket_no).run();
    await logEvent(env,s.ticket_no,null,'snooze_wakeup');
  }
}

async function retryOutbox(env) {
  const r=await env.DB.prepare(`SELECT * FROM fn17_outbox WHERE datetime(next_try_at)<=datetime('now')
    ORDER BY id ASC LIMIT 30`).all();
  for (const x of r.results||[]) {
    try {
      const copied=await tg(env,'copyMessage',{
        chat_id:x.target_chat_id,from_chat_id:x.source_chat_id,message_id:x.source_message_id,
        ...(x.target_thread_id?{message_thread_id:x.target_thread_id}:{}),
        ...(x.reply_to_target_message_id?{reply_parameters:{message_id:x.reply_to_target_message_id,allow_sending_without_reply:true}}:{}),
        ...(x.direction==='operator_to_user'?{reply_markup:customerReplyKeyboard(x.ticket_no)}:{})
      });
      if (copied?.message_id) await saveMirror(env,x.source_chat_id,x.source_message_id,x.target_chat_id,copied.message_id,x.ticket_no,x.direction);
      await env.DB.prepare('DELETE FROM fn17_outbox WHERE id=?').bind(x.id).run();
      await logEvent(env,x.ticket_no,null,'retry_delivered',{attempts:x.attempts,direction:x.direction});
    } catch(e) {
      await env.DB.prepare(`UPDATE fn17_outbox SET attempts=attempts+1,last_error=?,
        next_try_at=datetime('now',CASE WHEN attempts<2 THEN '+1 minute' WHEN attempts<5 THEN '+5 minutes' ELSE '+20 minutes' END),
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(String(e).slice(0,500),x.id).run();
    }
  }
}

export async function handleV17Update(env,update) {
  await ensureV17Schema(env);

  const q=update?.callback_query;
  if (q?.message?.chat && await handleCallback(env,q)) return true;

  const msg=update?.message;
  if (!msg || msg.from?.is_bot) return false;

  if (isGroup(msg.chat)) {
    if (await groupCommands(env,msg)) return true;
    if (!msg.message_thread_id) return false;
    const t=await topicTicket(env,msg);
    if (!t) return false;

    if (msg.text?.startsWith('//')) return false;
    if (msg.text?.startsWith('/')) {
      if (!await claimUpdate(env,update.update_id)) return true;
      if (await topicCommands(env,msg,t)) return true;
      return false;
    }

    if (!relayKind(msg)) return false;
    if (!await claimUpdate(env,update.update_id)) return true;
    return operatorRelay(env,msg,t);
  }

  if (isPrivate(msg.chat)) {
    const text=String(msg.text||'').trim();
    if (text.startsWith('/')) return false;
    const t=await activeUserTicket(env,msg.from.id);
    if (!t) return false;
    const topic=await ensureTopicForTicket(env,t.ticket_no);
    if (!topic?.thread_id || topic.state!=='open') return false;
    if (!relayKind(msg)) return false;
    if (!await claimUpdate(env,update.update_id)) return true;
    return userRelay(env,msg,t,topic);
  }
  return false;
}

export async function runV17Maintenance(env) {
  await ensureV17Schema(env);
  await Promise.all([retryOutbox(env),dueSnoozes(env)]);
  await env.DB.prepare("DELETE FROM fn17_processed WHERE created_at < datetime('now','-7 day')").run();
  await env.DB.prepare("DELETE FROM fn17_drafts WHERE state='sent' AND sent_at < datetime('now','-30 day')").run();
}

export async function v17Health(env) {
  await ensureV17Schema(env);
  const [outbox,snooze,drafts]=await Promise.all([
    env.DB.prepare('SELECT COUNT(*) n FROM fn17_outbox').first(),
    env.DB.prepare('SELECT COUNT(*) n FROM fn17_snoozes').first(),
    env.DB.prepare("SELECT COUNT(*) n FROM fn17_drafts WHERE state='internal'").first()
  ]);
  return {
    mode:'reply-aware-operator-workspace-collaboration-assignment-snooze-search-undo',
    pending_delivery:outbox?.n||0,
    snoozed_tickets:snooze?.n||0,
    internal_drafts:drafts?.n||0
  };
}

export const __test={
  relayKind,
  priorityKeyboard,
  snoozeKeyboard,
  explicitReplyTicketNo
};
