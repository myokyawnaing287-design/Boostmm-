'use strict';
const { db, tx, now, getSettings, adjustBalance, audit } = require('./db');
const { HttpError } = require('./errors');
const { SUPPORTED_TYPES, pricing, chargeCents } = require('./pricing');
const upstream = require('./upstream');
const events = require('./events');

const FINAL = new Set(['Completed', 'Partial', 'Canceled', 'Failed']);
const ACTIVE = ['Pending', 'In progress', 'Processing'];
const STALE_SECONDS = 12 * 3600; // refuse to sell on prices older than this

const STATUS_MAP = {
  'pending': 'Pending',
  'in progress': 'In progress',
  'inprogress': 'In progress',
  'processing': 'Processing',
  'completed': 'Completed',
  'complete': 'Completed',
  'partial': 'Partial',
  'canceled': 'Canceled',
  'cancelled': 'Canceled',
  'fail': 'Canceled',
  'failed': 'Canceled',
  'refunded': 'Canceled',
};
const normalizeStatus = (s) => STATUS_MAP[String(s || '').trim().toLowerCase()] || null;

function publicOrder(o) {
  const active = ACTIVE.includes(o.status);
  return {
    id: o.id,
    service_id: o.service_id,
    service_name: o.service_name,
    link: o.link,
    quantity: o.quantity,
    charge_c: o.charge_c,
    refunded_c: o.refunded_c,
    status: o.status,
    start_count: o.start_count,
    remains: o.remains,
    refill_id: o.refill_id,
    refill_status: o.refill_status,
    can_refill: !!(o.s_refill && o.status === 'Completed' && (!o.refill_at || now() - o.refill_at >= 86400)),
    can_cancel: !!(o.s_cancel && active && o.upstream_order_id),
    created_at: o.created_at,
  };
}

const ORDER_SELECT = `SELECT o.*, s.refill AS s_refill, s.cancel AS s_cancel
                      FROM orders o LEFT JOIN services s ON s.id = o.service_id`;

function getOrderPublic(id) {
  return publicOrder(db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id));
}

// Must run inside tx. Refund is capped so cumulative refunds can never exceed the charge.
function refundInTx(orderId, amountC) {
  const o = db.prepare('SELECT id, user_id, charge_c, refunded_c FROM orders WHERE id = ?').get(orderId);
  const allowed = Math.max(0, Math.min(Math.floor(amountC), o.charge_c - o.refunded_c));
  if (allowed > 0) {
    adjustBalance(o.user_id, allowed, 'refund', orderId);
    db.prepare('UPDATE orders SET refunded_c = refunded_c + ?, updated_at = ? WHERE id = ?').run(allowed, now(), orderId);
  }
  return allowed;
}

