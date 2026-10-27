'use strict';
const path = require('node:path');

// Load .env if present. Variables already set in the environment win.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

const env = process.env;
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v != null ? n : d;
};

module.exports = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'shop.db'),
  // The upstream panel. The key is read ONLY from the environment and never sent to browsers.
  upstreamUrl: env.UPSTREAM_URL || 'https://auraburma.com/api/v2',
  upstreamKey: env.UPSTREAM_API_KEY || '',
  // The single owner account. Created by the server at boot; it can never be created via signup.
  ownerEmail: String(env.OWNER_EMAIL || 'myokyawnaing287@gmail.com').trim().toLowerCase(),
  ownerUsername: String(env.OWNER_USERNAME || 'owner').trim().toLowerCase(),
  ownerPassword: env.OWNER_PASSWORD || '',
  cookieSecure: env.COOKIE_SECURE === 'true',
  trustProxy: env.TRUST_PROXY === 'true',
  // The upstream API has no webhooks, so we poll. Services: prices/limits. Orders: status/refunds.
  servicesSyncSec: Math.max(30, num(env.SERVICES_SYNC_SEC, 120)),
  syncIntervalSec: Math.max(10, num(env.SYNC_INTERVAL_SEC, 60)),
  sessionDays: num(env.SESSION_DAYS, 14),
};
