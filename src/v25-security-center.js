import {
  answerCallback, escapeHtml, inlineKeyboard, sendMessage
} from './telegram.js';

const VERSION = '25.0.0';
let ready = false;

function adminIds(env) {
  return new Set(String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String));
}
export function isSecurityAdmin(env, id) {
  return adminIds(env).has(String(id));
}

function actorOf(update) {
  const q = update?.callback_query;
  const m = update?.message || update?.edited_message;
  const cm = update?.my_chat_member;
  const from = q?.from || m?.from || cm?.from;
  const chat = q?.message?.chat || m?.chat || cm?.chat;
  if (!from?.id || from?.is_bot) return null;
  return {
    id: Number(from.id),
    chatId: chat?.id ?? null,
    chatType: chat?.type || null
  };
}

export async function ensureV25Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn25_blocks (
      telegram_id INTEGER PRIMARY KEY,
      reason TEXT,
      blocked_by INTEGER,
      blocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn25_blocks_active
      ON fn25_blocks(active,expires_at)`,
    `CREATE TABLE IF NOT EXISTS fn25_quarantine (
      telegram_id INTEGER PRIMARY KEY,
      strikes INTEGER NOT NULL DEFAULT 1,
      reason TEXT,
      blocked_until TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn25_quarantine_until
      ON fn25_quarantine(blocked_until)`,
    `CREATE TABLE IF NOT EXISTS fn25_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      severity TEXT NOT NULL DEFAULT 'info',
      event_type TEXT NOT NULL,
      telegram_id INTEGER,
      chat_id INTEGER,
      update_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn25_events_created
      ON fn25_events(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_fn25_events_actor
      ON fn25_events(telegram_id,created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS fn25_admin_sessions (
      admin_id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      payload TEXT,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

async function logEvent(env, type, {
  severity='info', telegramId=null, chatId=null, updateId=null, details=null
} = {}) {
  await ensureV25Schema(env);
  await env.DB.prepare(`INSERT INTO fn25_events(
    severity,event_type,telegram_id,chat_id,update_id,details
  ) VALUES(?,?,?,?,?,?)`).bind(
    severity, type, telegramId, chatId, updateId,
    details == null ? null : String(details).slice(0,1200)
  ).run();
}

export async function preflightSecurity(env, update) {
  await ensureV25Schema(env);
  const actor = actorOf(update);
  if (!actor || isSecurityAdmin(env, actor.id)) return { blocked:false };

  const manual = await env.DB.prepare(`SELECT reason,expires_at FROM fn25_blocks
    WHERE telegram_id=? AND active=1
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
    LIMIT 1`).bind(actor.id).first();
  if (manual) {
    return { blocked:true, reason:'manual_block' };
  }

  const quarantine = await env.DB.prepare(`SELECT blocked_until,reason,strikes
    FROM fn25_quarantine WHERE telegram_id=?
      AND datetime(blocked_until)>datetime('now')`).bind(actor.id).first();
  if (quarantine) {
    return { blocked:true, reason:'quarantine' };
  }

  return { blocked:false };
}

export async function recordFlood(env, update, hits = null) {
  await ensureV25Schema(env);
  const actor = actorOf(update);
  if (!actor || isSecurityAdmin(env, actor.id)) return;

  const previous = await env.DB.prepare(
    'SELECT strikes,updated_at FROM fn25_quarantine WHERE telegram_id=?'
  ).bind(actor.id).first();
  const recent = previous?.updated_at &&
    (Date.now() - new Date(previous.updated_at).getTime()) < 24 * 60 * 60 * 1000;
  const strikes = recent ? Math.min(6, Number(previous?.strikes || 0) + 1) : 1;
  const seconds = strikes >= 4 ? 1800 : strikes === 3 ? 600 : strikes === 2 ? 180 : 60;
  const modifier = `+${seconds} seconds`;

  await env.DB.prepare(`INSERT INTO fn25_quarantine(
      telegram_id,strikes,reason,blocked_until,updated_at
    ) VALUES(?,?,'flood',datetime('now',?),CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      strikes=excluded.strikes,reason='flood',blocked_until=excluded.blocked_until,
      updated_at=CURRENT_TIMESTAMP`).bind(actor.id,strikes,modifier).run();

  await logEvent(env,'flood_quarantine',{
    severity:strikes >= 3 ? 'high' : 'warning',
    telegramId:actor.id,chatId:actor.chatId,updateId:update?.update_id,
    details:`hits=${hits ?? 'unknown'} strikes=${strikes} seconds=${seconds}`
  });
}

export async function blockUser(env, telegramId, adminId, ttl = 'permanent', reason = 'manual_admin') {
  await ensureV25Schema(env);
  if (!/^\d+$/.test(String(telegramId))) throw new Error('invalid_user_id');
  const modifiers = {
    '1h': '+1 hour',
    '24h': '+1 day',
    '7d': '+7 days',
    '30d': '+30 days'
  };
  const expires = ttl === 'permanent' ? null : modifiers[ttl];
  if (ttl !== 'permanent' && !expires) throw new Error('invalid_ttl');

  if (expires) {
    await env.DB.prepare(`INSERT INTO fn25_blocks(
      telegram_id,reason,blocked_by,blocked_at,expires_at,active,updated_at
    ) VALUES(?,?,?,CURRENT_TIMESTAMP,datetime('now',?),1,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      reason=excluded.reason,blocked_by=excluded.blocked_by,blocked_at=CURRENT_TIMESTAMP,
      expires_at=excluded.expires_at,active=1,updated_at=CURRENT_TIMESTAMP`)
      .bind(telegramId,reason,adminId,expires).run();
  } else {
    await env.DB.prepare(`INSERT INTO fn25_blocks(
      telegram_id,reason,blocked_by,blocked_at,expires_at,active,updated_at
    ) VALUES(?,?,?,CURRENT_TIMESTAMP,NULL,1,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      reason=excluded.reason,blocked_by=excluded.blocked_by,blocked_at=CURRENT_TIMESTAMP,
      expires_at=NULL,active=1,updated_at=CURRENT_TIMESTAMP`)
      .bind(telegramId,reason,adminId).run();
  }
  await logEvent(env,'manual_block',{
    severity:'high',telegramId:Number(telegramId),details:`admin=${adminId} ttl=${ttl} reason=${reason}`
  });
}

export async function unblockUser(env, telegramId, adminId) {
  await ensureV25Schema(env);
  await env.DB.prepare(`UPDATE fn25_blocks SET active=0,updated_at=CURRENT_TIMESTAMP
    WHERE telegram_id=?`).bind(telegramId).run();
  await env.DB.prepare('DELETE FROM fn25_quarantine WHERE telegram_id=?').bind(telegramId).run();
  await logEvent(env,'manual_unblock',{
    severity:'info',telegramId:Number(telegramId),details:`admin=${adminId}`
  });
}

async function setAdminSession(env, adminId, action, payload = {}, minutes = 10) {
  await ensureV25Schema(env);
  await env.DB.prepare(`INSERT INTO fn25_admin_sessions(
    admin_id,action,payload,expires_at,updated_at
  ) VALUES(?,?,?,datetime('now',?),CURRENT_TIMESTAMP)
  ON CONFLICT(admin_id) DO UPDATE SET action=excluded.action,payload=excluded.payload,
    expires_at=excluded.expires_at,updated_at=CURRENT_TIMESTAMP`)
    .bind(adminId,action,JSON.stringify(payload),`+${minutes} minutes`).run();
}
async function getAdminSession(env, adminId) {
  await ensureV25Schema(env);
  const row = await env.DB.prepare(`SELECT * FROM fn25_admin_sessions
    WHERE admin_id=? AND datetime(expires_at)>datetime('now')`).bind(adminId).first();
  if (!row) return null;
  let payload={}; try { payload=JSON.parse(row.payload||'{}'); } catch {}
  return {...row,payload};
}
async function clearAdminSession(env, adminId) {
  await env.DB.prepare('DELETE FROM fn25_admin_sessions WHERE admin_id=?').bind(adminId).run();
}

async function securityStats(env) {
  const [blocks, quarantine, events, retries] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) n FROM fn25_blocks WHERE active=1
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))`).first(),
    env.DB.prepare(`SELECT COUNT(*) n FROM fn25_quarantine
      WHERE datetime(blocked_until)>datetime('now')`).first(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN severity='high' THEN 1 ELSE 0 END) high,
      SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warning
      FROM fn25_events WHERE datetime(created_at)>=datetime('now','-24 hours')`).first(),
    env.DB.prepare(`SELECT COUNT(*) n FROM fn24_updates WHERE status='retry'`).first()
  ]);
  return {
    blocks:Number(blocks?.n||0),
    quarantine:Number(quarantine?.n||0),
    high:Number(events?.high||0),
    warning:Number(events?.warning||0),
    retries:Number(retries?.n||0)
  };
}

