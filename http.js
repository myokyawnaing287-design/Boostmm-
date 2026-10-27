'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const { HttpError } = require('./errors');
const { getSessionUser } = require('./auth');

const routes = [];
const NO_REPLY = Symbol('no-reply'); // handler already took over the response (SSE)

// opts: { auth: true } any logged-in user | { role: 'staff' } staff or owner | { role: 'owner' } owner only
function add(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts, handler });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

function setCookie(res, name, value, maxAge) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  if (cfg.cookieSecure) c += '; Secure';
  res.setHeader('Set-Cookie', c);
}

function clientIp(req) {
  if (cfg.trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (ch) => {
      size += ch.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        return reject(new HttpError(415, 'JSON only'));
      }
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  let matched = null;
  let mismatch = false;
  const params = {};
  for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    if (r.method !== req.method) { mismatch = true; continue; }
    matched = r;
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    break;
  }
  if (!matched) return sendJson(res, mismatch ? 405 : 404, { error: 'မတွေ့ပါ' });

  const token = parseCookies(req.headers.cookie).sid;
  const user = getSessionUser(token);
  const o = matched.opts;
  if ((o.auth || o.role) && !user) throw new HttpError(401, 'ပြန်လည် login ဝင်ပါ', 'unauthenticated');
  if (o.role === 'owner' && user.role !== 'owner') throw new HttpError(403, 'ခွင့်ပြုချက်မရှိပါ');
  if (o.role === 'staff' && user.role !== 'staff' && user.role !== 'owner') throw new HttpError(403, 'ခွင့်ပြုချက်မရှိပါ');

  let body = {};
  if (req.method !== 'GET') {
    // CSRF: custom header (cannot be set cross-site without CORS) + same-origin check.
    if (req.headers['x-requested-with'] !== 'shop') throw new HttpError(403, 'Forbidden');
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* invalid origin */ }
      if (host !== req.headers.host) throw new HttpError(403, 'Forbidden');
    }
    body = await readJson(req);
  }
  const ctx = { req, res, url, params, query: Object.fromEntries(url.searchParams), body, user, token, ip: clientIp(req) };
  const result = await matched.handler(ctx);
  if (result === NO_REPLY) return;
  sendJson(res, 200, result === undefined ? { ok: true } : result);
}

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, p));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (cfg.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

async function handler(req, res) {
  securityHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
    console.error('[error]', e && e.stack ? e.stack : e);
    return sendJson(res, 500, { error: 'Server error' });
  }
}

module.exports = { add, setCookie, handler, NO_REPLY };
