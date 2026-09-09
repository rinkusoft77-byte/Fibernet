-- FiberNet Bot v3 customer portal extensions.
-- The Worker also applies these changes defensively at runtime so an existing
-- deployment can start safely before/after `wrangler d1 migrations apply`.

ALTER TABLE users ADD COLUMN account_login TEXT;
ALTER TABLE users ADD COLUMN address TEXT;
ALTER TABLE users ADD COLUMN profile_completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_seen_at TEXT;

ALTER TABLE tickets ADD COLUMN department TEXT;
ALTER TABLE tickets ADD COLUMN stage TEXT NOT NULL DEFAULT 'new';
ALTER TABLE tickets ADD COLUMN assigned_to INTEGER;
ALTER TABLE tickets ADD COLUMN assigned_name TEXT;
ALTER TABLE tickets ADD COLUMN first_response_at TEXT;
ALTER TABLE tickets ADD COLUMN resolved_at TEXT;
ALTER TABLE tickets ADD COLUMN satisfaction INTEGER;
ALTER TABLE tickets ADD COLUMN diagnostics TEXT;
ALTER TABLE tickets ADD COLUMN last_customer_at TEXT;
ALTER TABLE tickets ADD COLUMN last_operator_at TEXT;
ALTER TABLE tickets ADD COLUMN sla_notified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tickets_department_stage ON tickets(department, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_sla ON tickets(status, stage, created_at);

CREATE TABLE IF NOT EXISTS bot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER,
  event_type TEXT NOT NULL,
  event_data TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bot_events_type_time ON bot_events(event_type, created_at DESC);