async function showSecurity(env, chatId) {
  const s=await securityStats(env);
  return sendMessage(env,chatId,[
    '🛡 <b>Security Center</b>',
    '',
    '🔐 Webhook: token-derived secret + constant-time compare',
    '🧾 Updates: global idempotency / retry lock',
    '🚦 Flood: persistent rate limit + adaptive quarantine',
    '🔒 Admin: ADMIN_IDS allowlist + private panel',
    '🧵 Operator: ACL + ticket-topic isolation',
    '',
    `🚫 Manual block: <b>${s.blocks}</b>`,
    `⏳ Quarantine: <b>${s.quarantine}</b>`,
    `🚨 High events 24h: <b>${s.high}</b>`,
    `⚠️ Warnings 24h: <b>${s.warning}</b>`,
    `🔁 Retry updates: <b>${s.retries}</b>`
  ].join('\n'),{
    reply_markup:inlineKeyboard([
      [{text:'🚫 User block',callback_data:'v25:block:start'},{text:'✅ Unblock',callback_data:'v25:unblock:list'}],
      [{text:'📋 Blocklist',callback_data:'v25:block:list'},{text:'🚨 Events',callback_data:'v25:events'}],
      [{text:'🔄 Yangilash',callback_data:'v25:security'}],
      [{text:'⬅️ Admin panel',callback_data:'v23:main'}]
    ])
  });
}

