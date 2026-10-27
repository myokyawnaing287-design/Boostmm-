'use strict';
const cfg = require('./config');

// ambiguous = true means we cannot tell whether the upstream acted on the request
// (timeout, dropped connection, 5xx, unparsable body). Callers must NOT auto-refund in that case.
class UpstreamError extends Error {
  constructor(code, message, ambiguous) {
    super(message);
    this.code = code;
    this.ambiguous = !!ambiguous;
  }
}

async function call(params, timeoutMs = 20000) {
  if (!cfg.upstreamKey) throw new UpstreamError('not_configured', 'UPSTREAM_API_KEY is not set', false);
  const body = new URLSearchParams({ key: cfg.upstreamKey });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
  let res;
  let text;
  try {
    res = await fetch(cfg.upstreamUrl, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error', // never replay the key to a different host
    });
    text = await res.text();
  } catch {
    throw new UpstreamError('network', 'upstream unreachable or timed out', true);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError('bad_response', `upstream returned non-JSON (HTTP ${res.status})`, true);
  }
  if (res.status >= 500) throw new UpstreamError('http_' + res.status, `upstream HTTP ${res.status}`, true);
  if (json && !Array.isArray(json) && typeof json.error === 'string') {
    throw new UpstreamError('api', json.error, false);
  }
  return json;
}

const services = () => call({ action: 'services' });
const balance = () => call({ action: 'balance' }, 15000);

function add({ service, link, quantity, comments }) {
  return call({ action: 'add', service, link, quantity, comments });
}

// Always returns an object keyed by upstream order id: { "123": {status, charge, start_count, remains, currency} | {error} }
async function status(ids) {
  if (ids.length === 1) {
    const r = await call({ action: 'status', order: ids[0] });
    return { [ids[0]]: r };
  }
  return call({ action: 'status', orders: ids.join(',') });
}

const refill = (orderId) => call({ action: 'refill', order: orderId });

// Returns an object keyed by refill id: { "1": {status} }
async function refillStatus(ids) {
  if (ids.length === 1) {
    const r = await call({ action: 'refill_status', refill: ids[0] });
    return { [ids[0]]: r };
  }
  const arr = await call({ action: 'refill_status', refills: ids.join(',') });
  const out = {};
  if (Array.isArray(arr)) for (const it of arr) if (it && it.refill != null) out[String(it.refill)] = { status: it.status };
  return out;
}

// Returns array of { order, cancel: 1 | {error} }
const cancel = (ids) => call({ action: 'cancel', orders: ids.join(',') });

module.exports = { UpstreamError, services, balance, add, status, refill, refillStatus, cancel };
