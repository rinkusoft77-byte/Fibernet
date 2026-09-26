import {
  addMessage, getSession, getTicket, getUser, setStage
} from './v5-db.js';
import { ensureTopicForTicket } from './v15-helpdesk.js';
import { L } from './v8-ui.js';
import { answerCallback, escapeHtml, sendMessage, tg } from './telegram.js';

const now = () => new Date().toISOString();
let ready = false;

function isPrivate(chat) { return chat?.type === 'private'; }
function textOf(msg) { return String(msg?.text || msg?.caption || '').trim(); }

export async function ensureV21Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn21_conversations (
      ticket_no TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting_operator',
      support_chat_id INTEGER,
      thread_id INTEGER,
      activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      first_operator_reply_at TEXT,
      last_user_at TEXT,
      last_operator_at TEXT,
      wait_reminder_at TEXT,
      paused_at TEXT,
      closed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn21_user_state
      ON fn21_conversations(telegram_id,state,updated_at)`,
    `CREATE TABLE IF NOT EXISTS fn21_processed (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn21_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      ticket_no TEXT NOT NULL,
      source_chat_id INTEGER NOT NULL,
      source_message_id INTEGER NOT NULL,
      target_chat_id INTEGER,
      target_thread_id INTEGER,
      reply_to_target_message_id INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn21_outbox_due ON fn21_outbox(next_try_at)`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

async function claimUpdate(env, id) {
  if (!Number.isInteger(id)) return true;
  await ensureV21Schema(env);
  try {
    await env.DB.prepare('INSERT INTO fn21_processed(update_id) VALUES(?)').bind(id).run();
    return true;
  } catch (e) {
    const s = String(e).toLowerCase();
    if (s.includes('unique') || s.includes('constraint')) return false;
    throw e;
  }
}

async function conversationByUser(env, telegramId) {
  await ensureV21Schema(env);
  return env.DB.prepare(`SELECT * FROM fn21_conversations
    WHERE telegram_id=? AND state IN ('waiting_operator','active','engaged')
    ORDER BY updated_at DESC LIMIT 1`).bind(telegramId).first();
}

async function conversationByTicket(env, ticketNo) {
  await ensureV21Schema(env);
  return env.DB.prepare('SELECT * FROM fn21_conversations WHERE ticket_no=?').bind(ticketNo).first();
}

async function saveMirror(env, sourceChatId, sourceMessageId, targetChatId, targetMessageId, ticketNo) {
  try {
    await env.DB.prepare(`INSERT INTO fn15_mirrors(
      source_chat_id,source_message_id,target_chat_id,target_message_id,ticket_no,direction
    ) VALUES(?,?,?,?,?,'user_to_operator')
    ON CONFLICT(source_chat_id,source_message_id,target_chat_id)
    DO UPDATE SET target_message_id=excluded.target_message_id,ticket_no=excluded.ticket_no,direction='user_to_operator'`)
      .bind(sourceChatId, sourceMessageId, targetChatId, targetMessageId, ticketNo).run();
  } catch {}
}

async function replyTarget(env, msg, topic) {
  const replied = msg.reply_to_message?.message_id;
  if (!replied) return null;
  try {
    const row = await env.DB.prepare(`SELECT source_message_id FROM fn15_mirrors
      WHERE target_chat_id=? AND target_message_id=? AND source_chat_id=?
      ORDER BY created_at DESC LIMIT 1`)
      .bind(msg.chat.id, replied, topic.chat_id).first();
    return row?.source_message_id || null;
  } catch {
    return null;
  }
}

function looksLikeClosedTopicError(error) {
  const s = String(error || '').toLowerCase();
  return s.includes('topic_closed') || s.includes('topic closed') || s.includes('message thread is closed');
}

function looksLikeMissingTopicError(error) {
  const s = String(error || '').toLowerCase();
  return s.includes('message thread not found') ||
    s.includes('topic_deleted') ||
    s.includes('topic deleted') ||
    s.includes('thread not found') ||
    s.includes('message_thread_invalid');
}

async function resetTopic(env, ticketNo) {
  try { await env.DB.prepare('DELETE FROM fn15_topics WHERE ticket_no=?').bind(ticketNo).run(); } catch {}
  return ensureTopicForTicket(env, ticketNo);
}

async function topicForDelivery(env, ticketNo) {
  let topic = await ensureTopicForTicket(env, ticketNo);
  if (!topic?.thread_id) return null;
  if (topic.state === 'closed') {
    try {
      await tg(env, 'reopenForumTopic', { chat_id:topic.chat_id, message_thread_id:topic.thread_id });
      await env.DB.prepare("UPDATE fn15_topics SET state='open',updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?")
        .bind(ticketNo).run();
      topic = { ...topic, state:'open' };
    } catch {
      topic = await resetTopic(env, ticketNo);
    }
  }
  return topic;
}

async function queueMessage(env, ticketNo, msg, topic, replyTo, error) {
  await ensureV21Schema(env);
  const key = `u2o:${msg.chat.id}:${msg.message_id}:${ticketNo}`;
  await env.DB.prepare(`INSERT INTO fn21_outbox(
    dedupe_key,ticket_no,source_chat_id,source_message_id,target_chat_id,target_thread_id,
    reply_to_target_message_id,last_error,next_try_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT(dedupe_key) DO UPDATE SET
    target_chat_id=excluded.target_chat_id,target_thread_id=excluded.target_thread_id,
    reply_to_target_message_id=excluded.reply_to_target_message_id,last_error=excluded.last_error,
    next_try_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`)
    .bind(key,ticketNo,msg.chat.id,msg.message_id,topic?.chat_id || null,topic?.thread_id || null,
      replyTo || null,String(error || '').slice(0,500)).run();
}

async function copyToTopic(env, msg, t, topic, replyTo) {
  const payload = {
    chat_id:topic.chat_id,
    from_chat_id:msg.chat.id,
    message_id:msg.message_id,
    message_thread_id:topic.thread_id,
    ...(replyTo ? { reply_parameters:{ message_id:replyTo, allow_sending_without_reply:true } } : {})
  };
  try {
    return await tg(env,'copyMessage',payload);
  } catch (e) {
    if (looksLikeClosedTopicError(e)) {
      try {
        await tg(env,'reopenForumTopic',{ chat_id:topic.chat_id,message_thread_id:topic.thread_id });
        await env.DB.prepare("UPDATE fn15_topics SET state='open',updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?")
          .bind(t.ticket_no).run();
        return await tg(env,'copyMessage',payload);
      } catch (retryError) {
        e = retryError;
      }
    }
    if (looksLikeMissingTopicError(e)) {
      const recreated = await resetTopic(env,t.ticket_no);
      if (recreated?.thread_id) {
        const retryPayload = {
          ...payload,
          chat_id:recreated.chat_id,
          message_thread_id:recreated.thread_id
        };
        return await tg(env,'copyMessage',retryPayload);
      }
    }
    throw e;
  }
}

export async function activateSupportConversation(env, ticketNo, state = 'waiting_operator') {
  await ensureV21Schema(env);
  const t = await getTicket(env,ticketNo);
  if (!t || t.status !== 'open') return null;
  const topic = await topicForDelivery(env,ticketNo);
  // A customer can actively chat in only one ticket at a time. Older open
  // tickets stay open, but their live-chat routing is paused until explicitly resumed.
  await env.DB.prepare(`UPDATE fn21_conversations SET state='paused',paused_at=?,updated_at=?
    WHERE telegram_id=? AND ticket_no!=? AND state IN ('waiting_operator','active','engaged')`)
    .bind(now(),now(),t.telegram_id,ticketNo).run();
  await env.DB.prepare(`INSERT INTO fn21_conversations(
    ticket_no,telegram_id,state,support_chat_id,thread_id,activated_at,updated_at,closed_at,paused_at
  ) VALUES(?,?,?,?,?,?,?,NULL,NULL)
  ON CONFLICT(ticket_no) DO UPDATE SET
    telegram_id=excluded.telegram_id,state=excluded.state,
    support_chat_id=COALESCE(excluded.support_chat_id,fn21_conversations.support_chat_id),
    thread_id=COALESCE(excluded.thread_id,fn21_conversations.thread_id),
    paused_at=NULL,closed_at=NULL,updated_at=excluded.updated_at`)
    .bind(ticketNo,t.telegram_id,state,topic?.chat_id || null,topic?.thread_id || null,now(),now()).run();
  return { ticket:t, topic };
}

export async function markOperatorActivity(env, ticketNo) {
  try {
    await ensureV21Schema(env);
    await env.DB.prepare(`UPDATE fn21_conversations SET state='engaged',
      first_operator_reply_at=COALESCE(first_operator_reply_at,?),
      last_operator_at=?,updated_at=? WHERE ticket_no=?`)
      .bind(now(),now(),now(),ticketNo).run();
  } catch {}
}

async function pauseConversation(env, telegramId) {
  await ensureV21Schema(env);
  await env.DB.prepare(`UPDATE fn21_conversations SET state='paused',paused_at=?,updated_at=?
    WHERE telegram_id=? AND state IN ('waiting_operator','active','engaged')`)
    .bind(now(),now(),telegramId).run();
}

async function resumeCallback(env,q,ticketNo) {
  const t=await getTicket(env,ticketNo);
  if(!t || t.status!=='open' || String(t.telegram_id)!==String(q.from.id)) {
    await answerCallback(env,q.id,'Murojaat yopilgan');
    return true;
  }
  await activateSupportConversation(env,ticketNo,t.assigned_to ? 'engaged' : 'waiting_operator');
  if (t.stage === 'resolved') {
    await setStage(env,ticketNo,'in_progress');
  }
  await answerCallback(env,q.id,'Suhbat ochildi');
  const u=await getUser(env,q.from.id);
  await sendMessage(env,q.message.chat.id,L(u?.language || 'uz',
    `💬 <b>Operator bilan suhbat ochildi</b>\n🎫 <code>${escapeHtml(ticketNo)}</code>\n\nEndi shu chatga yozgan text, rasm, video, voice, sticker va fayllaringiz faqat shu murojaatning operator Topic’iga boradi.`,
    `💬 <b>Диалог с оператором открыт</b>\n🎫 <code>${escapeHtml(ticketNo)}</code>\n\nТеперь текст, фото, видео, голосовые, стикеры и файлы из этого чата попадут только в Topic этого обращения.`));
  return true;
}

async function relayPrivateMessage(env,msg,conv) {
  const s=await getSession(env,msg.from.id);
  // If another bot form is active (profile/login/address/etc), that form owns
  // the next message. Never leak form data into the operator topic.
  if (s && s.state !== 'ticket_reply') return false;

  const t=await getTicket(env,conv.ticket_no);
  if(!t || t.status!=='open' || String(t.telegram_id)!==String(msg.from.id)) {
    await env.DB.prepare("UPDATE fn21_conversations SET state='closed',closed_at=?,updated_at=? WHERE ticket_no=?")
      .bind(now(),now(),conv.ticket_no).run();
    return false;
  }

  if(t.stage==='resolved') await setStage(env,t.ticket_no,'in_progress');

  const topic=await topicForDelivery(env,t.ticket_no);
  if(!topic?.thread_id) {
    await queueMessage(env,t.ticket_no,msg,null,null,'forum_topic_unavailable');
    const u=await getUser(env,msg.from.id);
    await sendMessage(env,msg.chat.id,L(u?.language||'uz',
      '⏳ Xabaringiz saqlandi. Operator Topic’i tiklanishi bilan avtomatik yetkaziladi.',
      '⏳ Сообщение сохранено. Оно будет доставлено после восстановления Topic оператора.'));
    return true;
  }

  const replyTo=await replyTarget(env,msg,topic);
  try {
    const copied=await copyToTopic(env,msg,t,topic,replyTo);
    if(copied?.message_id) await saveMirror(env,msg.chat.id,msg.message_id,topic.chat_id,copied.message_id,t.ticket_no);
    await addMessage(env,t.ticket_no,'user',msg.from.id,textOf(msg) || '[media]',msg.message_id);
    await setStage(env,t.ticket_no,'in_progress');
    await env.DB.prepare(`UPDATE fn21_conversations SET state=?,
      support_chat_id=?,thread_id=?,last_user_at=?,updated_at=?
      WHERE ticket_no=?`).bind(
        t.assigned_to ? 'engaged' : 'waiting_operator',
        topic.chat_id,topic.thread_id,now(),now(),t.ticket_no
      ).run();
    try {
      await tg(env,'setMessageReaction',{
        chat_id:msg.chat.id,message_id:msg.message_id,
        reaction:[{type:'emoji',emoji:'👍'}]
      });
    } catch {}
    if(copied?.message_id){
      try {
        await tg(env,'setMessageReaction',{
          chat_id:topic.chat_id,message_id:copied.message_id,
          reaction:[{type:'emoji',emoji:'👀'}]
        });
      } catch {}
    }
    return true;
  } catch(e) {
    await queueMessage(env,t.ticket_no,msg,topic,replyTo,e);
    const u=await getUser(env,msg.from.id);
    await sendMessage(env,msg.chat.id,L(u?.language||'uz',
      '⏳ Xabaringiz saqlandi. Yetkazish avtomatik qayta urinadi.',
      '⏳ Сообщение сохранено. Доставка будет повторена автоматически.'));
    return true;
  }
}

async function retryOutbox(env) {
  await ensureV21Schema(env);
  const r=await env.DB.prepare(`SELECT * FROM fn21_outbox
    WHERE datetime(next_try_at)<=datetime('now') ORDER BY id ASC LIMIT 30`).all();
  for(const x of r.results || []){
    const t=await getTicket(env,x.ticket_no);
    if(!t || t.status!=='open'){
      await env.DB.prepare('DELETE FROM fn21_outbox WHERE id=?').bind(x.id).run();
      continue;
    }
    try{
      const topic=await topicForDelivery(env,x.ticket_no);
      if(!topic?.thread_id) throw new Error('forum_topic_unavailable');
      const copied=await tg(env,'copyMessage',{
        chat_id:topic.chat_id,
        from_chat_id:x.source_chat_id,
        message_id:x.source_message_id,
        message_thread_id:topic.thread_id,
        ...(x.reply_to_target_message_id ? {
          reply_parameters:{message_id:x.reply_to_target_message_id,allow_sending_without_reply:true}
        } : {})
      });
      if(copied?.message_id) await saveMirror(env,x.source_chat_id,x.source_message_id,topic.chat_id,copied.message_id,x.ticket_no);
      await env.DB.prepare('DELETE FROM fn21_outbox WHERE id=?').bind(x.id).run();
    }catch(e){
      await env.DB.prepare(`UPDATE fn21_outbox SET attempts=attempts+1,last_error=?,
        next_try_at=datetime('now',CASE WHEN attempts<2 THEN '+1 minute' WHEN attempts<5 THEN '+5 minutes' ELSE '+15 minutes' END),
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(String(e).slice(0,500),x.id).run();
    }
  }
}