async function showBlocks(env, chatId, mode='view') {
  const rows=(await env.DB.prepare(`SELECT b.telegram_id,b.reason,b.expires_at,b.blocked_at,u.username,
      u.first_name,u.last_name
    FROM fn25_blocks b LEFT JOIN fn5_users u ON u.telegram_id=b.telegram_id
    WHERE b.active=1 AND (b.expires_at IS NULL OR datetime(b.expires_at)>datetime('now'))
    ORDER BY b.blocked_at DESC LIMIT 20`).all()).results||[];
  const buttons=[];
  if(mode==='unblock'){
    for(const x of rows) buttons.push([{
      text:`✅ ${[x.first_name,x.last_name].filter(Boolean).join(' ')||x.username||x.telegram_id}`,
      callback_data:`v25:unblock:confirm:${x.telegram_id}`
    }]);
  }
  buttons.push([{text:'⬅️ Security',callback_data:'v25:security'}]);
  return sendMessage(env,chatId,[
    mode==='unblock'?'✅ <b>Unblock tanlang</b>':'📋 <b>Active blocklist</b>',
    '',
    ...(rows.length?rows.map(x=>{
      const name=[x.first_name,x.last_name].filter(Boolean).join(' ')||x.username||'—';
      return `• <b>${escapeHtml(name)}</b> · <code>${x.telegram_id}</code>\n  ${escapeHtml(x.reason||'—')} · ${x.expires_at?escapeHtml(x.expires_at):'permanent'}`;
    }):['—'])
  ].join('\n'),{reply_markup:inlineKeyboard(buttons)});
}

async function showEvents(env, chatId) {
  const rows=(await env.DB.prepare(`SELECT severity,event_type,telegram_id,details,created_at
    FROM fn25_events ORDER BY id DESC LIMIT 20`).all()).results||[];
  return sendMessage(env,chatId,[
    '🚨 <b>Security events</b>','',
    ...(rows.length?rows.map(x=>
      `${x.severity==='high'?'🔴':x.severity==='warning'?'🟡':'⚪'} <code>${escapeHtml(x.created_at)}</code> · <b>${escapeHtml(x.event_type)}</b>\n  user <code>${x.telegram_id||'—'}</code>${x.details?` · ${escapeHtml(x.details)}`:''}`
    ):['—'])
  ].join('\n'),{
    reply_markup:inlineKeyboard([[{text:'⬅️ Security',callback_data:'v25:security'}]])
  });
}

