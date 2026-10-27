'use strict';
// End-to-end test: real server process + in-process mock of the upstream panel.
// Run: node test/e2e.js
process.env.DB_PATH = ':memory:'; // only affects modules required in THIS process (auth helpers)

const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createMock } = require('./mock-upstream');
const auth = require('../src/auth');

const KEY = 'testkey-123';
const OWNER_PW = 'OwnerPass-12345';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodies = [];
let failed = 0;
let passed = 0;

function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name); } catch (e) { failed += 1; console.log('  FAIL ' + name + '\n         ' + String(e.message).split('\n').slice(0, 3).join(' | ')); }
}
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, url, body, { csrf = true } = {}) {
    const headers = {};
    if (csrf) headers['X-Requested-With'] = 'shop';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(this.base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) { const first = sc.split(';')[0]; this.cookie = first === 'sid=' ? '' : first; }
    const text = await res.text();
    bodies.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  }
  get(url) { return this.req('GET', url); }
  post(url, body = {}) { return this.req('POST', url, body); }
}

async function main() {
  const mockPort = await freePort();
  const mock = createMock(KEY);
  await new Promise((r) => mock.server.listen(mockPort, '127.0.0.1', r));

  const port = await freePort();
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reseller-e2e-')), 'test.db');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbFile,
      UPSTREAM_URL: `http://127.0.0.1:${mockPort}/api/v2`, UPSTREAM_API_KEY: KEY,
      OWNER_PASSWORD: OWNER_PW, SERVICES_SYNC_SEC: '3600', SYNC_INTERVAL_SEC: '3600',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  try {
    await run(base, mock);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    mock.server.close();
  }

  // ---- invariants straight from the database ----
  console.log('\nDatabase invariants');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const bad = db.prepare(`SELECT u.username, u.balance_c, COALESCE(SUM(l.delta_c), 0) AS ledger_sum
                          FROM users u LEFT JOIN ledger l ON l.user_id = u.id GROUP BY u.id
                          HAVING u.balance_c <> ledger_sum`).all();
  check('every user balance equals the sum of their ledger', () => assert.deepEqual(bad, []));
  const over = db.prepare('SELECT id FROM orders WHERE refunded_c > charge_c').all();
  check('no order was ever refunded more than it was charged', () => assert.deepEqual(over, []));
  const neg = db.prepare('SELECT id FROM users WHERE balance_c < 0').all();
  check('no negative balances', () => assert.deepEqual(neg, []));
  const owners = db.prepare("SELECT username, email FROM users WHERE role = 'owner'").all();
  check('exactly one owner, bound to the owner email', () => {
    assert.equal(owners.length, 1);
    assert.equal(owners[0].email, 'myokyawnaing287@gmail.com');
  });
  const leaked = bodies.filter((b) => b.includes(KEY));
  check('upstream API key never appears in any HTTP response', () => assert.equal(leaked.length, 0));
  const plaintext = bodies.filter((b) => b.includes(OWNER_PW) || b.includes('pass_hash'));
  check('no password or hash appears in any HTTP response', () => assert.equal(plaintext.length, 0));
  db.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\n--- server log ---\n' + serverLog); process.exit(1); }
}