async function waitingReminders(env) {
  await ensureV21Schema(env);
  const r=await env.DB.prepare(`SELECT c.*,t.assigned_to,t.status,t.stage
    FROM fn21_conversations c JOIN fn5_tickets t ON t.ticket_no=c.ticket_no
    WHERE c.state='waiting_operator' AND t.status='open' AND t.assigned_to IS NULL
      AND c.wait_reminder_at IS NULL
      AND datetime(c.activated_at)<=datetime('now','-12 minutes')
    LIMIT 30`).all();
  for(const c of r.results || []){
    const topic=await topicForDelivery(env,c.ticket_no);
    if(!topic?.thread_id) continue;
    try{
      await sendMessage(env,topic.chat_id,
        `⏰ <b>Mijoz kutmoqda</b> · <code>${escapeHtml(c.ticket_no)}</code>\n12+ daqiqa bo‘ldi. Birinchi bo‘sh operator ticketni qabul qilsin.`,
        {message_thread_id:topic.thread_id});
      await env.DB.prepare('UPDATE fn21_conversations SET wait_reminder_at=?,updated_at=? WHERE ticket_no=?')
        .bind(now(),now(),c.ticket_no).run();
    }catch{}
  }
}

async function syncConversationStates(env) {
  await ensureV21Schema(env);
  await env.DB.prepare(`UPDATE fn21_conversations SET state='closed',closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE ticket_no IN (SELECT ticket_no FROM fn5_tickets WHERE status='closed')
      AND state!='closed'`).run();
}

