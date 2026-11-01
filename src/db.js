import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookings (
  uid TEXT PRIMARY KEY,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  summary TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',          -- active | cancelled
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cleanings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_uid TEXT UNIQUE,                        -- null for days added by hand
  source TEXT NOT NULL,                           -- airbnb | manual
  date TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL,                           -- awaiting_approval | approved | declined | cancelled | completed | paid
  approval_token TEXT UNIQUE,
  approved_by TEXT,
  approved_at TEXT,
  group_notified_at TEXT,                         -- last time the shared text heard about this cleaning
  group_known_date TEXT,                          -- the date the shared text currently believes
  amount_cents INTEGER,
  paid_at TEXT,
  paid_method TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cleaning_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                             -- confirmed | added | moved | cancelled | custom
  body TEXT NOT NULL,
  status TEXT NOT NULL,                           -- pending | sent | skipped | superseded
  token TEXT UNIQUE NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cleaning_id INTEGER,
  stage TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,                          -- sms | email | group
  to_addr TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,                           -- sent | dry_run | failed
  error TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function openDb(config) {
  let file = config.dbFile;
  if (!file) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    file = path.join(config.dataDir, 'cleaning.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
