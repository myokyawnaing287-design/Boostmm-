'use strict';
const { db, tx, now, getSettings, adjustBalance, audit } = require('./db');
const { HttpError } = require('./errors');
const events = require('./events');

function paymentAccounts(settings) {
  try {
    const a = JSON.parse(settings.payment_accounts);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function createDeposit(user, input) {
  const settings = getSettings();
  const accounts = paymentAccounts(settings);
  const method = String(input.method ?? '');
  if (!accounts.some((a) => a.method === method && a.number)) throw new HttpError(400, 'ငွေပေးချေမှုနည်းလမ်း မမှန်ကန်ပါ');

  const amount = Number(input.amount);
  const min = Math.max(1, Number(settings.min_deposit_mmk) || 1000);
  if (!Number.isInteger(amount) || amount < min || amount > 20000000) {
    throw new HttpError(400, `ငွေပမာဏသည် ${min.toLocaleString('en-US')} ကျပ်မှ စ၍ ထည့်နိုင်ပါသည်`);
  }
  const txnRef = String(input.txnRef ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,30}$/.test(txnRef)) throw new HttpError(400, 'Transaction ID မမှန်ကန်ပါ (အက္ခရာ/ဂဏန်း ၄ လုံးမှ ၃၀ အထိ)');
  const note = String(input.note ?? '').trim().slice(0, 200) || null;

  const pending = db.prepare("SELECT COUNT(*) AS n FROM deposits WHERE user_id = ? AND status = 'pending'").get(user.id).n;
  if (pending >= 5) throw new HttpError(429, 'စောင့်ဆိုင်းနေသော တောင်းဆိုမှု များနေပါသည်');

  try {
    const r = db.prepare('INSERT INTO deposits(user_id, amount_c, method, txn_ref, note, created_at) VALUES(?,?,?,?,?,?)')
      .run(user.id, amount * 100, method, txnRef, note, now());
    events.publish('staff', { what: 'deposit' }, { roles: ['staff', 'owner'] });
    return { id: Number(r.lastInsertRowid) };
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'ဤ Transaction ID ကို အသုံးပြုပြီး သို့မဟုတ် တင်ပြပြီးဖြစ်ပါသည်');
    throw e;
  }
}

function approveDeposit(actor, id, amountOverride) {
  return tx(() => {
    const d = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
    if (!d) throw new HttpError(404, 'မတွေ့ပါ');
    if (d.status !== 'pending') throw new HttpError(409, 'ဤတောင်းဆိုမှုကို ဆုံးဖြတ်ပြီးပါပြီ');
    let amountC = d.amount_c;
    if (amountOverride != null) {
      const a = Number(amountOverride);
      if (!Number.isInteger(a) || a < 1 || a > 20000000) throw new HttpError(400, 'ငွေပမာဏ မမှန်ကန်ပါ');
      amountC = a * 100;
    }
    adjustBalance(d.user_id, amountC, 'deposit', d.id);
    db.prepare("UPDATE deposits SET status = 'approved', amount_c = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(amountC, actor.id, now(), d.id);
    audit(actor, 'deposit.approve', d.id, `user ${d.user_id} +${amountC / 100} ks`);
    events.publish('deposit', { id: d.id, status: 'approved' }, { userId: d.user_id });
    events.publish('staff', { what: 'deposit' }, { roles: ['staff', 'owner'] });
    return { amount_c: amountC };
  });
}

function rejectDeposit(actor, id, reason) {
  tx(() => {
    const d = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
    if (!d) throw new HttpError(404, 'မတွေ့ပါ');
    if (d.status !== 'pending') throw new HttpError(409, 'ဤတောင်းဆိုမှုကို ဆုံးဖြတ်ပြီးပါပြီ');
    db.prepare("UPDATE deposits SET status = 'rejected', admin_note = ?, decided_by = ?, decided_at = ? WHERE id = ?")
      .run(String(reason ?? '').slice(0, 200) || null, actor.id, now(), d.id);
    audit(actor, 'deposit.reject', d.id, reason);
    events.publish('deposit', { id: d.id, status: 'rejected' }, { userId: d.user_id });
    events.publish('staff', { what: 'deposit' }, { roles: ['staff', 'owner'] });
  });
}

module.exports = { paymentAccounts, createDeposit, approveDeposit, rejectDeposit };