async function createOrder(user, input) {
  const settings = getSettings();
  const p = pricing(settings);

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(input.serviceId));
  if (!service || !service.enabled || service.missing || !SUPPORTED_TYPES.includes(service.type)) {
    throw new HttpError(400, 'ဤဝန်ဆောင်မှုကို လောလောဆယ် မရနိုင်ပါ');
  }
  if (now() - Number(settings.services_synced_at || 0) > STALE_SECONDS) {
    throw new HttpError(503, 'စျေးနှုန်း update လုပ်နေဆဲဖြစ်၍ ခဏနေမှ ပြန်ကြိုးစားပါ');
  }

  const link = String(input.link ?? '').trim();
  if (!link || link.length > 500 || /[\s\u0000-\u001f]/.test(link)) {
    throw new HttpError(400, 'Link မမှန်ကန်ပါ');
  }

  let quantity;
  let comments = null;
  if (service.type === 'Custom Comments') {
    const lines = String(input.comments ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    comments = lines.join('\n');
    if (comments.length > 20000) throw new HttpError(400, 'Comment များ အရမ်းရှည်နေပါသည်');
    quantity = lines.length;
  } else {
    quantity = Number(input.quantity);
    if (!Number.isInteger(quantity)) throw new HttpError(400, 'Quantity မမှန်ကန်ပါ');
  }
  if (quantity < service.min || quantity > service.max) {
    throw new HttpError(400, `Quantity သည် ${service.min} မှ ${service.max} အတွင်း ဖြစ်ရပါမည်`);
  }

  const requestId = String(input.requestId ?? '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new HttpError(400, 'request id မမှန်ကန်ပါ');

  const charge = chargeCents(service, quantity, p);
  const costEst = (service.rate_usd * quantity) / 1000;
  const t = now();

  let order;
  let replay = false;
  tx(() => {
    const existing = db.prepare('SELECT * FROM orders WHERE user_id = ? AND request_id = ?').get(user.id, requestId);
    if (existing) { order = existing; replay = true; return; }
    const u = db.prepare('SELECT balance_c, is_banned FROM users WHERE id = ?').get(user.id);
    if (!u || u.is_banned) throw new HttpError(403, 'အကောင့်ကို ပိတ်ထားပါသည်');
    if (u.balance_c < charge) throw new HttpError(402, 'လက်ကျန်ငွေ မလုံလောက်ပါ', 'insufficient_funds');
    const r = db.prepare(`INSERT INTO orders(user_id, service_id, service_name, link, comments, quantity, charge_c, fx, cost_usd_est, status, request_id, created_at, updated_at)
                          VALUES(?,?,?,?,?,?,?,?,?,'Submitting',?,?,?)`)
      .run(user.id, service.id, service.custom_name || service.name, link, comments, quantity, charge, p.fx, costEst, requestId, t, t);
    adjustBalance(user.id, -charge, 'order', r.lastInsertRowid);
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.lastInsertRowid);
  });
  if (replay) return getOrderPublic(order.id);

  try {
    const resp = await upstream.add({
      service: service.id,
      link,
      quantity: comments != null ? undefined : quantity,
      comments: comments != null ? comments : undefined,
    });
    const oid = resp && resp.order != null ? String(resp.order) : null;
    if (!oid) throw new upstream.UpstreamError('bad_response', 'no order id in response', true);
    db.prepare("UPDATE orders SET upstream_order_id = ?, status = 'Pending', updated_at = ? WHERE id = ?").run(oid, now(), order.id);
  } catch (e) {
    const ambiguous = !(e instanceof upstream.UpstreamError) || e.ambiguous;
    const msg = String(e.message || e).slice(0, 300);
    if (!ambiguous) {
      // Upstream definitively rejected the order: give the money back.
      tx(() => {
        refundInTx(order.id, charge);
        db.prepare("UPDATE orders SET status = 'Failed', note = ?, updated_at = ? WHERE id = ?").run('upstream rejected: ' + msg, now(), order.id);
      });
    } else {
      // We cannot tell whether it was placed. Hold the money and let the owner decide.
      db.prepare("UPDATE orders SET status = 'Review', note = ?, updated_at = ? WHERE id = ?").run('upstream outcome unknown: ' + msg, now(), order.id);
      events.publish('staff', { what: 'review' }, { roles: ['staff', 'owner'] });
    }
  }
  events.publish('orders', { id: order.id }, { userId: user.id }); // other devices of the same user
  return getOrderPublic(order.id);
}

// Returns true when the order row actually changed (and tells that user's open apps).
function applyStatus(orderId, info) {
  const status = normalizeStatus(info.status);
  if (!status) return false;
  let owner = null;
  let changed = false;
  tx(() => {
    const cur = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!cur) return;
    owner = cur.user_id;
    changed = cur.status !== status
      || (info.remains != null && String(info.remains) !== String(cur.remains))
      || (info.start_count != null && String(info.start_count) !== String(cur.start_count));
    const remains = info.remains != null && info.remains !== ''
      ? Math.max(0, Math.min(cur.quantity, parseInt(info.remains, 10) || 0))
      : null;
    const chargeUsd = Number(info.charge);
    db.prepare('UPDATE orders SET status = ?, start_count = ?, remains = ?, upstream_charge_usd = ?, updated_at = ? WHERE id = ?')
      .run(
        status,
        info.start_count != null ? String(info.start_count) : cur.start_count,
        remains != null ? String(remains) : cur.remains,
        Number.isFinite(chargeUsd) ? chargeUsd : cur.upstream_charge_usd,
        now(),
        cur.id,
      );
    if (status === 'Canceled') {
      refundInTx(cur.id, cur.charge_c - cur.refunded_c);
    } else if (status === 'Partial') {
      if (remains == null) {
        db.prepare("UPDATE orders SET note = 'Partial without remains: check manually' WHERE id = ?").run(cur.id);
      } else {
        refundInTx(cur.id, Math.floor((cur.charge_c * remains) / cur.quantity) - cur.refunded_c);
      }
    }
  });
  if (changed && owner != null) events.publish('orders', { id: orderId, status }, { userId: owner });
  return changed;
}

