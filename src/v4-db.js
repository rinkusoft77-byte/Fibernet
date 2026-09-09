let schemaReady = false;
const now = () => new Date().toISOString();

export async function ensureV4Schema(env) {
  if (schemaReady) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS v4_users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      language TEXT,
      account_login TEXT,
      address TEXT,
      phone TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS v4_sessions (
      telegram_id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      data TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS v4_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL UNIQUE,
      telegram_id INTEGER NOT NULL,
      department TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      account_login TEXT,
      address TEXT,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      stage TEXT NOT NULL DEFAULT 'new',
      priority TEXT NOT NULL DEFAULT 'normal',
      assigned_to INTEGER,
      assigned_name TEXT,
      support_chat_id INTEGER,
      support_message_id INTEGER,
      rating INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS v4_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_id INTEGER,
      body TEXT,
      telegram_message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS v4_processed_updates (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_v4_tickets_user ON v4_tickets(telegram_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_v4_tickets_queue ON v4_tickets(status, priority, id)`,
    `CREATE INDEX IF NOT EXISTS idx_v4_support_message ON v4_tickets(support_message_id)`
  ];
  for (const sql of statements) await env.DB.prepare(sql).run();
  schemaReady = true;
}

export async function upsertV4User(env, from) {
  await ensureV4Schema(env);
  const ts = now();
  await env.DB.prepare(`
    INSERT INTO v4_users(telegram_id, username, first_name, last_name, created_at, updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      updated_at=excluded.updated_at
  `).bind(from.id, from.username || null, from.first_name || null, from.last_name || null, ts, ts).run();
  return getV4User(env, from.id);
}

export function getV4User(env, telegramId) {
  return env.DB.prepare("SELECT * FROM v4_users WHERE telegram_id=?").bind(telegramId).first();
}

export async function setV4Language(env, telegramId, lang) {
  await env.DB.prepare("UPDATE v4_users SET language=?, updated_at=? WHERE telegram_id=?")
    .bind(lang, now(), telegramId).run();
}

export async function saveV4Profile(env, telegramId, data) {
  await env.DB.prepare(`
    UPDATE v4_users SET account_login=?, address=?, phone=?, updated_at=? WHERE telegram_id=?
  `).bind(data.accountLogin || null, data.address || null, data.phone || null, now(), telegramId).run();
}

export async function setV4Session(env, telegramId, state, data = {}) {
  await env.DB.prepare(`
    INSERT INTO v4_sessions(telegram_id,state,data,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(telegram_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at
  `).bind(telegramId, state, JSON.stringify(data || {}), now()).run();
}

export function getV4Session(env, telegramId) {
  return env.DB.prepare("SELECT * FROM v4_sessions WHERE telegram_id=?").bind(telegramId).first();
}

export async function clearV4Session(env, telegramId) {
  await env.DB.prepare("DELETE FROM v4_sessions WHERE telegram_id=?").bind(telegramId).run();
}

export function sessionData(row) {
  try { return row?.data ? JSON.parse(row.data) : {}; } catch { return {}; }
}

function ticketNo() {
  const d = new Date();
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const rnd = crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  return `FN-${yy}${mm}${dd}-${rnd}`;
}

export async function createV4Ticket(env, input) {
  const no = ticketNo();
  const ts = now();
  await env.DB.prepare(`
    INSERT INTO v4_tickets(
      ticket_no, telegram_id, department, category, description, account_login, address, phone,
      status, stage, priority, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?, 'open','new',?,?,?)
  `).bind(
    no, input.telegramId, input.department, input.category, input.description,
    input.accountLogin || null, input.address || null, input.phone || null,
    input.priority || "normal", ts, ts
  ).run();
  await addV4Message(env, no, "user", input.telegramId, input.description, input.telegramMessageId || null);
  return no;
}

export function getV4Ticket(env, no) {
  return env.DB.prepare("SELECT * FROM v4_tickets WHERE ticket_no=?").bind(no).first();
}

export function getV4TicketBySupportMessage(env, messageId) {
  return env.DB.prepare("SELECT * FROM v4_tickets WHERE support_message_id=?").bind(messageId).first();
}

export async function listV4UserTickets(env, telegramId, limit = 10) {
  const r = await env.DB.prepare(`
    SELECT * FROM v4_tickets WHERE telegram_id=? ORDER BY id DESC LIMIT ?
  `).bind(telegramId, limit).all();
  return r.results || [];
}

export async function listV4Queue(env, limit = 20) {
  const r = await env.DB.prepare(`
    SELECT * FROM v4_tickets WHERE status='open'
    ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, id ASC
    LIMIT ?
  `).bind(limit).all();
  return r.results || [];
}

export async function setV4SupportMessage(env, no, chatId, messageId) {
  await env.DB.prepare("UPDATE v4_tickets SET support_chat_id=?, support_message_id=?, updated_at=? WHERE ticket_no=?")
    .bind(chatId, messageId, now(), no).run();
}

export async function addV4Message(env, no, senderType, senderId, body, messageId = null) {
  await env.DB.prepare(`
    INSERT INTO v4_messages(ticket_no,sender_type,sender_id,body,telegram_message_id)
    VALUES(?,?,?,?,?)
  `).bind(no, senderType, senderId || null, body || null, messageId || null).run();
}

export async function assignV4Ticket(env, no, operator) {
  await env.DB.prepare(`
    UPDATE v4_tickets SET assigned_to=?, assigned_name=?, stage=CASE WHEN stage='new' THEN 'in_progress' ELSE stage END, updated_at=?
    WHERE ticket_no=? AND status='open'
  `).bind(operator.id, operator.name || null, now(), no).run();
}

export async function setV4Stage(env, no, stage, operator = null) {
  await env.DB.prepare(`
    UPDATE v4_tickets SET stage=?, assigned_to=COALESCE(assigned_to,?), assigned_name=COALESCE(assigned_name,?), updated_at=?
    WHERE ticket_no=? AND status='open'
  `).bind(stage, operator?.id || null, operator?.name || null, now(), no).run();
}

export async function closeV4Ticket(env, no, operatorId = null) {
  const r = await env.DB.prepare(`
    UPDATE v4_tickets SET status='closed', stage='closed', closed_at=?, updated_at=?
    WHERE ticket_no=? AND status='open'
  `).bind(now(), now(), no).run();
  return (r.meta?.changes || 0) > 0;
}

export async function setV4Rating(env, no, telegramId, rating) {
  await env.DB.prepare("UPDATE v4_tickets SET rating=?, updated_at=? WHERE ticket_no=? AND telegram_id=?")
    .bind(rating, now(), no, telegramId).run();
}

export async function v4Stats(env) {
  const r = await env.DB.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open_count,
      SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) closed_count
    FROM v4_tickets
  `).first();
  return r || { total: 0, open_count: 0, closed_count: 0 };
}

export async function claimV4Update(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  try {
    await env.DB.prepare("INSERT INTO v4_processed_updates(update_id) VALUES(?)").bind(updateId).run();
    return true;
  } catch (err) {
    const s = String(err).toLowerCase();
    if (s.includes("unique") || s.includes("constraint")) return false;
    throw err;
  }
}

export function releaseV4Update(env, updateId) {
  return env.DB.prepare("DELETE FROM v4_processed_updates WHERE update_id=?").bind(updateId).run();
}

export function cleanupV4Updates(env) {
  return env.DB.prepare("DELETE FROM v4_processed_updates WHERE created_at < datetime('now','-7 day')").run();
}
