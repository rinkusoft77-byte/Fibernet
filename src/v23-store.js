let ready = false;

export async function ensureV23Store(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn23_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      setting_kind TEXT NOT NULL DEFAULT 'text',
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn23_setting_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      setting_kind TEXT,
      admin_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn23_history_key
      ON fn23_setting_history(setting_key,id DESC)`,
    `CREATE TABLE IF NOT EXISTS fn23_admin_sessions (
      admin_id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      payload TEXT,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn23_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn23_audit_created
      ON fn23_audit(created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS fn23_broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      source_chat_id INTEGER NOT NULL,
      source_message_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      target_count INTEGER NOT NULL DEFAULT 0,
      delivered INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      finished_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS fn23_broadcast_queue (
      broadcast_id INTEGER NOT NULL,
      telegram_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(broadcast_id,telegram_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn23_broadcast_due
      ON fn23_broadcast_queue(status,next_try_at)`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

export async function getSetting(env, key, fallback = null) {
  await ensureV23Store(env);
  const row = await env.DB.prepare(
    'SELECT setting_value FROM fn23_settings WHERE setting_key=?'
  ).bind(key).first();
  return row?.setting_value ?? fallback;
}

export async function getSettingsMap(env, defaults = {}) {
  await ensureV23Store(env);
  const entries = Object.entries(defaults);
  if (!entries.length) return {};
  const statements = entries.map(([key]) =>
    env.DB.prepare('SELECT setting_value FROM fn23_settings WHERE setting_key=?').bind(key)
  );
  const rows = await env.DB.batch(statements);
  const out = {};
  for (let i = 0; i < entries.length; i++) {
    const [key, fallback] = entries[i];
    const first = rows[i]?.results?.[0] || rows[i]?.result?.[0] || null;
    out[key] = first?.setting_value ?? fallback;
  }
  return out;
}

export async function getNumberSetting(env, key, fallback) {
  const v = Number(await getSetting(env, key, fallback));
  return Number.isFinite(v) ? v : fallback;
}

export async function getBooleanSetting(env, key, fallback = false) {
  const v = await getSetting(env, key, fallback ? '1' : '0');
  return String(v) === '1' || String(v).toLowerCase() === 'true';
}

export async function setSetting(env, key, value, kind = 'text', adminId = null) {
  await ensureV23Store(env);
  const old = await getSetting(env, key, null);
  await env.DB.prepare(`INSERT INTO fn23_setting_history(
    setting_key,old_value,new_value,setting_kind,admin_id
  ) VALUES(?,?,?,?,?)`).bind(key, old, value, kind, adminId).run();
  await env.DB.prepare(`INSERT INTO fn23_settings(
    setting_key,setting_value,setting_kind,updated_by,updated_at
  ) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
  ON CONFLICT(setting_key) DO UPDATE SET
    setting_value=excluded.setting_value,
    setting_kind=excluded.setting_kind,
    updated_by=excluded.updated_by,
    updated_at=CURRENT_TIMESTAMP`)
    .bind(key, value, kind, adminId).run();
  return { old, value };
}

export async function resetSetting(env, key, adminId = null) {
  await ensureV23Store(env);
  const old = await getSetting(env, key, null);
  if (old == null) return false;
  await env.DB.prepare(`INSERT INTO fn23_setting_history(
    setting_key,old_value,new_value,setting_kind,admin_id
  ) VALUES(?,?,NULL,'reset',?)`).bind(key, old, adminId).run();
  await env.DB.prepare('DELETE FROM fn23_settings WHERE setting_key=?').bind(key).run();
  return true;
}

export async function latestSettingHistory(env, key, limit = 8) {
  await ensureV23Store(env);
  const r = await env.DB.prepare(`SELECT * FROM fn23_setting_history
    WHERE setting_key=? ORDER BY id DESC LIMIT ?`).bind(key, limit).all();
  return r.results || [];
}

export async function restorePreviousSetting(env, key, adminId = null) {
  await ensureV23Store(env);
  const h = await latestSettingHistory(env, key, 1);
  if (!h.length) return false;
  const prev = h[0].old_value;
  if (prev == null) {
    await resetSetting(env, key, adminId);
  } else {
    await setSetting(env, key, prev, h[0].setting_kind || 'text', adminId);
  }
  return true;
}

export async function setAdminSession(env, adminId, action, payload = {}, minutes = 15) {
  await ensureV23Store(env);
  await env.DB.prepare(`INSERT INTO fn23_admin_sessions(
    admin_id,action,payload,expires_at,updated_at
  ) VALUES(?,?,?,datetime('now',?),CURRENT_TIMESTAMP)
  ON CONFLICT(admin_id) DO UPDATE SET
    action=excluded.action,payload=excluded.payload,expires_at=excluded.expires_at,updated_at=CURRENT_TIMESTAMP`)
    .bind(adminId, action, JSON.stringify(payload || {}), `+${Math.max(1, minutes)} minutes`).run();
}

export async function getAdminSession(env, adminId) {
  await ensureV23Store(env);
  const row = await env.DB.prepare(`SELECT * FROM fn23_admin_sessions
    WHERE admin_id=? AND datetime(expires_at)>datetime('now')`).bind(adminId).first();
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch {}
  return { ...row, payload };
}

export async function clearAdminSession(env, adminId) {
  await ensureV23Store(env);
  await env.DB.prepare('DELETE FROM fn23_admin_sessions WHERE admin_id=?').bind(adminId).run();
}

export async function auditAdmin(env, adminId, action, target = null, details = null) {
  await ensureV23Store(env);
  await env.DB.prepare(`INSERT INTO fn23_audit(admin_id,action,target,details)
    VALUES(?,?,?,?)`).bind(adminId || null, action, target, details ? String(details).slice(0,1500) : null).run();
}

export async function recentAudit(env, limit = 20) {
  await ensureV23Store(env);
  const r = await env.DB.prepare(`SELECT * FROM fn23_audit ORDER BY id DESC LIMIT ?`)
    .bind(limit).all();
  return r.results || [];
}

export async function listSettings(env) {
  await ensureV23Store(env);
  const r = await env.DB.prepare(`SELECT setting_key,setting_kind,updated_by,updated_at
    FROM fn23_settings ORDER BY setting_key`).all();
  return r.results || [];
}

export async function cleanupV23Store(env) {
  await ensureV23Store(env);
  await env.DB.prepare("DELETE FROM fn23_admin_sessions WHERE datetime(expires_at)<=datetime('now')").run();
  await env.DB.prepare("DELETE FROM fn23_audit WHERE created_at < datetime('now','-90 day')").run();
  await env.DB.prepare("DELETE FROM fn23_setting_history WHERE created_at < datetime('now','-180 day')").run();
}
