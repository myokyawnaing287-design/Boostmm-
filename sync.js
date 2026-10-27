'use strict';
const cfg = require('./config');
const { db, tx, now, setSetting } = require('./db');
const { purgeExpiredSessions } = require('./auth');
const { SUPPORTED_TYPES } = require('./pricing');
const { applyStatus, normalizeStatus } = require('./orders');
const upstream = require('./upstream');
const events = require('./events');

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

// One chain per job so a manual run and the timer never overlap.
function serial() {
  let chain = Promise.resolve();
  return (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
}
const runServices = serial();
const runOrders = serial();
const runRefills = serial();

async function syncServicesNow() {
  const list = await upstream.services();
  if (!Array.isArray(list) || list.length === 0) throw new Error('upstream returned no services');
  const t = now();
  let count = 0;
  let changes = 0;

  tx(() => {
    const prevMap = new Map(db.prepare('SELECT id, name, rate_usd, min, max, refill, cancel, missing FROM services').all().map((r) => [r.id, r]));
    const firstImport = prevMap.size === 0; // do not flood the change feed on the very first import
    const log = db.prepare('INSERT INTO service_changes(service_id, name, kind, old_value, new_value, created_at) VALUES(?,?,?,?,?,?)');
    const note = (id, name, kind, a, b) => {
      if (firstImport) return;
      log.run(id, name, kind, a == null ? null : String(a), b == null ? null : String(b), t);
      changes += 1;
    };

    const up = db.prepare(`INSERT INTO services(id, name, type, category, rate_usd, min, max, refill, cancel, enabled, missing, updated_at)
                           VALUES(?,?,?,?,?,?,?,?,?,?,0,?)
                           ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, category = excluded.category,
                             rate_usd = excluded.rate_usd, min = excluded.min, max = excluded.max, refill = excluded.refill,
                             cancel = excluded.cancel, missing = 0, updated_at = excluded.updated_at`);
    const seen = new Set();
    for (const s of list) {
      const id = Number(s.service);
      const rate = Number(s.rate);
      const min = Number(s.min);
      const max = Number(s.max);
      const name = String(s.name ?? '').trim();
      if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(rate) || rate < 0 || !Number.isFinite(min) || !Number.isFinite(max) || !name) continue;
      const type = String(s.type || 'Default');
      const minI = Math.max(1, Math.floor(min));
      const maxI = Math.max(1, Math.floor(max));
      const refill = truthy(s.refill) ? 1 : 0;
      const cancel = truthy(s.cancel) ? 1 : 0;

      const prev = prevMap.get(id);
      if (!prev) {
        note(id, name, 'new', null, rate);
      } else {
        if (prev.missing) note(id, name, 'restored', null, rate);
        if (Math.abs(prev.rate_usd - rate) > 1e-9) note(id, name, 'rate', prev.rate_usd, rate);
        if (prev.min !== minI || prev.max !== maxI) note(id, name, 'limits', `${prev.min}-${prev.max}`, `${minI}-${maxI}`);
        if (prev.refill !== refill || prev.cancel !== cancel) {
          note(id, name, 'flags', `refill:${prev.refill} cancel:${prev.cancel}`, `refill:${refill} cancel:${cancel}`);
        }
        if (prev.name !== name) note(id, name, 'name', prev.name, name);
      }
      // New services are visible by default only when this storefront can actually place them.
      seen.add(id);
      up.run(id, name, type, String(s.category || 'Other').trim() || 'Other', rate, minI, maxI, refill, cancel, SUPPORTED_TYPES.includes(type) ? 1 : 0, t);
      count += 1;
    }
    if (count === 0) throw new Error('no valid services in upstream response');

    const markGone = db.prepare('UPDATE services SET missing = 1 WHERE id = ?');
    for (const row of db.prepare('SELECT id, name FROM services WHERE missing = 0').all()) {
      if (seen.has(row.id)) continue;
      note(row.id, row.name, 'removed', null, null);
      markGone.run(row.id);
    }
    db.prepare('DELETE FROM service_changes WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM service_changes) - 5000').run();
    setSetting('services_synced_at', t);
  });

  // Tell every open app: prices/services moved, re-fetch.
  if (changes > 0) events.publish('services', { changes });
  return { count, changes };
}

async function syncOrdersNow() {
  // Orders left in "Submitting" (crash mid-request) need a human decision.
  const stuck = db.prepare("UPDATE orders SET status = 'Review', note = 'interrupted while submitting', updated_at = ? WHERE status = 'Submitting' AND created_at < ?").run(now(), now() - 120);
  if (stuck.changes) events.publish('staff', { what: 'review' }, { roles: ['staff', 'owner'] });

  const rows = db.prepare(`SELECT id, upstream_order_id FROM orders
                           WHERE upstream_order_id IS NOT NULL AND status IN ('Pending','In progress','Processing')
                           ORDER BY id LIMIT 500`).all();
  let updated = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const resp = await upstream.status(chunk.map((r) => r.upstream_order_id));
    for (const r of chunk) {
      const info = resp && resp[r.upstream_order_id];
      if (!info) continue;
      if (info.error) {
        db.prepare("UPDATE orders SET status = 'Review', note = ?, updated_at = ? WHERE id = ?").run('upstream status error: ' + String(info.error).slice(0, 200), now(), r.id);
        events.publish('staff', { what: 'review' }, { roles: ['staff', 'owner'] });
        continue;
      }
      if (!normalizeStatus(info.status)) continue;
      if (applyStatus(r.id, info)) updated += 1;
    }
  }
  return { checked: rows.length, updated };
}

async function syncRefillsNow() {
  const rows = db.prepare(`SELECT id, user_id, refill_id FROM orders
                           WHERE refill_id IS NOT NULL AND (refill_status IS NULL OR refill_status NOT IN ('Completed','Rejected'))
                           ORDER BY id LIMIT 200`).all();
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const resp = await upstream.refillStatus(chunk.map((r) => r.refill_id));
    for (const r of chunk) {
      const info = resp[r.refill_id];
      const st = info && typeof info.status === 'string' ? info.status.slice(0, 40) : null;
      if (st) {
        db.prepare('UPDATE orders SET refill_status = ?, updated_at = ? WHERE id = ?').run(st, now(), r.id);
        events.publish('orders', { id: r.id }, { userId: r.user_id });
      }
    }
  }
  return { checked: rows.length };
}

const syncServices = () => runServices(syncServicesNow);
const syncOrders = () => runOrders(syncOrdersNow);
const syncRefills = () => runRefills(syncRefillsNow);

const timers = [];
function start() {
  const quiet = (name, fn) => () => fn().catch((e) => console.error(`[sync:${name}] ${e.message}`));
  timers.push(setInterval(() => purgeExpiredSessions(), 3600 * 1000));
  if (!cfg.upstreamKey) {
    console.warn('[sync] UPSTREAM_API_KEY is not set: services/orders will not sync until it is configured.');
    return;
  }
  quiet('services', syncServices)();
  timers.push(setInterval(quiet('services', syncServices), cfg.servicesSyncSec * 1000));
  timers.push(setInterval(quiet('orders', syncOrders), cfg.syncIntervalSec * 1000));
  timers.push(setInterval(quiet('refills', syncRefills), 5 * 60 * 1000));
}
function stop() {
  for (const t of timers) clearInterval(t);
}

module.exports = { start, stop, syncServices, syncOrders, syncRefills };