async function handleAdminCallback(env,q){
  const data=String(q.data||'');
  if(!data.startsWith('v25:')) return false;
  if(!isSecurityAdmin(env,q.from.id)){
    await answerCallback(env,q.id,'Ruxsat yo‘q'); return true;
  }
  if(q.message?.chat?.type!=='private'){
    await answerCallback(env,q.id,'Faqat private chatda'); return true;
  }
  const chatId=q.message.chat.id;

  if(data==='v25:security'){await answerCallback(env,q.id);return showSecurity(env,chatId);}
  if(data==='v25:block:list'){await answerCallback(env,q.id);return showBlocks(env,chatId,'view');}
  if(data==='v25:unblock:list'){await answerCallback(env,q.id);return showBlocks(env,chatId,'unblock');}
  if(data==='v25:events'){await answerCallback(env,q.id);return showEvents(env,chatId);}
  if(data==='v25:block:start'){
    await setAdminSession(env,q.from.id,'block_user_id',{},10);
    await answerCallback(env,q.id);
    await sendMessage(env,chatId,'🚫 Block qilinadigan Telegram user ID ni yuboring.\n\n/cancel — bekor');
    return true;
  }
  if(data.startsWith('v25:block:ttl:')){
    const [, , , id, ttl]=data.split(':');
    if(!/^\d+$/.test(id)||!['1h','24h','7d','30d','permanent'].includes(ttl)){
      await answerCallback(env,q.id,'Noto‘g‘ri qiymat');return true;
    }
    if(isSecurityAdmin(env,id)){
      await answerCallback(env,q.id,'Adminni bloklab bo‘lmaydi');return true;
    }
    await blockUser(env,id,q.from.id,ttl);
    await answerCallback(env,q.id,'User bloklandi');
    return showSecurity(env,chatId);
  }
  if(data.startsWith('v25:unblock:confirm:')){
    const id=data.split(':')[3];
    if(!/^\d+$/.test(id)){await answerCallback(env,q.id,'Noto‘g‘ri ID');return true;}
    await unblockUser(env,id,q.from.id);
    await answerCallback(env,q.id,'Unblock qilindi');
    return showBlocks(env,chatId,'unblock');
  }
  return true;
}

async function handleAdminMessage(env,msg){
  if(msg?.chat?.type!=='private'||msg.from?.is_bot) return false;
  const text=String(msg.text||'').trim();

  if(/^\/security(?:@\w+)?$/i.test(text)){
    if(!isSecurityAdmin(env,msg.from.id)){
      await sendMessage(env,msg.chat.id,'⛔ Bu buyruq mavjud emas.');return true;
    }
    await clearAdminSession(env,msg.from.id);
    return showSecurity(env,msg.chat.id);
  }

  if(!isSecurityAdmin(env,msg.from.id)) return false;
  const s=await getAdminSession(env,msg.from.id);
  if(!s) return false;
  if(/^\/cancel(?:@\w+)?$/i.test(text)){
    await clearAdminSession(env,msg.from.id);
    await sendMessage(env,msg.chat.id,'❎ Security amali bekor qilindi.');
    return showSecurity(env,msg.chat.id);
  }
  if(s.action==='block_user_id'){
    if(!/^\d{5,20}$/.test(text)){
      await sendMessage(env,msg.chat.id,'⚠️ Faqat Telegram user ID yuboring.');
      return true;
    }
    if(isSecurityAdmin(env,text)){
      await clearAdminSession(env,msg.from.id);
      await sendMessage(env,msg.chat.id,'⛔ Bot administratorini bloklab bo‘lmaydi.');
      return showSecurity(env,msg.chat.id);
    }
    await clearAdminSession(env,msg.from.id);
    await sendMessage(env,msg.chat.id,`🚫 <code>${text}</code> uchun blok muddatini tanlang:`,{
      reply_markup:inlineKeyboard([
        [{text:'1 soat',callback_data:`v25:block:ttl:${text}:1h`},{text:'24 soat',callback_data:`v25:block:ttl:${text}:24h`}],
        [{text:'7 kun',callback_data:`v25:block:ttl:${text}:7d`},{text:'30 kun',callback_data:`v25:block:ttl:${text}:30d`}],
        [{text:'♾ Permanent',callback_data:`v25:block:ttl:${text}:permanent`}],
        [{text:'⬅️ Security',callback_data:'v25:security'}]
      ])
    });
    return true;
  }
  return false;
}

export async function handleV25AdminUpdate(env,update){
  await ensureV25Schema(env);
  if(update?.callback_query && await handleAdminCallback(env,update.callback_query)) return true;
  if(update?.message && await handleAdminMessage(env,update.message)) return true;
  return false;
}

export async function runV25Maintenance(env){
  await ensureV25Schema(env);
  await env.DB.prepare(`UPDATE fn25_blocks SET active=0,updated_at=CURRENT_TIMESTAMP
    WHERE active=1 AND expires_at IS NOT NULL AND datetime(expires_at)<=datetime('now')`).run();
  await env.DB.prepare(`DELETE FROM fn25_quarantine
    WHERE datetime(blocked_until)<=datetime('now','-1 day')`).run();
  await env.DB.prepare(`DELETE FROM fn25_admin_sessions
    WHERE datetime(expires_at)<=datetime('now')`).run();
  await env.DB.prepare(`DELETE FROM fn25_events
    WHERE datetime(created_at)<datetime('now','-90 day')`).run();
}

export async function v25Health(env){
  await ensureV25Schema(env);
  const s=await securityStats(env);
  return {
    mode:'manual-blocklist-adaptive-quarantine-security-events',
    ...s
  };
}

export const __test={
  version:VERSION,
  actorOf
};
