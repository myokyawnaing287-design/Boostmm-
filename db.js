'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');
const events = require('./events');

if (cfg.dbPath !== ':memory:') fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const db = new DatabaseSync(cfg.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Money is stored as integer "cents of a kyat" (1 ks = 100) so there is no float drift.
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  pass_hash TEXT NOT NULL,
  balance_c INTEGER NOT NULL DEFAULT 0 CHECK(balance_c >= 0),
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','staff','owner')),
  is_banned INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner ON users(role) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta_c INTEGER NOT NULL,
  balance_after_c INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id DESC);

CREATE TABLE IF NOT EXISTS services(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  rate_usd REAL NOT NULL,
  min INTEGER NOT NULL,
  max INTEGER NOT NULL,
  refill INTEGER NOT NULL DEFAULT 0,
  cancel INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  markup_override REAL,
  custom_name TEXT,
  description TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL,
  service_name TEXT NOT NULL,
  link TEXT NOT NULL,
  comments TEXT,
  quantity INTEGER NOT NULL,
  charge_c INTEGER NOT NULL,
  refunded_c INTEGER NOT NULL DEFAULT 0,
  fx REAL NOT NULL,
  cost_usd_est REAL NOT NULL,
  upstream_charge_usd REAL,
  upstream_order_id TEXT,
  status TEXT NOT NULL,
  start_count TEXT,
  remains TEXT,
  request_id TEXT NOT NULL,
  refill_id TEXT,
  refill_status TEXT,
  refill_at INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, request_id)
);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS deposits(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_c INTEGER NOT NULL,
  method TEXT NOT NULL,
  txn_ref TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  decided_by INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS deposits_txn_uq ON deposits(method, txn_ref) WHERE status <> 'rejected';

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_changes(
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at INTEGER NOT NULL
);
`);

const now = () => Math.floor(Date.now() / 1000);

// Synchronous transaction. Do not nest, and do not await inside fn.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

const DEFAULT_SETTINGS = {
  site_name: 'Boostmm',
  markup_percent: '30',
  usd_mmk: '4700',
  min_deposit_mmk: '1000',
  announcement: '',
  support_contact: '',
  payment_accounts: JSON.stringify([
    { method: 'wave', label: 'Wave Pay', number: '', holder: '' },
    { method: 'kbz', label: 'KBZ Pay', number: '', holder: '' },
  ]),
  services_synced_at: '0',
};
{
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
}

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Every balance change goes through here (inside tx) so the ledger is always complete.
// The CHECK(balance_c >= 0) on users is the last line of defence against overdrafts.
function adjustBalance(userId, deltaC, reason, ref) {
  const row = db.prepare('UPDATE users SET balance_c = balance_c + ? WHERE id = ? RETURNING balance_c').get(deltaC, userId);
  if (!row) throw new Error('user not found');
  db.prepare('INSERT INTO ledger(user_id, delta_c, balance_after_c, reason, ref, created_at) VALUES(?,?,?,?,?,?)')
    .run(userId, deltaC, row.balance_c, reason, ref == null ? null : String(ref), now());
  events.publish('balance', {}, { userId }); // every open tab of this user refreshes its balance
  return row.balance_c;
}

function audit(actor, action, target, detail) {
  db.prepare('INSERT INTO audit(actor_id, actor_name, action, target, detail, created_at) VALUES(?,?,?,?,?,?)')
    .run(actor ? actor.id : null, actor ? actor.username : 'system', action, target == null ? null : String(target), detail == null ? null : String(detail).slice(0, 500), now());
}

module.exports = { db, tx, now, getSettings, setSetting, adjustBalance, audit };
