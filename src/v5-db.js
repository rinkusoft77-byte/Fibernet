let ready = false;
const now = () => new Date().toISOString();

export async function ensureV5Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn5_users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT, first_name TEXT, last_name TEXT, language TEXT,
      account_login TEXT, address TEXT, phone TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn5_sessions (
      telegram_id INTEGER PRIMARY KEY,
      state TEXT NOT NULL, data TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn5_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL UNIQUE,
      telegram_id INTEGER NOT NULL,
      department TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      account_login TEXT, address TEXT, phone TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      stage TEXT NOT NULL DEFAULT 'new',
      priority TEXT NOT NULL DEFAULT 'normal',
      assigned_to INTEGER, assigned_name TEXT,
      support_chat_id INTEGER, support_message_id INTEGER,
      rating INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS fn5_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_id INTEGER,
      body TEXT,
      telegram_message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn5_processed (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn5_delivery (
      ticket_no TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_try_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn5_tickets_user ON fn5_tickets(telegram_id,id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_fn5_tickets_queue ON fn5_tickets(status,priority,id)`,
    `CREATE INDEX IF NOT EXISTS idx_fn5_support ON fn5_tickets(support_chat_id,support_message_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fn5_delivery ON fn5_delivery(next_try_at)`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

export async function upsertUser(env, from) {
  await ensureV5Schema(env);
  const ts = now();
  await env.DB.prepare(`INSERT INTO fn5_users(telegram_id,username,first_name,last_name,created_at,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET
    username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name, updated_at=excluded.updated_at`)
    .bind(from.id, from.username || null, from.first_name || null, from.last_name || null, ts, ts).run();
  return getUser(env, from.id);
}
export function getUser(env,id){ return env.DB.prepare('SELECT * FROM fn5_users WHERE telegram_id=?').bind(id).first(); }
export function setLanguage(env,id,lang){ return env.DB.prepare('UPDATE fn5_users SET language=?,updated_at=? WHERE telegram_id=?').bind(lang,now(),id).run(); }
export function saveProfile(env,id,d){ return env.DB.prepare('UPDATE fn5_users SET account_login=?,address=?,phone=?,updated_at=? WHERE telegram_id=?').bind(d.accountLogin||null,d.address||null,d.phone||null,now(),id).run(); }

export function setSession(env,id,state,data={}) { return env.DB.prepare(`INSERT INTO fn5_sessions(telegram_id,state,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at`).bind(id,state,JSON.stringify(data||{}),now()).run(); }
export function getSession(env,id){ return env.DB.prepare('SELECT * FROM fn5_sessions WHERE telegram_id=?').bind(id).first(); }
export function clearSession(env,id){ return env.DB.prepare('DELETE FROM fn5_sessions WHERE telegram_id=?').bind(id).run(); }
export function sessionData(row){ try{return row?.data?JSON.parse(row.data):{}}catch{return{}} }

function makeTicketNo(){ const d=new Date(); const y=String(d.getUTCFullYear()).slice(-2),m=String(d.getUTCMonth()+1).padStart(2,'0'),day=String(d.getUTCDate()).padStart(2,'0'); return `FN-${y}${m}${day}-${crypto.randomUUID().replaceAll('-','').slice(0,6).toUpperCase()}`; }

export async function createTicket(env,input){
  const no=makeTicketNo(), ts=now();
  await env.DB.prepare(`INSERT INTO fn5_tickets(ticket_no,telegram_id,department,category,description,account_login,address,phone,status,stage,priority,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?, 'open','new',?,?,?)`).bind(no,input.telegramId,input.department||'tech',input.category||'other',input.description||'',input.accountLogin||null,input.address||null,input.phone||null,input.priority||'normal',ts,ts).run();
  await addMessage(env,no,'user',input.telegramId,input.description||'',input.telegramMessageId||null);
  return no;
}
export function getTicket(env,no){ return env.DB.prepare('SELECT * FROM fn5_tickets WHERE ticket_no=?').bind(no).first(); }
export function getTicketBySupportMessage(env,chatId,messageId){ return env.DB.prepare('SELECT * FROM fn5_tickets WHERE support_chat_id=? AND support_message_id=?').bind(chatId,messageId).first(); }
export async function listUserTickets(env,id,limit=12){ const r=await env.DB.prepare('SELECT * FROM fn5_tickets WHERE telegram_id=? ORDER BY id DESC LIMIT ?').bind(id,limit).all(); return r.results||[]; }
export async function listQueue(env,limit=30){ const r=await env.DB.prepare(`SELECT * FROM fn5_tickets WHERE status='open' ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,id ASC LIMIT ?`).bind(limit).all(); return r.results||[]; }
export function setSupportMessage(env,no,chatId,messageId){ return env.DB.prepare('UPDATE fn5_tickets SET support_chat_id=?,support_message_id=?,updated_at=? WHERE ticket_no=?').bind(chatId,messageId,now(),no).run(); }
export function updateTicketPhone(env,no,id,phone){ return env.DB.prepare('UPDATE fn5_tickets SET phone=?,updated_at=? WHERE ticket_no=? AND telegram_id=?').bind(phone,now(),no,id).run(); }
export function addMessage(env,no,type,id,body,messageId=null){ return env.DB.prepare('INSERT INTO fn5_messages(ticket_no,sender_type,sender_id,body,telegram_message_id) VALUES(?,?,?,?,?)').bind(no,type,id||null,body||null,messageId||null).run(); }
export function assignTicket(env,no,op){ return env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=?,assigned_name=?,stage=CASE WHEN stage='new' THEN 'in_progress' ELSE stage END,updated_at=? WHERE ticket_no=? AND status='open'`).bind(op.id,op.name||null,now(),no).run(); }
export function setStage(env,no,stage,op=null){ return env.DB.prepare(`UPDATE fn5_tickets SET stage=?,assigned_to=COALESCE(assigned_to,?),assigned_name=COALESCE(assigned_name,?),updated_at=? WHERE ticket_no=? AND status='open'`).bind(stage,op?.id||null,op?.name||null,now(),no).run(); }
export async function closeTicket(env,no){ const r=await env.DB.prepare(`UPDATE fn5_tickets SET status='closed',stage='closed',closed_at=?,updated_at=? WHERE ticket_no=? AND status='open'`).bind(now(),now(),no).run(); return (r.meta?.changes||0)>0; }
export function setRating(env,no,id,rating){ return env.DB.prepare('UPDATE fn5_tickets SET rating=?,updated_at=? WHERE ticket_no=? AND telegram_id=?').bind(rating,now(),no,id).run(); }

export async function claimUpdate(env,id){ if(!Number.isInteger(id))return true; try{await env.DB.prepare('INSERT INTO fn5_processed(update_id) VALUES(?)').bind(id).run();return true}catch(e){const s=String(e).toLowerCase();if(s.includes('unique')||s.includes('constraint'))return false;throw e} }
export function releaseUpdate(env,id){ return env.DB.prepare('DELETE FROM fn5_processed WHERE update_id=?').bind(id).run(); }
export function cleanupUpdates(env){ return env.DB.prepare("DELETE FROM fn5_processed WHERE created_at < datetime('now','-7 day')").run(); }

export function enqueueDelivery(env,no,error=''){ return env.DB.prepare(`INSERT INTO fn5_delivery(ticket_no,attempts,last_error,next_try_at,updated_at) VALUES(?,0,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(ticket_no) DO UPDATE SET last_error=excluded.last_error,next_try_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`).bind(no,String(error).slice(0,500)).run(); }
export async function pendingDeliveries(env,limit=20){ const r=await env.DB.prepare(`SELECT d.ticket_no,d.attempts FROM fn5_delivery d JOIN fn5_tickets t ON t.ticket_no=d.ticket_no WHERE t.status='open' AND datetime(d.next_try_at)<=datetime('now') ORDER BY d.updated_at ASC LIMIT ?`).bind(limit).all(); return r.results||[]; }
export function deliveryDone(env,no){ return env.DB.prepare('DELETE FROM fn5_delivery WHERE ticket_no=?').bind(no).run(); }
export function deliveryFailed(env,no,error){ return env.DB.prepare(`UPDATE fn5_delivery SET attempts=attempts+1,last_error=?,next_try_at=datetime('now', CASE WHEN attempts<2 THEN '+5 minutes' WHEN attempts<5 THEN '+15 minutes' ELSE '+60 minutes' END),updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?`).bind(String(error).slice(0,500),no).run(); }

export async function stats(env){ const r=await env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open_count,SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) closed_count FROM fn5_tickets`).first(); return r||{total:0,open_count:0,closed_count:0}; }
