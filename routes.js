'use strict';
const cfg = require('./config');
const { db, tx, now, getSettings, setSetting, adjustBalance, audit } = require('./db');
const { HttpError } = require('./errors');
const { add, setCookie, NO_REPLY } = require('./http');
const events = require('./events');
const auth = require('./auth');
const { SUPPORTED_TYPES, pricing, perThousandMMK, effectiveMarkup } = require('./pricing');
const orders = require('./orders');
const deposits = require('./deposits');
const sync = require('./sync');
const upstream = require('./upstream');

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const likeEsc = (s) => s.replace(/[\\%_]/g, '\\$&');
const RESERVED_USERNAMES = new Set(['owner', 'admin', 'administrator', 'staff', 'support', 'root', 'system', 'moderator']);
const ORDER_STATUSES = ['Pending', 'In progress', 'Processing', 'Completed', 'Partial', 'Canceled', 'Failed', 'Review', 'Submitting'];

function pubUser(u) {
  return { id: u.id, username: u.username, email: u.email || null, role: u.role, balance_c: u.balance_c, totp_enabled: !!u.totp_enabled };
}
const page = (q) => ({ offset: Math.max(0, parseInt(q.offset, 10) || 0), limit: 20 });

// ---------------- public ----------------
add('GET', '/api/public', () => {
  const s = getSettings();
  return { site_name: s.site_name, announcement: s.announcement, support_contact: s.support_contact };
});

add('POST', '/api/signup', async (c) => {
  if (!auth.rateLimit('signup:' + c.ip, 30, 3600e3)) throw new HttpError(429, 'ခဏနေမှ ပြန်ကြိုးစားပါ');
  const username = String(c.body.username ?? '').trim().toLowerCase();
  const password = String(c.body.password ?? '');
  const email = str(c.body.email, 100).toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'အမည်သည် အင်္ဂလိပ်အက္ခရာ၊ ဂဏန်း၊ _ (၃ မှ ၂၀ လုံး) သာ ဖြစ်ရပါမည်');
  if (RESERVED_USERNAMES.has(username) || username === cfg.ownerUsername) throw new HttpError(409, 'ဤအမည်ကို အသုံးပြု၍မရပါ');
  if (password.length < 8 || password.length > 100) throw new HttpError(400, 'စကားဝှက်သည် အနည်းဆုံး ၈ လုံး ရှိရပါမည်');
  if (email && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email === cfg.ownerEmail)) {
    throw new HttpError(409, 'ဤ email ကို အသုံးပြု၍မရပါ');
  }
  const hash = await auth.hashPassword(password);
  let id;
  try {
    id = db.prepare('INSERT INTO users(username, email, pass_hash, created_at) VALUES(?,?,?,?)').run(username, email || null, hash, now()).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'ဤအမည် သို့မဟုတ် email ကို အသုံးပြုပြီးဖြစ်ပါသည်');
    throw e;
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const s = auth.createSession(u);
  setCookie(c.res, 'sid', s.token, s.maxAge);
  return { user: pubUser(u) };
});

add('POST', '/api/login', async (c) => {
  const ident = String(c.body.username ?? '').trim().toLowerCase();
  const password = String(c.body.password ?? '');
  if (!ident || !password || ident.length > 100 || password.length > 200) throw new HttpError(400, 'အချက်အလက် ပြည့်စုံစွာ ထည့်ပါ');
  if (!auth.rateLimit('login-ip:' + c.ip, 120, 600e3) || !auth.rateLimit('login-id:' + ident, 10, 600e3)) {
    throw new HttpError(429, 'ကြိုးစားမှု များလွန်းပါသည်၊ ၁၀ မိနစ်နေမှ ပြန်ကြိုးစားပါ');
  }
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR lower(email) = ?').get(ident, ident);
  const bad = new HttpError(401, 'အမည် သို့မဟုတ် စကားဝှက် မမှန်ပါ');
  if (!u) { await auth.dummyVerify(password); throw bad; }
  if (!(await auth.verifyPassword(password, u.pass_hash)) || u.is_banned) throw bad;
  if (u.totp_enabled) {
    const code = String(c.body.code ?? '').trim();
    if (!code) throw new HttpError(401, '2FA code ထည့်ပါ', 'totp_required');
    const step = auth.verifyTotp(u.totp_secret, code, u.totp_last_step);
    if (step == null) throw new HttpError(401, '2FA code မမှန်ပါ', 'totp_required');
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id);
  }
  const s = auth.createSession(u);
  setCookie(c.res, 'sid', s.token, s.maxAge);
  if (u.role !== 'user') audit(u, 'login', u.id, c.ip);
  return { user: pubUser(u) };
});

