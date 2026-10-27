'use strict';
// A stand-in for the upstream panel that follows the v2 API documented on the panel's API page
// (actions: services, add, status, refill, refill_status, cancel, balance).
const http = require('node:http');

function createMock(key = 'testkey-123') {
  const state = {
    addMode: 'ok', // ok | error | drop
    balance: 100.5,
    nextOrder: 1000,
    nextRefill: 1,
    orders: new Map(),
    refills: new Map(),
    calls: [],
    services: [
      { service: 1, name: 'Followers', type: 'Default', category: 'Telegram', rate: '0.90', min: '50', max: '10000', refill: true, cancel: true },
      { service: 2, name: 'Comments', type: 'Custom Comments', category: 'Telegram', rate: '8', min: '10', max: '1500', refill: false, cancel: true },
      { service: 3, name: 'Poll votes', type: 'Poll', category: 'Telegram', rate: '1', min: '10', max: '1000', refill: false, cancel: false },
      { service: 4, name: 'Views', type: 'Default', category: 'TikTok', rate: '0.10', min: '100', max: '100000', refill: false, cancel: false },
    ],
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v2') { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const p = Object.fromEntries(new URLSearchParams(raw));
      state.calls.push(p);
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (p.key !== key) return send({ error: 'Invalid API key' });

      const orderInfo = (id) => {
        const o = state.orders.get(String(id));
        if (!o) return { error: 'Incorrect order ID' };
        return { charge: o.charge.toFixed(5), start_count: String(o.start_count), status: o.status, remains: String(o.remains), currency: 'USD' };
      };

      switch (p.action) {
        case 'services': return send(state.services);
        case 'balance': return send({ balance: state.balance.toFixed(5), currency: 'USD' });
        case 'add': {
          if (state.addMode === 'drop') { req.socket.destroy(); return undefined; }
          if (state.addMode === 'error') return send({ error: 'Not enough funds on balance' });
          const svc = state.services.find((s) => String(s.service) === p.service);
          if (!svc) return send({ error: 'Incorrect service ID' });
          if (!p.link) return send({ error: 'Incorrect link' });
          let qty;
          if (svc.type === 'Custom Comments') {
            if (!p.comments) return send({ error: 'Incorrect comments' });
            qty = p.comments.split('\n').length;
          } else {
            qty = Number(p.quantity);
          }
          if (!(qty >= Number(svc.min) && qty <= Number(svc.max))) return send({ error: 'Incorrect quantity' });
          const id = state.nextOrder++;
          state.orders.set(String(id), { id, status: 'Pending', charge: (Number(svc.rate) * qty) / 1000, start_count: 100, remains: qty, qty, service: svc.service });
          return send({ order: id });
        }
        case 'status': {
          if (p.orders) {
            const out = {};
            for (const id of p.orders.split(',')) out[id] = orderInfo(id);
            return send(out);
          }
          return send(orderInfo(p.order));
        }
        case 'refill': {
          const o = state.orders.get(String(p.order));
          if (!o) return send({ error: 'Incorrect order ID' });
          const id = state.nextRefill++;
          state.refills.set(String(id), { status: 'Pending' });
          return send({ refill: String(id) });
        }
        case 'refill_status': {
          if (p.refills) {
            return send(p.refills.split(',').map((id) => (state.refills.has(id)
              ? { refill: Number(id), status: state.refills.get(id).status }
              : { refill: Number(id), status: { error: 'Refill not found' } })));
          }
          const r = state.refills.get(String(p.refill));
          return send(r ? { status: r.status } : { error: 'Refill not found' });
        }
        case 'cancel': {
          return send(p.orders.split(',').map((id) => {
            const o = state.orders.get(id);
            if (!o) return { order: Number(id), cancel: { error: 'Incorrect order ID' } };
            o.status = 'Canceled';
            return { order: Number(id), cancel: 1 };
          }));
        }
        default: return send({ error: 'Incorrect action' });
      }
    });
  });
  return { state, server };
}

module.exports = { createMock };
