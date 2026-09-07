PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language TEXT DEFAULT NULL CHECK(language IN ('uz','ru')),
  phone TEXT,
  state TEXT,
  state_data TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT NOT NULL UNIQUE,
  telegram_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  account_login TEXT,
  address TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')),
  support_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  closed_by INTEGER,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_telegram_id ON tickets(telegram_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_support_message_id ON tickets(support_message_id);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT NOT NULL,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user','operator','system')),
  sender_telegram_id INTEGER,
  body TEXT,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_no) REFERENCES tickets(ticket_no)
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_no, created_at);

CREATE TABLE IF NOT EXISTS source_cache (
  source_key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  http_status INTEGER,
  content TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS catalog (
  catalog_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  source_url TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