add('POST', '/api/logout', (c) => {
  auth.destroySession(c.token);
  setCookie(c.res, 'sid', '', 0);
});

// ---------------- account ----------------
add('GET', '/api/me', { auth: true }, (c) => ({ user: pubUser(db.prepare('SELECT * FROM users WHERE id = ?').get(c.user.id)) }));

add('POST', '/api/account/password', { auth: true }, async (c) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(c.user.id);
  const next = String(c.body.next ?? '');
  if (!auth.rateLimit('pw:' + u.id, 10, 600e3)) throw new HttpError(429, 'ခဏနေမှ ပြန်ကြိုးစားပါ');
  if (!(await auth.verifyPassword(String(c.body.current ?? ''), u.pass_hash))) throw new HttpError(400, 'လက်ရှိ စကားဝှက် မမှန်ပါ');
  if (next.length < 8 || next.length > 100) throw new HttpError(400, 'စကားဝှက်အသစ်သည် အနည်းဆုံး ၈ လုံး ရှိရပါမည်');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await auth.hashPassword(next), u.id);
  auth.destroyUserSessions(u.id, c.token);
  if (u.role !== 'user') audit(u, 'password.change', u.id);
});

// 2FA (staff and owner)
add('POST', '/api/account/2fa/setup', { role: 'staff' }, async (c) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(c.user.id);
  if (u.totp_enabled) throw new HttpError(409, '2FA ဖွင့်ပြီးသားဖြစ်ပါသည်');
  if (!(await auth.verifyPassword(String(c.body.password ?? ''), u.pass_hash))) throw new HttpError(400, 'စကားဝှက် မမှန်ပါ');
  const secret = auth.newTotpSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?').run(secret, u.id);
  const issuer = encodeURIComponent(getSettings().site_name || 'Shop');
  return { secret, uri: `otpauth://totp/${issuer}:${encodeURIComponent(u.username)}?secret=${secret}&issuer=${issuer}` };
});

add('POST', '/api/account/2fa/enable', { role: 'staff' }, (c) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(c.user.id);
  if (!u.totp_secret || u.totp_enabled) throw new HttpError(400, 'အရင်ဆုံး setup လုပ်ပါ');
  const step = auth.verifyTotp(u.totp_secret, c.body.code, 0);
  if (step == null) throw new HttpError(400, 'code မမှန်ပါ');
  db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(step, u.id);
  audit(u, '2fa.enable', u.id);
});

add('POST', '/api/account/2fa/disable', { role: 'staff' }, async (c) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(c.user.id);
  if (!u.totp_enabled) throw new HttpError(400, '2FA မဖွင့်ထားပါ');
  if (!(await auth.verifyPassword(String(c.body.password ?? ''), u.pass_hash))) throw new HttpError(400, 'စကားဝှက် မမှန်ပါ');
  if (auth.verifyTotp(u.totp_secret, c.body.code, u.totp_last_step) == null) throw new HttpError(400, 'code မမှန်ပါ');
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(u.id);
  audit(u, '2fa.disable', u.id);
});

// ---------------- live updates (Server-Sent Events) ----------------
add('GET', '/api/events', { auth: true }, (c) => {
  c.req.socket.setTimeout(0);
  c.res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: do not buffer the stream
  });
  c.res.write('retry: 5000\n\n');
  events.subscribe(c.user, c.req, c.res);
  return NO_REPLY;
});