async function run(base, mock) {
  const owner = new Client(base);
  const alice = new Client(base);
  const bob = new Client(base);
  const anon = new Client(base);

  console.log('Boot & access control');
  for (let i = 0; i < 100; i += 1) {
    const r = await owner.post('/api/login', { username: 'owner', password: OWNER_PW });
    if (r.status === 200) break;
    await sleep(100);
  }
  let r = await owner.get('/api/me');
  check('owner can log in with the generated owner account', () => { assert.equal(r.json.user.role, 'owner'); assert.equal(r.json.user.email, 'myokyawnaing287@gmail.com'); });
  const ownerByEmail = new Client(base);
  r = await ownerByEmail.post('/api/login', { username: 'MyoKyawNaing287@gmail.com', password: OWNER_PW });
  check('owner can also log in with the owner email', () => assert.equal(r.status, 200));
  r = await anon.post('/api/login', { username: 'owner', password: 'wrong-password' });
  check('wrong owner password is rejected', () => assert.equal(r.status, 401));

  r = await anon.post('/api/signup', { username: 'mallory', password: 'password123', email: 'MyoKyawNaing287@gmail.com' });
  check('cannot sign up with the owner email (owner cannot be hijacked)', () => assert.equal(r.status, 409));
  r = await anon.post('/api/signup', { username: 'admin', password: 'password123' });
  check('reserved usernames are refused', () => assert.equal(r.status, 409));
  r = await alice.post('/api/signup', { username: 'alice', password: 'alice-pass-1', email: 'alice@example.com' });
  check('normal signup works and is a plain user', () => { assert.equal(r.status, 200); assert.equal(r.json.user.role, 'user'); });
  r = await bob.post('/api/signup', { username: 'bob', password: 'bob-pass-123' });
  check('second signup works', () => assert.equal(r.status, 200));

  r = await anon.get('/api/owner/overview');
  check('owner API requires login (401)', () => assert.equal(r.status, 401));
  r = await alice.get('/api/owner/overview');
  check('a normal user cannot reach owner API (403)', () => assert.equal(r.status, 403));
  r = await alice.get('/api/staff/deposits');
  check('a normal user cannot reach staff API (403)', () => assert.equal(r.status, 403));
  r = await alice.post('/api/owner/users/2/adjust', { amount: 1000000, reason: 'give me money' });
  check('a normal user cannot adjust balances', () => assert.equal(r.status, 403));
  r = await anon.req('POST', '/api/login', { username: 'alice', password: 'alice-pass-1' }, { csrf: false });
  check('state-changing request without the CSRF header is refused', () => assert.equal(r.status, 403));
  r = await anon.get('/api/events');
  check('live-update stream requires login', () => assert.equal(r.status, 401));

  console.log('\nServices & pricing');
  let services = [];
  for (let i = 0; i < 100; i += 1) {
    r = await alice.get('/api/services');
    services = r.json.services;
    if (services.length) break;
    await sleep(100);
  }
  check('services were imported from upstream at boot', () => assert.ok(services.length >= 2));
  check('unsupported service types are hidden from customers', () => assert.ok(!services.some((s) => s.id === 3)));
  const s1 = services.find((s) => s.id === 1);
  check('selling price = rate x USD rate x (1 + markup): 0.90 x 4700 x 1.30 = 5499 ks/1000', () => assert.equal(s1.per_thousand_mmk, 5499));
  check('customers never see upstream cost fields', () => assert.ok(!('rate_usd' in s1) && !('rate' in s1)));
  r = await owner.get('/api/owner/overview');
  check('first import does not flood the change feed', () => assert.equal(r.json.changes_24h, 0));
  check('owner sees upstream balance', () => { assert.equal(r.json.upstream.balance, 100.5); assert.equal(r.json.upstream.balance_mmk, Math.round(100.5 * 4700)); });
  r = await owner.post('/api/owner/services/3', { enabled: true });
  check('owner cannot enable a service type this site cannot place', () => assert.equal(r.status, 400));

  console.log('\nDeposits');
  r = await alice.post('/api/deposits', { method: 'wave', amount: 10000, txnRef: 'ABC12345' });
  check('deposit refused while no payment account is configured', () => assert.equal(r.status, 400));
  r = await owner.post('/api/owner/settings', { site_name: 'Test Shop', payment_accounts: [{ method: 'wave', label: 'Wave Pay', number: '09123456789', holder: 'Shop Owner' }] });
  check('owner can configure payment accounts', () => assert.equal(r.status, 200));
  r = await alice.post('/api/deposits', { method: 'wave', amount: 10000, txnRef: 'ABC12345', note: 'hi' });
  check('customer can submit a deposit', () => assert.equal(r.status, 200));
  const dep1 = r.json.id;
  r = await bob.post('/api/deposits', { method: 'wave', amount: 5000, txnRef: 'abc12345' });
  check('the same transaction id cannot be claimed twice', () => assert.equal(r.status, 409));
  r = await alice.post('/api/deposits', { method: 'wave', amount: 500, txnRef: 'LOWAMT01' });
  check('below-minimum deposit is refused', () => assert.equal(r.status, 400));
  r = await alice.post(`/api/staff/deposits/${dep1}/approve`);
  check('customer cannot approve their own deposit', () => assert.equal(r.status, 403));
  r = await owner.post(`/api/staff/deposits/${dep1}/approve`);
  check('owner approves deposit', () => assert.equal(r.status, 200));
  r = await owner.post(`/api/staff/deposits/${dep1}/approve`);
  check('approving twice is refused (no double credit)', () => assert.equal(r.status, 409));
  r = await alice.get('/api/me');
  check('balance is credited exactly once', () => assert.equal(r.json.user.balance_c, 1000000));

  console.log('\nOrders');
  const order = (c, body) => c.post('/api/orders', body);
  r = await order(alice, { serviceId: 1, link: 'https://t.me/example', quantity: 100, requestId: 'req-aaaa-0001' });
  const o1 = r.json.order;
  check('order is placed and charged (100 x 5.499 ks = 549.90 ks)', () => { assert.equal(r.status, 200); assert.equal(o1.charge_c, 54990); assert.equal(o1.status, 'Pending'); assert.equal(r.json.balance_c, 945010); });
  r = await order(alice, { serviceId: 1, link: 'https://t.me/example', quantity: 100, requestId: 'req-aaaa-0001' });
  check('retrying the same request id does not double-charge (flaky mobile network)', () => { assert.equal(r.json.order.id, o1.id); assert.equal(r.json.balance_c, 945010); });
  r = await alice.get('/api/me');
  check('balance unchanged after the replay', () => assert.equal(r.json.user.balance_c, 945010));
  r = await order(alice, { serviceId: 1, link: 'https://t.me/example', quantity: 10000, requestId: 'req-aaaa-0002' });
  check('insufficient funds is refused with 402', () => assert.equal(r.status, 402));
  r = await order(alice, { serviceId: 1, link: 'https://t.me/example', quantity: 10, requestId: 'req-aaaa-0003' });
  check('quantity below minimum is refused', () => assert.equal(r.status, 400));
  r = await order(alice, { serviceId: 3, link: 'https://t.me/example', quantity: 10, requestId: 'req-aaaa-0004' });
  check('unsupported service cannot be ordered', () => assert.equal(r.status, 400));
  r = await order(alice, { serviceId: 1, link: 'not a link with spaces', quantity: 100, requestId: 'req-aaaa-0005' });
  check('malformed link is refused', () => assert.equal(r.status, 400));
  r = await alice.get('/api/me');
  check('refused orders never touched the balance', () => assert.equal(r.json.user.balance_c, 945010));

  // Partial: upstream delivered 60 of 100
  const up1 = mock.state.orders.get(String(1000));
  up1.status = 'Partial'; up1.remains = 40;
  r = await owner.post('/api/owner/sync', { what: 'orders' });
  check('status sync reports the update', () => assert.equal(r.json.updated, 1));
  r = await alice.get('/api/orders');
  const po = r.json.orders.find((o) => o.id === o1.id);
  check('partial order refunds the undelivered share (40% of 549.90 = 219.96 ks)', () => { assert.equal(po.status, 'Partial'); assert.equal(po.refunded_c, 21996); });
  await owner.post('/api/owner/sync', { what: 'orders' });
  r = await alice.get('/api/me');
  check('syncing again does not refund twice', () => assert.equal(r.json.user.balance_c, 945010 + 21996));

  // Canceled upstream -> full refund
  r = await order(alice, { serviceId: 1, link: 'https://t.me/example2', quantity: 100, requestId: 'req-aaaa-0006' });
  const o2 = r.json.order;
  mock.state.orders.get(String(1001)).status = 'Canceled';
  await owner.post('/api/owner/sync', { what: 'orders' });
  r = await alice.get('/api/orders?status=Canceled');
  check('upstream cancellation refunds the full charge', () => { assert.equal(r.json.orders[0].id, o2.id); assert.equal(r.json.orders[0].refunded_c, o2.charge_c); });
  r = await alice.get('/api/me');
  check('balance back to where it was before the cancelled order', () => assert.equal(r.json.user.balance_c, 945010 + 21996));
  const balBefore = r.json.user.balance_c;

  // Upstream definitively rejects
  mock.state.addMode = 'error';
  r = await order(alice, { serviceId: 1, link: 'https://t.me/example3', quantity: 100, requestId: 'req-aaaa-0007' });
  check('upstream rejection marks the order Failed', () => assert.equal(r.json.order.status, 'Failed'));
  check('and refunds the customer automatically', () => assert.equal(r.json.order.refunded_c, r.json.order.charge_c));
  r = await alice.get('/api/me');
  check('balance unchanged after a rejected order', () => assert.equal(r.json.user.balance_c, balBefore));
  r = await owner.get('/api/owner/overview');
  check('owner dashboard counts the failure (e.g. upstream out of funds)', () => assert.equal(r.json.counts.failed_24h, 1));

  // Ambiguous outcome: connection dropped mid-request
  mock.state.addMode = 'drop';
  r = await order(alice, { serviceId: 1, link: 'https://t.me/example4', quantity: 100, requestId: 'req-aaaa-0008' });
  const o4 = r.json.order;
  check('dropped connection => order held for review (not auto-refunded, not lost)', () => assert.equal(o4.status, 'Review'));
  r = await alice.get('/api/me');
  check('money stays held while the outcome is unknown', () => assert.equal(r.json.user.balance_c, balBefore - 54990));
  r = await owner.get('/api/staff/summary');
  check('review queue shows it to staff/owner', () => assert.equal(r.json.review_orders, 1));
  r = await alice.post(`/api/staff/orders/${o4.id}/resolve`, { action: 'refund' });
  check('customers cannot resolve review orders', () => assert.equal(r.status, 403));
  r = await owner.post(`/api/staff/orders/${o4.id}/resolve`, { action: 'refund' });
  check('owner refunds the held order', () => assert.equal(r.status, 200));
  r = await owner.post(`/api/staff/orders/${o4.id}/resolve`, { action: 'refund' });
  check('a review order can only be resolved once', () => assert.equal(r.status, 409));
  r = await alice.get('/api/me');
  check('balance restored after refund', () => assert.equal(r.json.user.balance_c, balBefore));
  mock.state.addMode = 'drop';
  r = await order(alice, { serviceId: 1, link: 'https://t.me/example5', quantity: 100, requestId: 'req-aaaa-0009' });
  const o5 = r.json.order;
  mock.state.addMode = 'ok';
  r = await owner.post(`/api/staff/orders/${o5.id}/resolve`, { action: 'confirm', upstream_order_id: '555' });
  check('owner can attach the real upstream id to a held order', () => assert.equal(r.status, 200));
  r = await alice.get('/api/orders?status=Pending');
  check('confirmed order resumes as Pending', () => assert.ok(r.json.orders.some((o) => o.id === o5.id)));

  // Custom comments: quantity is derived from the lines, and no quantity is sent upstream
  const lines = Array.from({ length: 10 }, (_, i) => `nice post ${i + 1}`).join('\n');
  r = await order(alice, { serviceId: 2, link: 'https://t.me/example/6', comments: lines, quantity: 9999, requestId: 'req-aaaa-0010' });
  check('custom comments: quantity comes from the number of lines (10 x 48.88 ks = 488.80 ks)', () => { assert.equal(r.status, 200); assert.equal(r.json.order.quantity, 10); assert.equal(r.json.order.charge_c, 48880); });
  const lastAdd = mock.state.calls.filter((c) => c.action === 'add').pop();
  check('comments are forwarded and the client-supplied quantity is ignored', () => { assert.equal(lastAdd.comments, lines); assert.equal(lastAdd.quantity, undefined); });

  // Refill: place a fresh order, upstream completes it
  r = await order(alice, { serviceId: 1, link: 'https://t.me/refillme', quantity: 100, requestId: 'req-aaaa-0012' });
  check('fresh order for refill test placed', () => assert.equal(r.status, 200));
  for (const o of mock.state.orders.values()) if (o.status === 'Pending') o.status = 'Completed';

  console.log('\nLive updates when the upstream changes');
  await owner.post('/api/owner/sync', { what: 'orders' });
  r = await alice.get('/api/orders?status=Completed');
  const completed = r.json.orders[0];
  check('completed refillable order offers refill', () => assert.equal(completed.can_refill, true));
  r = await alice.post(`/api/orders/${completed.id}/refill`);
  check('refill is requested upstream', () => { assert.equal(r.status, 200); assert.equal(r.json.order.refill_status, 'Pending'); });
  r = await alice.post(`/api/orders/${completed.id}/refill`);
  check('a second refill within 24h is refused', () => assert.equal(r.status, 429));

  // SSE: alice has the app open; upstream raises a price and adds a service.
  const ac = new AbortController();
  const stream = await fetch(base + '/api/events', { headers: { Cookie: alice.cookie }, signal: ac.signal });
  check('live stream opens for a logged-in customer', () => assert.equal(stream.status, 200));
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let streamed = '';
  const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; streamed += dec.decode(value); } })().catch(() => {});
  await sleep(200);

  mock.state.services[0].rate = '1.20'; // 0.90 -> 1.20 USD per 1000
  mock.state.services.push({ service: 5, name: 'Brand new', type: 'Default', category: 'TikTok', rate: '0.5', min: '10', max: '1000', refill: false, cancel: false });
  mock.state.services = mock.state.services.filter((s) => s.service !== 4); // service 4 disappears upstream
  r = await owner.post('/api/owner/sync', { what: 'services' });
  check('services sync detects the upstream changes', () => assert.ok(r.json.changes >= 3));
  await sleep(300);
  check('open apps are told immediately (no refresh needed)', () => assert.ok(streamed.includes('event: services')));

  r = await alice.get('/api/services');
  const s1b = r.json.services.find((s) => s.id === 1);
  check('the new price is live: 1.20 x 4700 x 1.30 = 7332 ks/1000', () => assert.equal(s1b.per_thousand_mmk, 7332));
  check('a removed upstream service can no longer be ordered', () => assert.ok(!r.json.services.some((s) => s.id === 4)));
  r = await order(alice, { serviceId: 4, link: 'https://tiktok.com/x', quantity: 100, requestId: 'req-aaaa-0011' });
  check('ordering the removed service is refused server-side too', () => assert.equal(r.status, 400));
  r = await alice.get('/api/updates');
  const rateUpd = r.json.updates.find((u) => u.kind === 'rate' && u.service_id === 1);
  check('customer update feed shows OUR price change (5499 -> 7332)', () => { assert.equal(rateUpd.old, 5499); assert.equal(rateUpd.new, 7332); });
  check('customer feed never exposes upstream USD cost', () => assert.ok(!JSON.stringify(r.json).includes('0.9') && !JSON.stringify(r.json).includes('1.2,')));
  r = await owner.get('/api/owner/changes');
  const oc = r.json.changes.find((c) => c.kind === 'rate' && c.service_id === 1);
  check('owner feed shows raw upstream change with % and margin impact', () => { assert.equal(oc.old, '0.9'); assert.equal(oc.new, '1.2'); assert.equal(oc.change_pct, 33.3); assert.equal(oc.new_sell_per_thousand_mmk, 7332); });
  r = await owner.get('/api/owner/overview');
  check('overview flags rate increases', () => assert.ok(r.json.rate_increases_24h >= 1));

  // balance event when a deposit is approved
  streamed = '';
  r = await alice.post('/api/deposits', { method: 'wave', amount: 3000, txnRef: 'LIVE0001' });
  await owner.post(`/api/staff/deposits/${r.json.id}/approve`);
  await sleep(300);
  check('approving a deposit pushes a balance update to the customer', () => assert.ok(streamed.includes('event: balance')));
  ac.abort();
  await pump;

  console.log('\nRoles, 2FA, bans');
  r = await owner.get('/api/owner/users/2');
  check('owner can open a customer record with ledger', () => { assert.equal(r.json.user.username, 'alice'); assert.ok(r.json.ledger.length > 3); });
  r = await owner.post('/api/owner/users/3/role', { role: 'staff' });
  check('owner promotes bob to staff', () => assert.equal(r.status, 200));
  r = await bob.get('/api/staff/summary');
  check('staff can reach the staff queue', () => assert.equal(r.status, 200));
  r = await bob.get('/api/owner/overview');
  check('staff cannot reach the owner dashboard', () => assert.equal(r.status, 403));
  r = await bob.post('/api/owner/settings', { markup_percent: 0 });
  check('staff cannot change settings/prices', () => assert.equal(r.status, 403));
  r = await bob.post('/api/owner/users/2/adjust', { amount: 500000, reason: 'x' });
  check('staff cannot adjust balances', () => assert.equal(r.status, 403));
  r = await bob.post('/api/staff/users/1/ban', { banned: true });
  check('nobody can ban the owner', () => assert.equal(r.status, 403));
  r = await owner.post('/api/owner/users/1/role', { role: 'user' });
  check('the owner role cannot be changed', () => assert.equal(r.status, 403));

  r = await owner.post('/api/owner/users/2/adjust', { amount: -99999999, reason: 'overdraw' });
  check('balance cannot be pushed below zero', () => assert.equal(r.status, 400));
  r = await owner.post('/api/owner/users/2/adjust', { amount: 500, reason: 'goodwill credit' });
  check('owner can credit a customer with a reason (audited)', () => assert.equal(r.status, 200));
  r = await owner.post('/api/owner/users/2/adjust', { amount: 500 });
  check('adjustments without a reason are refused', () => assert.equal(r.status, 400));

  // 2FA for the owner
  r = await owner.post('/api/account/2fa/setup', { password: 'wrong' });
  check('2FA setup needs the password', () => assert.equal(r.status, 400));
  r = await owner.post('/api/account/2fa/setup', { password: OWNER_PW });
  const secret = r.json.secret;
  check('2FA setup returns a secret and otpauth URI', () => { assert.match(secret, /^[A-Z2-7]{32}$/); assert.ok(r.json.uri.startsWith('otpauth://totp/')); });
  const key = auth.b32decode(secret);
  const step = Math.floor(Date.now() / 30000);
  r = await owner.post('/api/account/2fa/enable', { code: auth.hotp(key, step) });
  check('2FA enabled with a valid code', () => assert.equal(r.status, 200));
  const owner2 = new Client(base);
  r = await owner2.post('/api/login', { username: 'owner', password: OWNER_PW });
  check('login now demands the 2FA code', () => { assert.equal(r.status, 401); assert.equal(r.json.code, 'totp_required'); });
  r = await owner2.post('/api/login', { username: 'owner', password: OWNER_PW, code: '000000' });
  check('wrong 2FA code is rejected', () => assert.equal(r.status, 401));
  r = await owner2.post('/api/login', { username: 'owner', password: OWNER_PW, code: auth.hotp(key, step) });
  check('a code that was already used is rejected (no replay)', () => assert.equal(r.status, 401));
  r = await owner2.post('/api/login', { username: 'owner', password: OWNER_PW, code: auth.hotp(key, step + 1) });
  check('next valid code logs in', () => assert.equal(r.status, 200));

  // ban
  r = await owner.post('/api/staff/users/2/ban', { banned: true });
  check('owner bans alice', () => assert.equal(r.status, 200));
  r = await alice.get('/api/me');
  check('banned user is logged out immediately', () => assert.equal(r.status, 401));
  r = await new Client(base).post('/api/login', { username: 'alice', password: 'alice-pass-1' });
  check('banned user cannot log back in', () => assert.equal(r.status, 401));

  r = await owner.get('/api/owner/overview');
  check('profit is computed (revenue minus upstream cost)', () => { assert.ok(r.json.all_time.revenue_c > 0); assert.ok(r.json.all_time.profit_c > 0); assert.ok(r.json.all_time.profit_c < r.json.all_time.revenue_c); });
  r = await owner.get('/api/owner/audit');
  check('owner actions are in the audit log', () => { const a = r.json.entries.map((e) => e.action); assert.ok(a.includes('deposit.approve') && a.includes('balance.adjust') && a.includes('2fa.enable') && a.includes('user.ban')); });
}

main().catch((e) => { console.error(e); process.exit(1); });
