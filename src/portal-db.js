let schemaReady = false;

const now = () => new Date().toISOString();

async function safe(env, sql) {
  try { await env.DB.prepare(sql).run(); } catch (err) {
    const s = String(err).toLowerCase();
    if (!s.includes("duplicate column") && !s.includes("already exists")) throw err;
  }
}

export async function ensurePortalSchema(env) {
  if (schemaReady) return;
  const alters = [
    "ALTER TABLE users ADD COLUMN account_login TEXT",
    "ALTER TABLE users ADD COLUMN address TEXT",
    "ALTER TABLE users ADD COLUMN profile_completed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN last_seen_at TEXT",
    "ALTER TABLE tickets ADD COLUMN department TEXT",
    "ALTER TABLE tickets ADD COLUMN stage TEXT NOT NULL DEFAULT 'new'",
    "ALTER TABLE tickets ADD COLUMN assigned_to INTEGER",
    "ALTER TABLE tickets ADD COLUMN assigned_name TEXT",
    "ALTER TABLE tickets ADD COLUMN first_response_at TEXT",
    "ALTER TABLE tickets ADD COLUMN resolved_at TEXT",
    "ALTER TABLE tickets ADD COLUMN satisfaction INTEGER",
    "ALTER TABLE tickets ADD COLUMN diagnostics TEXT",
    "ALTER TABLE tickets ADD COLUMN last_customer_at TEXT",
    "ALTER TABLE tickets ADD COLUMN last_operator_at TEXT",
    "ALTER TABLE tickets ADD COLUMN sla_notified_at TEXT"
  ];
  for (const sql of alters) await safe(env, sql);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS bot_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    event_type TEXT NOT NULL,
    event_data TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await safe(env, "CREATE INDEX IF NOT EXISTS idx_tickets_department_stage ON tickets(department, stage, created_at DESC)");
  await safe(env, "CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to, status, created_at DESC)");
  await safe(env, "CREATE INDEX IF NOT EXISTS idx_tickets_sla ON tickets(status, stage, created_at)");
  schemaReady = true;
}