// Price/limit changes as customers should see them: in OUR selling price, never the upstream cost.
add('GET', '/api/updates', { auth: true }, () => {
  const p = pricing(getSettings());
  const rows = db.prepare(`SELECT ch.id, ch.service_id, ch.name, ch.kind, ch.old_value, ch.new_value, ch.created_at,
                                  sv.rate_usd, sv.markup_override, sv.custom_name, sv.enabled
                           FROM service_changes ch JOIN services sv ON sv.id = ch.service_id
                           WHERE sv.enabled = 1 AND ch.kind <> 'name'
                           ORDER BY ch.id DESC LIMIT 100`).all();
  const out = [];
  for (const r of rows) {
    const item = { id: r.id, service_id: r.service_id, name: r.custom_name || r.name, kind: r.kind, created_at: r.created_at };
    if (r.kind === 'rate') {
      const price = (rate) => Math.round(perThousandMMK({ rate_usd: Number(rate), markup_override: r.markup_override }, p) * 100) / 100;
      item.old = price(r.old_value);
      item.new = price(r.new_value);
      if (item.old === item.new) continue;
    } else if (r.kind === 'limits' || r.kind === 'flags') {
      item.old = r.old_value;
      item.new = r.new_value;
    }
    out.push(item);
  }
  return { updates: out };
});

// ---------------- customer: services & orders ----------------
add('GET', '/api/services', { auth: true }, () => {
  const s = getSettings();
  const p = pricing(s);
  const rows = db.prepare(`SELECT * FROM services
                           WHERE enabled = 1 AND missing = 0 AND type IN (${SUPPORTED_TYPES.map(() => '?').join(',')})
                           ORDER BY (SELECT MIN(id) FROM services s2 WHERE s2.category = services.category), id`).all(...SUPPORTED_TYPES);
  return {
    services: rows.map((r) => ({
      id: r.id,
      name: r.custom_name || r.name,
      category: r.category,
      type: r.type,
      min: r.min,
      max: r.max,
      refill: !!r.refill,
      cancel: !!r.cancel,
      description: r.description || '',
      per_thousand_mmk: Math.round(perThousandMMK(r, p) * 10000) / 10000,
    })),
  };
});

add('POST', '/api/orders', { auth: true }, async (c) => {
  if (!auth.rateLimit('order:' + c.user.id, 30, 60e3)) throw new HttpError(429, 'ခဏနေမှ ပြန်ကြိုးစားပါ');
  const order = await orders.createOrder(c.user, c.body);
  const bal = db.prepare('SELECT balance_c FROM users WHERE id = ?').get(c.user.id).balance_c;
  return { order, balance_c: bal };
});

