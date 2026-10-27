'use strict';
// Opens every page in a real headless browser against a live server + mock upstream.
// Fails on any console error, page error or CSP violation. Run: node test/ui-smoke.js
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createMock } = require('./mock-upstream');

const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mock = createMock('k');
  const mp = await free();
  await new Promise((r) => mock.server.listen(mp, '127.0.0.1', r));
  const port = await free();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'db'), UPSTREAM_URL: `http://127.0.0.1:${mp}/api/v2`, UPSTREAM_API_KEY: 'k', OWNER_PASSWORD: 'OwnerPass-12345', SERVICES_SYNC_SEC: '3600', SYNC_INTERVAL_SEC: '3600' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* wait */ } await sleep(100); }
  await sleep(500);

  const problems = [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

  const text = async () => (await page.locator('#app').innerText()).replace(/\s+/g, ' ');
  const expect = async (label, needle) => { const t = await text(); if (!t.includes(needle)) problems.push(`${label}: expected "${needle}" in "${t.slice(0, 200)}"`); else console.log('  ok  ' + label); };

  await page.goto(base);
  await page.waitForSelector('form');
  await expect('login page renders', 'ဝင်ရန်');

  // customer signup
  await page.click('text=အကောင့်ဖွင့်ရန်');
  const inputs = page.locator('form input');
  await inputs.nth(0).fill('uitest');
  await inputs.nth(2).fill('uitest-pass-1');
  await page.click('button[type=submit]');
  await page.waitForSelector('.price');
  await expect('new-order page after signup', 'အော်ဒါအသစ်');
  for (const h of ['#/orders', '#/funds', '#/updates', '#/account']) {
    await page.evaluate((x) => { location.hash = x; }, h);
    await sleep(400);
    await expect('customer ' + h, h === '#/orders' ? 'မှာယူမှုများ' : h === '#/funds' ? 'ငွေလွှဲရန်' : h === '#/updates' ? 'အပြောင်းအလဲ' : 'စကားဝှက်');
  }
  const ownerHash = await page.evaluate(() => { location.hash = '#/owner'; return location.hash; });
  await sleep(400);
  if ((await page.evaluate(() => location.hash)) === '#/owner') problems.push('customer reached #/owner');
  else console.log('  ok  customer is bounced from owner dashboard');
  void ownerHash;

  // owner
  await page.evaluate(async () => { await fetch('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'shop' } }); });
  await page.goto(base + '/#/login');
  await page.reload();
  await page.waitForSelector('form');
  const f = page.locator('form input');
  await f.nth(0).fill('myokyawnaing287@gmail.com');
  await f.nth(1).fill('OwnerPass-12345');
  await page.click('button[type=submit]');
  await page.waitForSelector('.price');
  for (const [h, needle] of [['#/owner', 'AuraBurma လက်ကျန်'], ['#/owner/services', 'Telegram'], ['#/owner/changes', 'ပြောင်းလဲမှုများ'], ['#/owner/settings', 'ဆိုင် Settings'], ['#/owner/audit', 'Audit log'], ['#/admin/deposits', 'စောင့်ဆိုင်းဆဲ'], ['#/admin/orders', 'စစ်ဆေးရန်'], ['#/admin/users', 'owner']]) {
    await page.evaluate((x) => { location.hash = x; }, h);
    await sleep(500);
    await expect('owner ' + h, needle);
  }

  // live update: change price upstream, ask server to sync, the open owner page must show it without reload
  await page.evaluate(() => { location.hash = '#/new'; });
  await sleep(400);
  const before = await page.locator('select').nth(1).innerText();
  mock.state.services[0].rate = '2.00';
  await page.evaluate(async () => { await fetch('/api/owner/sync', { method: 'POST', headers: { 'X-Requested-With': 'shop', 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'services' }) }); });
  await sleep(1200);
  const after = await page.locator('select').nth(1).innerText();
  if (before === after) problems.push('live update did not refresh the open order page'); else console.log('  ok  open page updated itself after upstream price change');

  await page.screenshot({ path: path.join(dir, 'owner.png'), fullPage: true });
  console.log('screenshot dir', dir);
  await browser.close();
  child.kill('SIGTERM');
  mock.server.close();
  if (problems.length) { console.log('\nPROBLEMS:\n' + problems.join('\n')); process.exit(1); }
  console.log('\nui smoke passed');
})().catch((e) => { console.error(e); process.exit(1); });
