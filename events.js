'use strict';
// Tiny in-process pub/sub that pushes Server-Sent Events to open browser tabs.
// Events carry ids/status only (never secrets); clients re-fetch the data through the normal authenticated API.

const clients = new Set();
const MAX_PER_USER = 5;

function subscribe(user, req, res) {
  const mine = [...clients].filter((c) => c.userId === user.id);
  if (mine.length >= MAX_PER_USER) {
    const old = mine[0];
    clients.delete(old);
    try { old.res.end(); } catch { /* already closed */ }
  }
  const client = { res, userId: user.id, role: user.role };
  clients.add(client);
  req.on('close', () => clients.delete(client));
}

// target: {} = everyone | { userId } | { roles: ['staff', 'owner'] }
function publish(type, data = {}, target = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (target.userId != null && c.userId !== target.userId) continue;
    if (target.roles && !target.roles.includes(c.role)) continue;
    try { c.res.write(payload); } catch { clients.delete(c); }
  }
}

setInterval(() => {
  for (const c of clients) {
    try { c.res.write(': ping\n\n'); } catch { clients.delete(c); }
  }
}, 25000).unref();

module.exports = { subscribe, publish };
