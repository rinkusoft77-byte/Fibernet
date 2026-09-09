const now = () => new Date().toISOString();

export const DEPARTMENTS = ['general','tech','accounting','subscriber','connection'];

export async function ensureV7Routing(env) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS fn7_department_chats (
      department TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL UNIQUE,
      title TEXT,
      bound_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn7_operator_sessions (
      chat_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      ticket_no TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(chat_id, operator_id)
    )`,
    `CREATE TABLE IF NOT EXISTS fn7_processed (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn7_department_chat ON fn7_department_chats(chat_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fn7_operator_ticket ON fn7_operator_sessions(ticket_no)`
  ];
  for (const sql of statements) await env.DB.prepare(sql).run();
}

export function validDepartment(department) {
  return DEPARTMENTS.includes(String(department || '').toLowerCase());
}

export async function bindDepartment(env, department, chatId, title = null, boundBy = null) {
  department = String(department || '').toLowerCase();
  if (!validDepartment(department)) throw new Error('Invalid department');
  await ensureV7Routing(env);
  await env.DB.prepare('DELETE FROM fn7_department_chats WHERE department=? OR chat_id=?')
    .bind(department, chatId).run();
  await env.DB.prepare(`INSERT INTO fn7_department_chats(department,chat_id,title,bound_by,updated_at)
    VALUES(?,?,?,?,?)`).bind(department, chatId, title || null, boundBy || null, now()).run();
}

export async function unbindDepartment(env, department) {
  await ensureV7Routing(env);
  return env.DB.prepare('DELETE FROM fn7_department_chats WHERE department=?')
    .bind(String(department || '').toLowerCase()).run();
}

export async function getDepartmentChat(env, department) {
  await ensureV7Routing(env);
  return env.DB.prepare('SELECT * FROM fn7_department_chats WHERE department=?')
    .bind(String(department || '').toLowerCase()).first();
}

export async function getDepartmentByChat(env, chatId) {
  await ensureV7Routing(env);
  return env.DB.prepare('SELECT * FROM fn7_department_chats WHERE chat_id=?')
    .bind(chatId).first();
}

export async function listDepartmentChats(env) {
  await ensureV7Routing(env);
  const r = await env.DB.prepare('SELECT * FROM fn7_department_chats ORDER BY department').all();
  return r.results || [];
}

export async function setOperatorReplySession(env, chatId, operatorId, ticketNo) {
  await ensureV7Routing(env);
  return env.DB.prepare(`INSERT INTO fn7_operator_sessions(chat_id,operator_id,ticket_no,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(chat_id,operator_id) DO UPDATE SET ticket_no=excluded.ticket_no,updated_at=excluded.updated_at`)
    .bind(chatId, operatorId, ticketNo, now()).run();
}

export async function getOperatorReplySession(env, chatId, operatorId) {
  await ensureV7Routing(env);
  return env.DB.prepare('SELECT * FROM fn7_operator_sessions WHERE chat_id=? AND operator_id=?')
    .bind(chatId, operatorId).first();
}

export async function clearOperatorReplySession(env, chatId, operatorId) {
  await ensureV7Routing(env);
  return env.DB.prepare('DELETE FROM fn7_operator_sessions WHERE chat_id=? AND operator_id=?')
    .bind(chatId, operatorId).run();
}

export async function cleanupOperatorReplySessions(env) {
  await ensureV7Routing(env);
  return env.DB.prepare("DELETE FROM fn7_operator_sessions WHERE datetime(updated_at) < datetime('now','-2 hours')").run();
}

export async function claimV7Update(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  await ensureV7Routing(env);
  try {
    await env.DB.prepare('INSERT INTO fn7_processed(update_id) VALUES(?)').bind(updateId).run();
    return true;
  } catch (e) {
    const s = String(e).toLowerCase();
    if (s.includes('unique') || s.includes('constraint')) return false;
    throw e;
  }
}

export function releaseV7Update(env, updateId) {
  return env.DB.prepare('DELETE FROM fn7_processed WHERE update_id=?').bind(updateId).run();
}

export function cleanupV7Updates(env) {
  return env.DB.prepare("DELETE FROM fn7_processed WHERE created_at < datetime('now','-7 day')").run();
}
