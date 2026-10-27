'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { db, now } = require('./db');
const cfg = require('./config');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(parts[1], 'hex'), 64, SCRYPT);
  const expected = Buffer.from(parts[2], 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(key, expected);
}

let dummyHash;
async function dummyVerify(pw) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(8).toString('hex'));
  await verifyPassword(pw, dummyHash); // keep timing similar when the user does not exist
}

// ---- sessions ----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const days = user.role === 'owner' ? Math.min(3, cfg.sessionDays) : cfg.sessionDays;
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(sha256(token), user.id, now() + days * 86400);
  return { token, maxAge: days * 86400 };
}

function getSessionUser(token) {
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.username, u.email, u.role, u.balance_c, u.totp_enabled
                     FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_banned = 0`).get(sha256(token), now()) || null;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}
function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, sha256(exceptToken));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

// ---- in-memory rate limiting ----
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) {
    b = { n: 0, reset: t + windowMs };
    buckets.set(key, b);
  }
  b.n += 1;
  return b.n <= max;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
}, 60000).unref();

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}
function hotp(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[19] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1000000).padStart(6, '0');
}
function newTotpSecret() {
  return b32encode(crypto.randomBytes(20));
}
// Returns the accepted time-step, or null. Steps <= lastStep are rejected (no replay).
function verifyTotp(secretB32, code, lastStep, atMs = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  let key;
  try { key = b32decode(secretB32); } catch { return null; }
  const t = Math.floor(atMs / 30000);
  for (const d of [-1, 0, 1]) {
    const step = t + d;
    if (step <= lastStep) continue;
    const a = Buffer.from(hotp(key, step));
    const b = Buffer.from(String(code));
    if (crypto.timingSafeEqual(a, b)) return step;
  }
  return null;
}

module.exports = {
  hashPassword, verifyPassword, dummyVerify,
  createSession, getSessionUser, destroySession, destroyUserSessions, purgeExpiredSessions,
  rateLimit, newTotpSecret, verifyTotp, hotp, b32decode, b32encode,
};