export async function handleV21Update(env,update){
  await ensureV21Schema(env);
  const q=update?.callback_query;
  if(q?.message?.chat && isPrivate(q.message.chat)){
    const data=String(q.data||'');
    if(data.startsWith('ticket:reply:')){
      if(!await claimUpdate(env,update.update_id)) return true;
      return resumeCallback(env,q,data.slice('ticket:reply:'.length));
    }
    // Any normal menu/button navigation pauses live operator routing. This
    // prevents profile/tariff/menu actions from being interpreted as support chat.
    const active=await conversationByUser(env,q.from.id);
    if(active) await pauseConversation(env,q.from.id);
  }

  const msg=update?.message;
  if(!msg || msg.from?.is_bot || !isPrivate(msg.chat)) return false;
  const text=String(msg.text||msg.caption||'').trim();

  if(/^\/(start|menu)(?:@\w+)?(?:\s|$)/i.test(text)){
    await pauseConversation(env,msg.from.id);
    return false;
  }
  if(text.startsWith('/')) return false;

  const conv=await conversationByUser(env,msg.from.id);
  if(!conv) return false;
  if(!await claimUpdate(env,update.update_id)) return true;
  return relayPrivateMessage(env,msg,conv);
}

export async function runV21Maintenance(env){
  await Promise.all([
    retryOutbox(env),
    waitingReminders(env),
    syncConversationStates(env)
  ]);
  await env.DB.prepare("DELETE FROM fn21_processed WHERE created_at < datetime('now','-7 day')").run();
}

export async function v21Health(env){
  await ensureV21Schema(env);
  const [active,waiting,outbox]=await Promise.all([
    env.DB.prepare("SELECT COUNT(*) n FROM fn21_conversations WHERE state IN ('active','engaged')").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM fn21_conversations WHERE state='waiting_operator'").first(),
    env.DB.prepare('SELECT COUNT(*) n FROM fn21_outbox').first()
  ]);
  return {
    mode:'persistent-ticket-topic-chat-no-main-group-routing',
    active_chats:Number(active?.n||0),
    waiting_operator:Number(waiting?.n||0),
    pending_messages:Number(outbox?.n||0),
    advertised_wait:'5-15 minutes'
  };
}

export const __test={
  looksLikeClosedTopicError,
  looksLikeMissingTopicError
};