async function requestRefill(user, orderId) {
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id = ? AND o.user_id = ?`).get(orderId, user.id);
  if (!o) throw new HttpError(404, 'Order မတွေ့ပါ');
  if (!o.s_refill) throw new HttpError(400, 'ဤဝန်ဆောင်မှုတွင် Refill မပါပါ');
  if (o.status !== 'Completed' || !o.upstream_order_id) throw new HttpError(400, 'Completed ဖြစ်မှသာ Refill တောင်းနိုင်ပါသည်');
  const t = now();
  const claimed = db.prepare('UPDATE orders SET refill_at = ? WHERE id = ? AND (refill_at IS NULL OR refill_at <= ?)').run(t, o.id, t - 86400);
  if (!claimed.changes) throw new HttpError(429, 'Refill ကို ၂၄ နာရီတစ်ကြိမ်သာ တောင်းနိုင်ပါသည်');
  try {
    const r = await upstream.refill(o.upstream_order_id);
    if (r == null || r.refill == null) throw new upstream.UpstreamError('bad_response', 'no refill id', true);
    db.prepare("UPDATE orders SET refill_id = ?, refill_status = 'Pending', updated_at = ? WHERE id = ?").run(String(r.refill), now(), o.id);
  } catch (e) {
    if (e instanceof upstream.UpstreamError && !e.ambiguous) {
      db.prepare('UPDATE orders SET refill_at = ? WHERE id = ?').run(o.refill_at, o.id); // allow retry
      throw new HttpError(400, 'Refill တောင်းခံ၍ မရသေးပါ (ဝန်ဆောင်မှုပေးသူက ပယ်ချခဲ့သည်)');
    }
    throw new HttpError(502, 'ဝန်ဆောင်မှုပေးသူနှင့် ချိတ်ဆက်၍မရပါ၊ ခဏနေမှ ပြန်ကြိုးစားပါ');
  }
  return getOrderPublic(o.id);
}

async function requestCancel(user, orderId) {
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id = ? AND o.user_id = ?`).get(orderId, user.id);
  if (!o) throw new HttpError(404, 'Order မတွေ့ပါ');
  if (!o.s_cancel) throw new HttpError(400, 'ဤဝန်ဆောင်မှုကို Cancel လုပ်၍မရပါ');
  if (!ACTIVE.includes(o.status) || !o.upstream_order_id) throw new HttpError(400, 'ဤ order ကို Cancel လုပ်၍ မရတော့ပါ');
  let r;
  try {
    r = await upstream.cancel([o.upstream_order_id]);
  } catch {
    throw new HttpError(502, 'ဝန်ဆောင်မှုပေးသူနှင့် ချိတ်ဆက်၍မရပါ၊ ခဏနေမှ ပြန်ကြိုးစားပါ');
  }
  const item = Array.isArray(r) ? r.find((x) => String(x.order) === String(o.upstream_order_id)) : null;
  if (!item || (item.cancel && typeof item.cancel === 'object' && item.cancel.error)) {
    throw new HttpError(400, 'Cancel တောင်းခံ၍ မရပါ');
  }
  return { requested: true };
}

// Owner/staff: settle an order stuck in Review/Submitting.
function resolveStuckOrder(actor, orderId, action, upstreamOrderId) {
  tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw new HttpError(404, 'Order မတွေ့ပါ');
    if (o.status !== 'Review' && o.status !== 'Submitting') throw new HttpError(409, 'ဤ order သည် စစ်ဆေးရန် မလိုပါ');
    if (action === 'refund') {
      refundInTx(o.id, o.charge_c - o.refunded_c);
      db.prepare("UPDATE orders SET status = 'Failed', note = COALESCE(note,'') || ' | refunded by ' || ?, updated_at = ? WHERE id = ?").run(actor.username, now(), o.id);
    } else if (action === 'confirm') {
      const id = String(upstreamOrderId || '').trim();
      if (!/^\d{1,15}$/.test(id)) throw new HttpError(400, 'upstream order id မမှန်ကန်ပါ');
      db.prepare("UPDATE orders SET upstream_order_id = ?, status = 'Pending', note = COALESCE(note,'') || ' | confirmed by ' || ?, updated_at = ? WHERE id = ?").run(id, actor.username, now(), o.id);
    } else {
      throw new HttpError(400, 'action မမှန်ကန်ပါ');
    }
    audit(actor, 'order.' + action, o.id, upstreamOrderId || '');
    events.publish('orders', { id: o.id }, { userId: o.user_id });
  });
  events.publish('staff', { what: 'review' }, { roles: ['staff', 'owner'] });
}

module.exports = {
  FINAL, ACTIVE, publicOrder, ORDER_SELECT, getOrderPublic, normalizeStatus,
  createOrder, applyStatus, refundInTx, requestRefill, requestCancel, resolveStuckOrder,
};