export async function upsertPortalUser(env, from) {
  await ensurePortalSchema(env);
  const ts = now();
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, updated_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      updated_at=excluded.updated_at,
      last_seen_at=excluded.last_seen_at
  `).bind(from.id, from.username || null, from.first_name || null, from.last_name || null, ts, ts).run();
  return getPortalUser(env, from.id);
}

export function getPortalUser(env, telegramId) {
  return env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first();
}

export async function setPortalLanguage(env, telegramId, language) {
  await env.DB.prepare("UPDATE users SET language=?, updated_at=? WHERE telegram_id=?")
    .bind(language, now(), telegramId).run();
}

export async function updatePortalProfile(env, telegramId, { accountLogin, address, phone }) {
  const completed = phone && address ? 1 : 0;
  await env.DB.prepare(`
    UPDATE users SET account_login=?, address=?, phone=?, profile_completed=?, updated_at=?
    WHERE telegram_id=?
  `).bind(accountLogin || null, address || null, phone || null, completed, now(), telegramId).run();
}

export async function savePortalPhone(env, telegramId, phone) {
  await env.DB.prepare("UPDATE users SET phone=?, updated_at=? WHERE telegram_id=?")
    .bind(phone, now(), telegramId).run();
}

export async function setFlow(env, telegramId, state, data = {}) {
  await env.DB.prepare("UPDATE users SET state=?, state_data=?, updated_at=? WHERE telegram_id=?")
    .bind(state, JSON.stringify(data || {}), now(), telegramId).run();
}

export async function clearFlow(env, telegramId) {
  await env.DB.prepare("UPDATE users SET state=NULL, state_data=NULL, updated_at=? WHERE telegram_id=?")
    .bind(now(), telegramId).run();
}

export function flowData(user) {
  try { return user?.state_data ? JSON.parse(user.state_data) : {}; }
  catch { return {}; }
}

function ticketNo() {
  const d = new Date();
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const rand = crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  return `FN-${yy}${mm}${dd}-${rand}`;
}

export async function createPortalTicket(env, input) {
  await ensurePortalSchema(env);
  const no = ticketNo();
  const ts = now();
  await env.DB.prepare(`
    INSERT INTO tickets (
      ticket_no, telegram_id, category, description, account_login, address, phone,
      status, priority, created_at, updated_at, department, stage, diagnostics,
      last_customer_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 'new', ?, ?)
  `).bind(
    no, input.telegramId, input.category || "other", input.description || "",
    input.accountLogin || null, input.address || null, input.phone || null,
    input.priority || "normal", ts, ts, input.department || "tech",
    input.diagnostics || null, ts
  ).run();
  await addPortalMessage(env, no, "user", input.telegramId, input.description || "", input.telegramMessageId || null);
  await logEvent(env, input.telegramId, "ticket_created", { ticketNo: no, department: input.department, category: input.category });
  return no;
}

export function getPortalTicket(env, no) {
  return env.DB.prepare("SELECT * FROM tickets WHERE ticket_no=?").bind(no).first();
}

export function getTicketBySupportMessage(env, messageId) {
  return env.DB.prepare("SELECT * FROM tickets WHERE support_message_id=?").bind(messageId).first();
}

export async function listPortalTickets(env, telegramId, limit = 10) {
  const r = await env.DB.prepare(`
    SELECT ticket_no, category, department, stage, status, priority, description, created_at, updated_at
    FROM tickets WHERE telegram_id=? ORDER BY id DESC LIMIT ?
  `).bind(telegramId, limit).all();
  return r.results || [];
}

export async function listQueue(env, limit = 20) {
  const r = await env.DB.prepare(`
    SELECT ticket_no, telegram_id, category, department, stage, status, priority, assigned_to,
           assigned_name, description, created_at, updated_at
    FROM tickets
    WHERE status='open'
    ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             id ASC
    LIMIT ?
  `).bind(limit).all();
  return r.results || [];
}

export async function setSupportMessage(env, no, messageId) {
  await env.DB.prepare("UPDATE tickets SET support_message_id=?, updated_at=? WHERE ticket_no=?")
    .bind(messageId, now(), no).run();
}

export async function addPortalMessage(env, no, senderType, senderId, body, messageId = null) {
  await env.DB.prepare(`
    INSERT INTO ticket_messages(ticket_no, sender_type, sender_telegram_id, body, telegram_message_id)
    VALUES (?, ?, ?, ?, ?)
  `).bind(no, senderType, senderId || null, body || null, messageId || null).run();
  const column = senderType === "operator" ? "last_operator_at" : senderType === "user" ? "last_customer_at" : null;
  if (column) {
    await env.DB.prepare(`UPDATE tickets SET ${column}=?, updated_at=? WHERE ticket_no=?`)
      .bind(now(), now(), no).run();
  }
}

export async function setTicketStage(env, no, stage, operator = null) {
  const ts = now();
  const assign = operator?.id || null;
  const assignName = operator?.name || null;
  if (stage === "in_progress") {
    await env.DB.prepare(`
      UPDATE tickets SET stage=?, assigned_to=COALESCE(assigned_to, ?), assigned_name=COALESCE(assigned_name, ?),
        first_response_at=COALESCE(first_response_at, ?), updated_at=?
      WHERE ticket_no=? AND status='open'
    `).bind(stage, assign, assignName, ts, ts, no).run();
  } else if (stage === "resolved") {
    await env.DB.prepare(`
      UPDATE tickets SET stage=?, assigned_to=COALESCE(assigned_to, ?), assigned_name=COALESCE(assigned_name, ?),
        resolved_at=COALESCE(resolved_at, ?), updated_at=?
      WHERE ticket_no=? AND status='open'
    `).bind(stage, assign, assignName, ts, ts, no).run();
  } else {
    await env.DB.prepare(`
      UPDATE tickets SET stage=?, assigned_to=COALESCE(assigned_to, ?), assigned_name=COALESCE(assigned_name, ?), updated_at=?
      WHERE ticket_no=? AND status='open'
    `).bind(stage, assign, assignName, ts, no).run();
  }
}

export async function assignTicket(env, no, operator) {
  await env.DB.prepare(`
    UPDATE tickets SET assigned_to=?, assigned_name=?, stage=CASE WHEN stage='new' THEN 'in_progress' ELSE stage END,
      first_response_at=COALESCE(first_response_at, ?), updated_at=?
    WHERE ticket_no=? AND status='open'
  `).bind(operator.id, operator.name || null, now(), now(), no).run();
}

export async function closePortalTicket(env, no, closedBy) {
  const ts = now();
  const r = await env.DB.prepare(`
    UPDATE tickets SET status='closed', stage='closed', closed_at=?, closed_by=?, updated_at=?
    WHERE ticket_no=? AND status='open'
  `).bind(ts, closedBy || null, ts, no).run();
  return (r.meta?.changes || 0) > 0;
}

export async function setSatisfaction(env, no, telegramId, score) {
  await env.DB.prepare("UPDATE tickets SET satisfaction=?, updated_at=? WHERE ticket_no=? AND telegram_id=?")
    .bind(score, now(), no, telegramId).run();
  await logEvent(env, telegramId, "ticket_feedback", { ticketNo: no, score });
}

export async function advancedStats(env) {
  const row = await env.DB.prepare(`
    SELECT
      COUNT(*) total,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) closed,
      SUM(CASE WHEN status='open' AND stage='new' THEN 1 ELSE 0 END) new_count,
      SUM(CASE WHEN status='open' AND stage='in_progress' THEN 1 ELSE 0 END) in_progress,
      SUM(CASE WHEN status='open' AND stage='waiting_customer' THEN 1 ELSE 0 END) waiting_customer,
      SUM(CASE WHEN satisfaction=1 THEN 1 ELSE 0 END) positive,
      SUM(CASE WHEN satisfaction=0 THEN 1 ELSE 0 END) negative
    FROM tickets
  `).first();
  return row || {};
}

export async function claimUpdate(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  try {
    await env.DB.prepare("INSERT INTO processed_updates(update_id) VALUES (?)").bind(updateId).run();
    return true;
  } catch (err) {
    const s = String(err).toLowerCase();
    if (s.includes("unique") || s.includes("constraint")) return false;
    throw err;
  }
}

export function releaseUpdate(env, updateId) {
  return env.DB.prepare("DELETE FROM processed_updates WHERE update_id=?").bind(updateId).run();
}

export function cleanupProcessedUpdates(env) {
  return env.DB.prepare("DELETE FROM processed_updates WHERE created_at < datetime('now','-7 day')").run();
}

export async function staleTickets(env, minutes = 30, limit = 20) {
  const r = await env.DB.prepare(`
    SELECT * FROM tickets
    WHERE status='open' AND stage IN ('new','in_progress')
      AND datetime(created_at) < datetime('now', ?)
      AND (sla_notified_at IS NULL OR datetime(sla_notified_at) < datetime('now','-60 minutes'))
    ORDER BY id ASC LIMIT ?
  `).bind(`-${Number(minutes)} minutes`, limit).all();
  return r.results || [];
}

export function markSlaNotified(env, no) {
  return env.DB.prepare("UPDATE tickets SET sla_notified_at=?, updated_at=? WHERE ticket_no=?")
    .bind(now(), now(), no).run();
}

export async function logEvent(env, telegramId, eventType, data = null) {
  try {
    await env.DB.prepare("INSERT INTO bot_events(telegram_id,event_type,event_data) VALUES (?,?,?)")
      .bind(telegramId || null, eventType, data ? JSON.stringify(data) : null).run();
  } catch {}
}
