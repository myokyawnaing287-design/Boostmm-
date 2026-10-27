'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const cfg = require('./config');
const { db, now } = require('./db');
const auth = require('./auth');
const { handler } = require('./http');
require('./routes');
const sync = require('./sync');

async function ensureOwner() {
  const existing = db.prepare("SELECT id, email FROM users WHERE role = 'owner'").get();
  if (existing) {
    if ((existing.email || '').toLowerCase() !== cfg.ownerEmail) {
      const clash = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id <> ?').get(cfg.ownerEmail, existing.id);
      if (clash) throw new Error('OWNER_EMAIL is already used by another account.');
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(cfg.ownerEmail, existing.id);
      console.log(`[owner] email updated to ${cfg.ownerEmail}`);
    }
    return;
  }
  const clash = db.prepare('SELECT id FROM users WHERE username = ? OR lower(email) = ?').get(cfg.ownerUsername, cfg.ownerEmail);
  if (clash) throw new Error('A non-owner account already uses the owner username/email. Remove it or change OWNER_USERNAME.');

  let password = cfg.ownerPassword;
  let generated = false;
  if (password.length < 10) {
    if (password) console.warn('[owner] OWNER_PASSWORD is shorter than 10 characters, ignoring it.');
    password = crypto.randomBytes(12).toString('base64url');
    generated = true;
  }
  const hash = await auth.hashPassword(password);
  db.prepare("INSERT INTO users(username, email, pass_hash, role, created_at) VALUES(?,?,?, 'owner', ?)").run(cfg.ownerUsername, cfg.ownerEmail, hash, now());
  console.log(`[owner] created owner account "${cfg.ownerUsername}" <${cfg.ownerEmail}>`);
  if (generated) {
    console.log('[owner] TEMPORARY PASSWORD (shown once, change it after first login):');
    console.log(`        ${password}`);
  }
}

async function main() {
  await ensureOwner();
  const server = http.createServer(handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[server] listening on http://${cfg.host}:${cfg.port}`);
    sync.start();
  });
  const shutdown = () => {
    sync.stop();
    server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