add('GET', '/api/orders', { auth: true }, (c) => {
  const { offset, limit } = page(c.query);
  const where = ['o.user_id = ?'];
  const args = [c.user.id];
  const status = String(c.query.status || '');
  if (ORDER_STATUSES.includes(status)) { where.push('o.status = ?'); args.push(status); }
  const q = String(c.query.q || '').trim().slice(0, 100);
  if (q) {
    if (/^\d{1,12}$/.test(q)) { where.push("(o.id = ? OR o.link LIKE ? ESCAPE '\\')"); args.push(Number(q), `%${likeEsc(q)}%`); }
    else { where.push("o.link LIKE ? ESCAPE '\\'"); args.push(`%${likeEsc(q)}%`); }
  }
  const rows = db.prepare(`${orders.ORDER_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
  return { orders: rows.slice(0, limit).map(orders.publicOrder), has_more: rows.length > limit };
});

add('POST', '/api/orders/:id/refill', { auth: true }, async (c) => ({ order: await orders.requestRefill(c.user, Number(c.params.id)) }));
add('POST', '/api/orders/:id/cancel', { auth: true }, async (c) => {
  const r = await orders.requestCancel(c.user, Number(c.params.id));
  sync.syncOrders().catch(() => {});
  return r;
});

// ---------------- customer: funds ----------------
add('GET', '/api/payment-info', { auth: true }, () => {
  const s = getSettings();
  return {
    accounts: deposits.paymentAccounts(s).filter((a) => a.number).map((a) => ({ method: a.method, label: a.label, number: a.number, holder: a.holder })),
    min_deposit_mmk: Number(s.min_deposit_mmk) || 1000,
  };
});
add('GET', '/api/deposits', { auth: true }, (c) => ({
  deposits: db.prepare('SELECT id, amount_c, method, txn_ref, status, admin_note, created_at FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(c.user.id),
}));
add('POST', '/api/deposits', { auth: true }, (c) => {
  if (!auth.rateLimit('dep:' + c.user.id, 20, 3600e3)) throw new HttpError(429, 'ခဏနေမှ ပြန်ကြိုးစားပါ');
  return deposits.createDeposit(c.user, c.body);
});

// ---------------- staff (staff + owner) ----------------
add('GET', '/api/staff/summary', { role: 'staff' }, () => ({
  pending_deposits: db.prepare("SELECT COUNT(*) AS n FROM deposits WHERE status = 'pending'").get().n,
  review_orders: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('Review','Submitting')").get().n,
}));

add('GET', '/api/staff/deposits', { role: 'staff' }, (c) => {
  const status = ['pending', 'approved', 'rejected'].includes(c.query.status) ? c.query.status : 'pending';
  const { offset, limit } = page(c.query);
  const rows = db.prepare(`SELECT d.id, d.user_id, u.username, d.amount_c, d.method, d.txn_ref, d.note, d.status, d.admin_note, d.created_at, d.decided_at
                           FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = ? ORDER BY d.id DESC LIMIT ? OFFSET ?`).all(status, limit + 1, offset);
  return { deposits: rows.slice(0, limit), has_more: rows.length > limit };
});
add('POST', '/api/staff/deposits/:id/approve', { role: 'staff' }, (c) => deposits.approveDeposit(c.user, Number(c.params.id), c.body.amount));
add('POST', '/api/staff/deposits/:id/reject', { role: 'staff' }, (c) => { deposits.rejectDeposit(c.user, Number(c.params.id), c.body.reason); });

add('GET', '/api/staff/orders', { role: 'staff' }, (c) => {
  const { offset, limit } = page(c.query);
  const where = ['1=1'];
  const args = [];
  const status = String(c.query.status || '');
  if (status === 'attention') where.push("o.status IN ('Review','Submitting')");
  else if (ORDER_STATUSES.includes(status)) { where.push('o.status = ?'); args.push(status); }
  const q = String(c.query.q || '').trim().slice(0, 100);
  if (q) {
    if (/^\d{1,12}$/.test(q)) { where.push("(o.id = ? OR o.upstream_order_id = ? OR u.username = ?)"); args.push(Number(q), q, q.toLowerCase()); }
    else { where.push("(u.username = ? OR o.link LIKE ? ESCAPE '\\')"); args.push(q.toLowerCase(), `%${likeEsc(q)}%`); }
  }
  const rows = db.prepare(`SELECT o.id, o.user_id, u.username, o.service_id, o.service_name, o.link, o.quantity, o.charge_c, o.refunded_c, o.status,
                                  o.upstream_order_id, o.upstream_charge_usd, o.note, o.created_at
                           FROM orders o JOIN users u ON u.id = o.user_id WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
  return { orders: rows.slice(0, limit), has_more: rows.length > limit };
});
add('POST', '/api/staff/orders/:id/resolve', { role: 'staff' }, (c) => {
  orders.resolveStuckOrder(c.user, Number(c.params.id), String(c.body.action ?? ''), c.body.upstream_order_id);
});

add('GET', '/api/staff/users', { role: 'staff' }, (c) => {
  const { offset, limit } = page(c.query);
  const q = String(c.query.q || '').trim().toLowerCase().slice(0, 100);
  const where = q ? "WHERE username LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'" : '';
  const args = q ? [`%${likeEsc(q)}%`, `%${likeEsc(q)}%`] : [];
  const rows = db.prepare(`SELECT id, username, email, role, balance_c, is_banned, created_at FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
  return { users: rows.slice(0, limit), has_more: rows.length > limit };
});

add('POST', '/api/staff/users/:id/ban', { role: 'staff' }, (c) => {
  const id = Number(c.params.id);
  const t = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
  if (!t) throw new HttpError(404, 'မတွေ့ပါ');
  if (t.role === 'owner' || t.id === c.user.id) throw new HttpError(403, 'ဤအကောင့်ကို ပိတ်၍မရပါ');
  if (t.role === 'staff' && c.user.role !== 'owner') throw new HttpError(403, 'Owner သာ staff ကို ပိတ်နိုင်ပါသည်');
  const banned = c.body.banned ? 1 : 0;
  tx(() => {
    db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(banned, id);
    if (banned) auth.destroyUserSessions(id);
    audit(c.user, banned ? 'user.ban' : 'user.unban', id, t.username);
  });
});

// ---------------- owner only ----------------
const REV = "CASE WHEN status = 'Failed' THEN 0 ELSE charge_c - refunded_c END";
const COST = "CASE WHEN status IN ('Canceled','Failed') THEN 0 ELSE COALESCE(upstream_charge_usd, cost_usd_est) * fx END";
const YGN = "'+390 minutes'"; // Myanmar time (UTC+6:30) for day boundaries

function money(whereSql, args = []) {
  const r = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(${REV}), 0) AS revenue_c, COALESCE(SUM(${COST}), 0) AS cost_mmk
                        FROM orders WHERE status NOT IN ('Failed') ${whereSql}`).get(...args);
  return { orders: r.orders, revenue_c: r.revenue_c, profit_c: Math.round(r.revenue_c - r.cost_mmk * 100) };
}

add('GET', '/api/owner/overview', { role: 'owner' }, async () => {
  const s = getSettings();
  const p = pricing(s);
  const t = now();
  const today = money(`AND date(created_at, 'unixepoch', ${YGN}) = date('now', ${YGN})`);
  const d30 = money('AND created_at >= ?', [t - 30 * 86400]);
  const all = money('');
  const series = db.prepare(`SELECT date(created_at, 'unixepoch', ${YGN}) AS day, COUNT(*) AS orders,
                                    COALESCE(SUM(${REV}), 0) AS revenue_c, COALESCE(SUM(${COST}), 0) AS cost_mmk
                             FROM orders WHERE status <> 'Failed' AND created_at >= ?
                             GROUP BY day ORDER BY day`).all(t - 14 * 86400)
    .map((r) => ({ day: r.day, orders: r.orders, revenue_c: r.revenue_c, profit_c: Math.round(r.revenue_c - r.cost_mmk * 100) }));
  const top = db.prepare(`SELECT service_name, COUNT(*) AS orders, COALESCE(SUM(${REV}), 0) AS revenue_c
                          FROM orders WHERE status <> 'Failed' AND created_at >= ? GROUP BY service_id ORDER BY revenue_c DESC LIMIT 5`).all(t - 30 * 86400);
  const liabilities = db.prepare('SELECT COALESCE(SUM(balance_c), 0) AS c FROM users').get().c; // money customers hold with us
  const counts = {
    users: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'user'").get().n,
    staff: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'staff'").get().n,
    pending_deposits: db.prepare("SELECT COUNT(*) AS n FROM deposits WHERE status = 'pending'").get().n,
    pending_deposit_sum_c: db.prepare("SELECT COALESCE(SUM(amount_c), 0) AS c FROM deposits WHERE status = 'pending'").get().c,
    review_orders: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('Review','Submitting')").get().n,
    failed_24h: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'Failed' AND created_at >= ?").get(t - 86400).n,
    active_orders: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('Pending','In progress','Processing')").get().n,
  };
  let up = { configured: !!cfg.upstreamKey };
  if (cfg.upstreamKey) {
    try {
      const b = await upstream.balance();
      const usd = Number(b.balance);
      up = { configured: true, balance: usd, currency: b.currency || 'USD', balance_mmk: String(b.currency || 'USD').toUpperCase() === 'USD' ? Math.round(usd * p.fx) : null };
    } catch (e) {
      up = { configured: true, error: String(e.message).slice(0, 120) };
    }
  }
  return {
    today, last_30_days: d30, all_time: all, series, top_services: top, counts,
    customer_balances_c: liabilities,
    upstream: up,
    services_synced_at: Number(s.services_synced_at) || 0,
    changes_24h: db.prepare('SELECT COUNT(*) AS n FROM service_changes WHERE created_at >= ?').get(t - 86400).n,
    rate_increases_24h: db.prepare("SELECT COUNT(*) AS n FROM service_changes WHERE kind = 'rate' AND CAST(new_value AS REAL) > CAST(old_value AS REAL) AND created_at >= ?").get(t - 86400).n,
    sync_every_sec: { services: cfg.servicesSyncSec, orders: cfg.syncIntervalSec },
    owner_email: cfg.ownerEmail,
    low_balance_threshold_mmk: 10000,
  };
});

add('GET', '/api/owner/settings', { role: 'owner' }, () => {
  const s = getSettings();
  return {
    settings: {
      site_name: s.site_name,
      markup_percent: Number(s.markup_percent),
      usd_mmk: Number(s.usd_mmk),
      min_deposit_mmk: Number(s.min_deposit_mmk),
      announcement: s.announcement,
      support_contact: s.support_contact,
      payment_accounts: deposits.paymentAccounts(s),
    },
    upstream_configured: !!cfg.upstreamKey,
    upstream_url: cfg.upstreamUrl,
  };
});

add('POST', '/api/owner/settings', { role: 'owner' }, (c) => {
  const b = c.body;
  const next = {};
  if (b.site_name !== undefined) {
    next.site_name = str(b.site_name, 60);
    if (!next.site_name) throw new HttpError(400, 'ဆိုင်နာမည် ထည့်ပါ');
  }
  if (b.markup_percent !== undefined) {
    const v = Number(b.markup_percent);
    if (!Number.isFinite(v) || v < 0 || v > 1000) throw new HttpError(400, 'Markup % သည် 0 မှ 1000 အတွင်း ဖြစ်ရပါမည်');
    next.markup_percent = v;
  }
  if (b.usd_mmk !== undefined) {
    const v = Number(b.usd_mmk);
    if (!Number.isFinite(v) || v < 100 || v > 100000) throw new HttpError(400, 'USD rate မမှန်ကန်ပါ');
    next.usd_mmk = v;
  }
  if (b.min_deposit_mmk !== undefined) {
    const v = Number(b.min_deposit_mmk);
    if (!Number.isInteger(v) || v < 100 || v > 10000000) throw new HttpError(400, 'အနည်းဆုံးငွေဖြည့်ပမာဏ မမှန်ကန်ပါ');
    next.min_deposit_mmk = v;
  }
  if (b.announcement !== undefined) next.announcement = str(b.announcement, 500);
  if (b.support_contact !== undefined) next.support_contact = str(b.support_contact, 100);
  if (b.payment_accounts !== undefined) {
    if (!Array.isArray(b.payment_accounts) || b.payment_accounts.length > 6) throw new HttpError(400, 'ငွေပေးချေမှုအကောင့်များ မမှန်ကန်ပါ');
    const list = b.payment_accounts.map((a) => ({
      method: String(a.method ?? '').trim().toLowerCase(),
      label: str(a.label, 30),
      number: str(a.number, 30),
      holder: str(a.holder, 40),
    }));
    const seen = new Set();
    for (const a of list) {
      if (!/^[a-z0-9_]{2,12}$/.test(a.method) || !a.label || seen.has(a.method)) throw new HttpError(400, 'ငွေပေးချေမှုအကောင့်များ မမှန်ကန်ပါ');
      seen.add(a.method);
    }
    next.payment_accounts = JSON.stringify(list);
  }
  tx(() => {
    for (const [k, v] of Object.entries(next)) setSetting(k, v);
    audit(c.user, 'settings.update', null, Object.keys(next).join(','));
  });
});

add('POST', '/api/owner/sync', { role: 'owner' }, async (c) => {
  const what = String(c.body.what ?? '');
  const fn = { services: sync.syncServices, orders: sync.syncOrders, refills: sync.syncRefills }[what];
  if (!fn) throw new HttpError(400, 'what မမှန်ကန်ပါ');
  try {
    const r = await fn();
    audit(c.user, 'sync.' + what, null, JSON.stringify(r));
    return r;
  } catch (e) {
    throw new HttpError(502, 'Sync မအောင်မြင်ပါ: ' + String(e.message).slice(0, 150));
  }
});

add('GET', '/api/owner/services', { role: 'owner' }, (c) => {
  const p = pricing(getSettings());
  const q = String(c.query.q || '').trim().slice(0, 100);
  const where = q ? "WHERE name LIKE ? ESCAPE '\\' OR custom_name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR CAST(id AS TEXT) = ?" : '';
  const args = q ? [`%${likeEsc(q)}%`, `%${likeEsc(q)}%`, `%${likeEsc(q)}%`, q] : [];
  const rows = db.prepare(`SELECT * FROM services ${where} ORDER BY category, id LIMIT 1000`).all(...args);
  return {
    services: rows.map((r) => ({
      id: r.id, name: r.name, custom_name: r.custom_name, description: r.description, category: r.category, type: r.type,
      supported: SUPPORTED_TYPES.includes(r.type), min: r.min, max: r.max, refill: !!r.refill, cancel: !!r.cancel,
      enabled: !!r.enabled, missing: !!r.missing, rate_usd: r.rate_usd, markup_override: r.markup_override,
      markup_effective: effectiveMarkup(r, p), sell_per_thousand_mmk: Math.round(perThousandMMK(r, p) * 100) / 100,
      cost_per_thousand_mmk: Math.round(r.rate_usd * p.fx * 100) / 100,
    })),
  };
});

function markupValue(v) {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new HttpError(400, 'Markup % မမှန်ကန်ပါ');
  return n;
}

add('POST', '/api/owner/services/bulk', { role: 'owner' }, (c) => {
  const category = str(c.body.category, 200);
  if (!category) throw new HttpError(400, 'category ထည့်ပါ');
  const sets = [];
  const args = [];
  if (c.body.enabled !== undefined) { sets.push('enabled = ?'); args.push(c.body.enabled ? 1 : 0); }
  if (c.body.markup_override !== undefined) { sets.push('markup_override = ?'); args.push(markupValue(c.body.markup_override)); }
  if (!sets.length) throw new HttpError(400, 'ပြောင်းလဲရန် မရှိပါ');
  // Services this storefront cannot place stay disabled no matter what.
  const guard = c.body.enabled ? ` AND type IN (${SUPPORTED_TYPES.map(() => '?').join(',')})` : '';
  const extra = c.body.enabled ? SUPPORTED_TYPES : [];
  const r = db.prepare(`UPDATE services SET ${sets.join(', ')} WHERE category = ?${guard}`).run(...args, category, ...extra);
  audit(c.user, 'services.bulk', category, JSON.stringify({ enabled: c.body.enabled, markup: c.body.markup_override }));
  return { changed: r.changes };
});

add('POST', '/api/owner/services/:id', { role: 'owner' }, (c) => {
  const id = Number(c.params.id);
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!svc) throw new HttpError(404, 'မတွေ့ပါ');
  const sets = [];
  const args = [];
  const b = c.body;
  if (b.enabled !== undefined) {
    if (b.enabled && !SUPPORTED_TYPES.includes(svc.type)) throw new HttpError(400, `"${svc.type}" အမျိုးအစားကို ဤ website မှ မရောင်းနိုင်သေးပါ`);
    sets.push('enabled = ?'); args.push(b.enabled ? 1 : 0);
  }
  if (b.markup_override !== undefined) { sets.push('markup_override = ?'); args.push(markupValue(b.markup_override)); }
  if (b.custom_name !== undefined) { sets.push('custom_name = ?'); args.push(str(b.custom_name, 200) || null); }
  if (b.description !== undefined) { sets.push('description = ?'); args.push(str(b.description, 2000) || null); }
  if (!sets.length) throw new HttpError(400, 'ပြောင်းလဲရန် မရှိပါ');
  db.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  audit(c.user, 'service.update', id, Object.keys(b).join(','));
});

add('GET', '/api/owner/users/:id', { role: 'owner' }, (c) => {
  const id = Number(c.params.id);
  const u = db.prepare('SELECT id, username, email, role, balance_c, is_banned, totp_enabled, created_at FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'မတွေ့ပါ');
  return {
    user: u,
    orders: db.prepare('SELECT id, service_name, quantity, charge_c, refunded_c, status, created_at FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(id),
    ledger: db.prepare('SELECT delta_c, balance_after_c, reason, ref, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(id),
    deposits: db.prepare('SELECT id, amount_c, method, status, created_at FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(id),
  };
});

add('POST', '/api/owner/users/:id/adjust', { role: 'owner' }, (c) => {
  const id = Number(c.params.id);
  const amount = Number(c.body.amount);
  const reason = str(c.body.reason, 200);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 20000000) throw new HttpError(400, 'ငွေပမာဏ မမှန်ကန်ပါ');
  if (!reason) throw new HttpError(400, 'အကြောင်းရင်း ထည့်ပါ');
  try {
    return tx(() => {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'မတွေ့ပါ');
      const bal = adjustBalance(id, amount * 100, 'admin_adjust', reason);
      audit(c.user, 'balance.adjust', id, `${amount} ks: ${reason}`);
      return { balance_c: bal };
    });
  } catch (e) {
    if (/CHECK constraint/i.test(e.message)) throw new HttpError(400, 'လက်ကျန်ငွေ အနုတ်ဖြစ်သွားမည့်အတွက် မလုပ်နိုင်ပါ');
    throw e;
  }
});

add('POST', '/api/owner/users/:id/role', { role: 'owner' }, (c) => {
  const id = Number(c.params.id);
  const role = String(c.body.role ?? '');
  if (role !== 'staff' && role !== 'user') throw new HttpError(400, 'role မမှန်ကန်ပါ');
  const t = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
  if (!t) throw new HttpError(404, 'မတွေ့ပါ');
  if (t.role === 'owner') throw new HttpError(403, 'Owner ကို ပြောင်း၍မရပါ');
  tx(() => {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (role === 'user') auth.destroyUserSessions(id);
    audit(c.user, 'user.role', id, `${t.username} -> ${role}`);
  });
});

add('POST', '/api/owner/users/:id/password', { role: 'owner' }, async (c) => {
  const id = Number(c.params.id);
  const pw = String(c.body.password ?? '');
  if (pw.length < 8 || pw.length > 100) throw new HttpError(400, 'စကားဝှက်သည် အနည်းဆုံး ၈ လုံး ရှိရပါမည်');
  const t = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
  if (!t) throw new HttpError(404, 'မတွေ့ပါ');
  if (t.role === 'owner') throw new HttpError(403, 'Owner စကားဝှက်ကို ဤနေရာမှ ပြောင်း၍မရပါ');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await auth.hashPassword(pw), id);
  auth.destroyUserSessions(id);
  audit(c.user, 'user.password_reset', id, t.username);
});

// Raw upstream changes (USD cost) so the owner can see exactly what AuraBurma changed and what it does to margin.
add('GET', '/api/owner/changes', { role: 'owner' }, (c) => {
  const p = pricing(getSettings());
  const { offset } = page(c.query);
  const rows = db.prepare(`SELECT ch.id, ch.service_id, ch.name, ch.kind, ch.old_value, ch.new_value, ch.created_at, sv.enabled, sv.markup_override
                           FROM service_changes ch LEFT JOIN services sv ON sv.id = ch.service_id
                           ORDER BY ch.id DESC LIMIT 51 OFFSET ?`).all(offset);
  return {
    changes: rows.slice(0, 50).map((r) => {
      const o = { id: r.id, service_id: r.service_id, name: r.name, kind: r.kind, old: r.old_value, new: r.new_value, enabled: !!r.enabled, created_at: r.created_at };
      if (r.kind === 'rate') {
        const a = Number(r.old_value);
        const b = Number(r.new_value);
        o.change_pct = a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : null;
        o.new_cost_per_thousand_mmk = Math.round(b * p.fx * 100) / 100;
        o.new_sell_per_thousand_mmk = Math.round(perThousandMMK({ rate_usd: b, markup_override: r.markup_override }, p) * 100) / 100;
      }
      return o;
    }),
    has_more: rows.length > 50,
  };
});

add('GET', '/api/owner/audit', { role: 'owner' }, (c) => {
  const { offset } = page(c.query);
  const rows = db.prepare('SELECT id, actor_name, action, target, detail, created_at FROM audit ORDER BY id DESC LIMIT 51 OFFSET ?').all(offset);
  return { entries: rows.slice(0, 50), has_more: rows.length > 50 };
});
