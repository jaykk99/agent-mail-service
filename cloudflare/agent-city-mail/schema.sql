PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS identities (
  agent_id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  address TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES identities(agent_id),
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_messages ON messages(agent_id,created_at DESC);
CREATE TABLE IF NOT EXISTS daily_send_quota (
  agent_id INTEGER NOT NULL,
  utc_day TEXT NOT NULL,
  sends INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(agent_id, utc_day)
);
