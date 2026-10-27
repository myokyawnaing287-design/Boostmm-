'use strict';
/* Storefront + owner dashboard. No inline scripts/styles (CSP); all text is inserted with textContent. */
(() => {
  const $app = document.getElementById('app');
  const S = { me: null, pub: {}, services: null, live: false, badges: { deposits: 0, review: 0 }, view: null, es: null };

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v; // CSSOM is allowed by CSP; the style attribute is not
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
  const ks = (c) => (c / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ကျပ်';
  const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const when = (t) => {
    if (!t) return '-';
    const d = new Date(t * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  function toast(msg, kind) {
    const t = h('div', { class: 'toast ' + (kind || '') }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 4500);
  }
  async function api(method, url, body) {
    const opt = { method, headers: { 'X-Requested-With': 'shop' }, credentials: 'same-origin' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, opt); } catch { throw Object.assign(new Error('အင်တာနက် ချိတ်ဆက်မှု မရပါ'), { network: true }); }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && S.me && url !== '/api/login') { S.me = null; closeLive(); route(); }
    if (!res.ok) throw Object.assign(new Error(data.error || 'အမှားဖြစ်ပါသည်'), { status: res.status, code: data.code });
    return data;
  }
  const get = (u) => api('GET', u);
  const post = (u, b) => api('POST', u, b === undefined ? {} : b);
  const isStaff = () => S.me && (S.me.role === 'staff' || S.me.role === 'owner');
  const isOwner = () => S.me && S.me.role === 'owner';
  function modal(content) {
    const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) m.remove(); } }, h('div', { class: 'card' }, content));
    document.body.append(m);
    return m;
  }
  async function guarded(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, 'bad'); } finally { btn.disabled = false; }
  }

  const STATUS = {
    Pending: ['စောင့်ဆိုင်းဆဲ', 'warn'], 'In progress': ['လုပ်ဆောင်နေဆဲ', 'info'], Processing: ['လုပ်ဆောင်နေဆဲ', 'info'],
    Completed: ['ပြီးစီး', 'ok'], Partial: ['တစ်စိတ်တစ်ပိုင်း', 'warn'], Canceled: ['ပယ်ဖျက်ပြီး', 'bad'],
    Failed: ['မအောင်မြင်', 'bad'], Review: ['စစ်ဆေးနေဆဲ', 'warn'], Submitting: ['တင်သွင်းနေ', 'warn'],
  };
  const badge = (st) => { const [t, k] = STATUS[st] || [st, '']; return h('span', { class: 'badge ' + k }, t); };

  // ---------- live updates (upstream -> us -> every open app) ----------
  function openLive() {
    if (S.es || !S.me) return;
    const es = new EventSource('/api/events');
    S.es = es;
    es.onopen = () => { S.live = true; paintLive(); };
    es.onerror = () => { S.live = false; paintLive(); };
    es.addEventListener('services', () => {
      S.services = null;
      toast('🔔 ဝန်ဆောင်မှု / ဈေးနှုန်း အပြောင်းအလဲ ရှိပါသည် — အသစ်ပြောင်းပြီးပါပြီ', 'ok');
      refreshView();
    });
    es.addEventListener('balance', async () => { try { S.me = (await get('/api/me')).user; paintBalance(); } catch { /* ignore */ } });
    es.addEventListener('orders', () => refreshView('orders'));
    es.addEventListener('deposit', (e) => {
      try { const d = JSON.parse(e.data); toast(d.status === 'approved' ? '✅ ငွေဖြည့်မှု အတည်ပြုပြီးပါပြီ' : '❌ ငွေဖြည့်တောင်းဆိုမှု ပယ်ချခံရပါသည်', d.status === 'approved' ? 'ok' : 'bad'); } catch { /* ignore */ }
      refreshView('funds');
    });
    es.addEventListener('staff', () => { loadBadges(); refreshView('staff'); });
  }
  function closeLive() { if (S.es) { S.es.close(); S.es = null; S.live = false; } }
  function paintLive() { const d = document.getElementById('live'); if (d) { d.className = 'live' + (S.live ? ' on' : ''); d.title = S.live ? 'Live' : 'Offline'; } }
  function paintBalance() { const b = document.getElementById('bal'); if (b && S.me) b.textContent = ks(S.me.balance_c); }
  async function loadBadges() {
    if (!isStaff()) return;
    try {
      const s = await get('/api/staff/summary');
      S.badges = { deposits: s.pending_deposits, review: s.review_orders };
      document.querySelectorAll('[data-badge]').forEach((el) => {
        const n = S.badges[el.dataset.badge] || 0;
        el.textContent = n || '';
        el.style.display = n ? '' : 'none';
      });
    } catch { /* ignore */ }
  }
  // Each view registers a reload function with an optional tag; events reload only matching views.
  function refreshView(tag) {
    const v = S.view;
    if (!v || !v.reload) return;
    if (tag && v.tags && !v.tags.includes(tag)) return;
    v.reload();
  }
  async function services() {
    if (!S.services) S.services = (await get('/api/services')).services;
    return S.services;
  }

  // ---------- shell ----------
  const CUSTOMER_NAV = [['#/new', 'မှာယူရန်'], ['#/orders', 'မှာယူမှုများ'], ['#/funds', 'ငွေဖြည့်'], ['#/updates', 'အပြောင်းအလဲ'], ['#/account', 'အကောင့်']];
  const ADMIN_NAV = [['#/admin/deposits', 'ငွေဖြည့်တောင်းဆိုမှု', 'deposits'], ['#/admin/orders', 'အော်ဒါများ', 'review'], ['#/admin/users', 'Users']];
  const OWNER_NAV = [['#/owner', 'Overview'], ['#/owner/services', 'ဝန်ဆောင်မှုများ'], ['#/owner/changes', 'AuraBurma ပြောင်းလဲမှု'], ['#/owner/settings', 'Settings'], ['#/owner/audit', 'Audit']];

  function shell(active, section) {
    const nav = (items) => h('nav', { class: 'nav' }, items.map(([href, label, badgeKey]) =>
      h('a', { href, class: active === href ? 'on' : '' }, label, badgeKey ? h('span', { class: 'dot', 'data-badge': badgeKey, style: 'display:none' }) : null)));
    const top = h('header', { class: 'top' }, h('div', { class: 'wrap' },
      h('div', { class: 'brand' }, S.pub.site_name || 'Boostmm'),
      h('span', { id: 'live', class: 'live' + (S.live ? ' on' : '') }),
      h('a', { id: 'bal', class: 'bal', href: '#/funds' }, ks(S.me.balance_c))));
    const navs = [nav(CUSTOMER_NAV)];
    const tabs = [];
    if (isStaff()) tabs.push(['#/admin/deposits', 'စီမံခန့်ခွဲ']);
    if (isOwner()) tabs.push(['#/owner', 'Owner Dashboard']);
    const wrapNav = h('div', { class: 'wrap' }, nav(CUSTOMER_NAV.concat(tabs.map(([a, b]) => [a, '⚙ ' + b]).map(([a, b]) => [a, b]))));
    // highlight the section tab
    wrapNav.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href');
      if ((section === 'admin' && href === '#/admin/deposits') || (section === 'owner' && href === '#/owner')) a.classList.add('on');
    });
    top.append(wrapNav);
    const sub = section === 'admin' ? nav(ADMIN_NAV) : section === 'owner' ? nav(isOwner() ? OWNER_NAV.concat(ADMIN_NAV) : []) : null;
    const main = h('main', { class: 'wrap' }, sub);
    const body = h('div');
    main.append(body);
    clear($app).append(top, main);
    loadBadges();
    void navs;
    return body;
  }

  // ---------- auth ----------
  function authView() {
    closeLive();
    let mode = 'login';
    let needCode = false;
    const box = h('div', { class: 'auth wrap' });
    const render = () => {
      const err = h('div', { class: 'err', style: 'display:none' });
      const user = h('input', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
      const pass = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password' });
      const email = h('input', { type: 'email', autocomplete: 'email', placeholder: 'မဖြည့်လည်းရ' });
      const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456' });
      const btn = h('button', { class: 'btn block', type: 'submit' }, mode === 'login' ? 'ဝင်ရောက်မည်' : 'အကောင့်ဖွင့်မည်');
      const form = h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          err.style.display = 'none';
          btn.disabled = true;
          try {
            const body = { username: user.value, password: pass.value };
            if (mode === 'signup') body.email = email.value;
            if (needCode) body.code = code.value;
            const r = await post(mode === 'login' ? '/api/login' : '/api/signup', body);
            S.me = r.user; S.services = null;
            location.hash = '#/new';
            route();
          } catch (x) {
            if (x.code === 'totp_required') { needCode = true; render(); toast(x.message); return; }
            err.textContent = x.message; err.style.display = '';
          } finally { btn.disabled = false; }
        },
      },
      h('label', {}, mode === 'login' ? 'အသုံးပြုသူအမည် / Email' : 'အသုံးပြုသူအမည် (a-z, 0-9, _)'), user,
      mode === 'signup' ? [h('label', {}, 'Email'), email] : null,
      h('label', {}, 'စကားဝှက်'), pass,
      needCode ? [h('label', {}, '2FA code (၆ လုံး)'), code] : null,
      err, btn);
      clear(box).append(
        h('h1', {}, S.pub.site_name || 'Boostmm'),
        S.pub.announcement ? h('div', { class: 'ann' }, S.pub.announcement) : null,
        h('div', { class: 'card' },
          h('div', { class: 'tabs' },
            h('button', { class: 'chip' + (mode === 'login' ? ' on' : ''), onclick: () => { mode = 'login'; needCode = false; render(); } }, 'ဝင်ရန်'),
            h('button', { class: 'chip' + (mode === 'signup' ? ' on' : ''), onclick: () => { mode = 'signup'; needCode = false; render(); } }, 'အကောင့်ဖွင့်ရန်')),
          form),
        S.pub.support_contact ? h('p', { class: 'mute small' }, 'အကူအညီ: ' + S.pub.support_contact) : null);
      (needCode ? code : user).focus();
    };
    render();
    clear($app).append(box);
  }

  // ---------- customer: new order ----------
  async function newOrderView() {
    const body = shell('#/new');
    const list = await services();
    S.view = { tags: ['services'], reload: () => newOrderView() };
    if (S.pub.announcement) body.append(h('div', { class: 'ann' }, S.pub.announcement));
    if (!list.length) { body.append(h('div', { class: 'card empty' }, 'လောလောဆယ် ရောင်းချနေသော ဝန်ဆောင်မှု မရှိသေးပါ')); return; }

    const cats = [...new Set(list.map((s) => s.category))];
    const keep = newOrderView.keep || {};
    const cat = h('select', {}, cats.map((c) => h('option', { value: c, selected: c === keep.cat }, c)));
    const svc = h('select');
    const desc = h('div', { class: 'small mute' });
    const link = h('input', { placeholder: 'https://...', inputmode: 'url', autocapitalize: 'none', value: keep.link || '' });
    const qty = h('input', { type: 'number', inputmode: 'numeric', min: '1', value: keep.qty || '' });
    const comments = h('textarea', { placeholder: 'မှတ်ချက်တစ်ခုကို တစ်ကြောင်းစီ ရေးပါ', value: keep.comments || '' });
    const qtyBox = h('div', {}, h('label', {}, 'အရေအတွက်'), qty, h('div', { class: 'small mute', id: 'lim' }));
    const comBox = h('div', {}, h('label', {}, 'Comments (တစ်ကြောင်း = တစ်ခု)'), comments);
    const price = h('div', { class: 'price' });
    const err = h('div', { class: 'err', style: 'display:none' });
    const btn = h('button', { class: 'btn block', type: 'submit' }, 'မှာယူမည်');
    let requestId = crypto.randomUUID();

    const cur = () => list.find((s) => s.id === Number(svc.value));
    const fillSvc = (pick) => {
      clear(svc).append(...list.filter((s) => s.category === cat.value).map((s) => h('option', { value: s.id, selected: s.id === pick }, `#${s.id} ${s.name} — ${num(s.per_thousand_mmk)} ကျပ်/၁၀၀၀`)));
    };
    const calc = () => {
      const s = cur();
      if (!s) return;
      const isC = s.type === 'Custom Comments';
      qtyBox.style.display = isC ? 'none' : '';
      comBox.style.display = isC ? '' : 'none';
      qtyBox.querySelector('#lim').textContent = `အနည်းဆုံး ${num(s.min)} / အများဆုံး ${num(s.max)}`;
      const n = isC ? comments.value.split('\n').map((x) => x.trim()).filter(Boolean).length : Number(qty.value) || 0;
      desc.textContent = [s.description, s.refill ? '♻ Refill ရ' : '', s.cancel ? '✖ Cancel ရ' : ''].filter(Boolean).join(' · ');
      price.textContent = n ? `${num(n)} ခု = ${ks(Math.ceil(s.per_thousand_mmk * n / 1000 * 100))}` : `${num(s.per_thousand_mmk)} ကျပ် / ၁၀၀၀`;
    };
    cat.onchange = () => { fillSvc(); calc(); };
    svc.onchange = calc; qty.oninput = calc; comments.oninput = calc;
    fillSvc(keep.svc); calc();

    body.append(h('div', { class: 'card' }, h('h2', {}, 'အော်ဒါအသစ်'),
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          err.style.display = 'none';
          const s = cur();
          const payload = { serviceId: s.id, link: link.value.trim(), requestId };
          if (s.type === 'Custom Comments') payload.comments = comments.value.split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
          else payload.quantity = Number(qty.value);
          btn.disabled = true;
          try {
            const r = await post('/api/orders', payload);
            requestId = crypto.randomUUID();
            S.me.balance_c = r.balance_c; paintBalance();
            const st = r.order.status;
            if (st === 'Failed') toast('အော်ဒါ မအောင်မြင်ပါ၊ ငွေပြန်အမ်းပြီးပါပြီ', 'bad');
            else if (st === 'Review') toast('အော်ဒါကို စစ်ဆေးနေပါသည်၊ ခဏစောင့်ပါ', '');
            else toast('✅ အော်ဒါတင်ပြီးပါပြီ #' + r.order.id, 'ok');
            newOrderView.keep = {};
            location.hash = '#/orders';
          } catch (x) {
            err.textContent = x.message; err.style.display = '';
            newOrderView.keep = { cat: cat.value, svc: s.id, link: link.value, qty: qty.value, comments: comments.value };
            if (x.status === 402) err.append(' ', h('a', { href: '#/funds' }, 'ငွေဖြည့်ရန်'));
          } finally { btn.disabled = false; }
        },
      },
      h('label', {}, 'အမျိုးအစား'), cat, h('label', {}, 'ဝန်ဆောင်မှု'), svc, desc,
      h('label', {}, 'Link'), link, qtyBox, comBox, price, err, btn)));
  }

  // ---------- customer: orders ----------
  async function ordersView() {
    const body = shell('#/orders');
    const st = { status: '', q: '', rows: [], more: false };
    const listBox = h('div', { class: 'card' });
    const chips = h('div', { class: 'tabs' });
    const search = h('input', { placeholder: 'Order ID သို့မဟုတ် link ရှာရန်', type: 'search' });
    let timer;
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { st.q = search.value; load(); }, 300); };
    const FILTERS = [['', 'အားလုံး'], ['Pending', 'စောင့်ဆိုင်းဆဲ'], ['In progress', 'လုပ်ဆောင်ဆဲ'], ['Completed', 'ပြီးစီး'], ['Partial', 'တစ်စိတ်တစ်ပိုင်း'], ['Canceled', 'ပယ်ဖျက်'], ['Failed', 'မအောင်မြင်']];
    const drawChips = () => clear(chips).append(...FILTERS.map(([v, l]) => h('button', { class: 'chip' + (st.status === v ? ' on' : ''), onclick: () => { st.status = v; drawChips(); load(); } }, l)));
    const draw = () => {
      clear(listBox);
      if (!st.rows.length) { listBox.append(h('div', { class: 'empty' }, 'မှာယူမှု မရှိသေးပါ')); return; }
      for (const o of st.rows) {
        const actions = h('div', { class: 'row' });
        if (o.can_refill) actions.append(h('button', { class: 'btn sm sec', onclick: (e) => guarded(e.target, async () => { await post(`/api/orders/${o.id}/refill`); toast('Refill တောင်းဆိုပြီးပါပြီ', 'ok'); load(); }) }, '♻ Refill'));
        if (o.can_cancel) actions.append(h('button', { class: 'btn sm bad', onclick: (e) => { if (confirm('ဤအော်ဒါကို ပယ်ဖျက်မလား?')) guarded(e.target, async () => { await post(`/api/orders/${o.id}/cancel`); toast('ပယ်ဖျက်ရန် တောင်းဆိုပြီးပါပြီ'); load(); }); } }, 'Cancel'));
        listBox.append(h('div', { class: 'item' },
          h('div', { class: 'head' }, h('div', {}, h('b', {}, `#${o.id} `), o.service_name), badge(o.status)),
          h('div', { class: 'small mono mute' }, o.link),
          h('div', { class: 'small' }, `အရေအတွက် ${num(o.quantity)} · ${ks(o.charge_c)}`,
            o.refunded_c ? ` · ပြန်အမ်း ${ks(o.refunded_c)}` : '',
            o.remains != null && o.status !== 'Completed' ? ` · ကျန် ${num(o.remains)}` : '',
            o.start_count != null ? ` · စတင်ချိန် ${num(o.start_count)}` : ''),
          o.refill_status ? h('div', { class: 'small mute' }, 'Refill: ' + o.refill_status) : null,
          h('div', { class: 'small mute' }, when(o.created_at)), actions));
      }
      if (st.more) listBox.append(h('button', { class: 'btn sec block', onclick: (e) => guarded(e.target, async () => {
        const r = await get(`/api/orders?status=${encodeURIComponent(st.status)}&q=${encodeURIComponent(st.q)}&offset=${st.rows.length}`);
        st.rows.push(...r.orders); st.more = r.has_more; draw();
      }) }, 'ထပ်ကြည့်ရန်'));
    };
    const load = async () => {
      const r = await get(`/api/orders?status=${encodeURIComponent(st.status)}&q=${encodeURIComponent(st.q)}`);
      st.rows = r.orders; st.more = r.has_more; draw();
    };
    S.view = { tags: ['orders', 'services'], reload: load };
    drawChips();
    body.append(h('div', { class: 'card' }, h('h2', {}, 'မှာယူမှုများ'), search), chips, listBox);
    await load();
  }

  // ---------- customer: funds ----------
  async function fundsView() {
    const body = shell('#/funds');
    const info = await get('/api/payment-info');
    const histBox = h('div', { class: 'card' });
    const loadHist = async () => {
      const r = await get('/api/deposits');
      clear(histBox).append(h('h2', {}, 'ငွေဖြည့်မှတ်တမ်း'));
      if (!r.deposits.length) histBox.append(h('div', { class: 'empty' }, 'မှတ်တမ်း မရှိသေးပါ'));
      for (const d of r.deposits) {
        const k = d.status === 'approved' ? ['အတည်ပြုပြီး', 'ok'] : d.status === 'rejected' ? ['ပယ်ချ', 'bad'] : ['စောင့်ဆိုင်းဆဲ', 'warn'];
        histBox.append(h('div', { class: 'item' }, h('div', { class: 'head' }, h('b', {}, ks(d.amount_c)), h('span', { class: 'badge ' + k[1] }, k[0])),
          h('div', { class: 'small mute' }, `${d.method} · ${d.txn_ref} · ${when(d.created_at)}`), d.admin_note ? h('div', { class: 'small' }, d.admin_note) : null));
      }
    };
    S.view = { tags: ['funds', 'orders'], reload: loadHist };
    const accounts = h('div');
    if (!info.accounts.length) accounts.append(h('div', { class: 'note' }, 'ငွေပေးချေမှု အကောင့် မသတ်မှတ်ရသေးပါ။ ဆိုင်ရှင်ကို ဆက်သွယ်ပါ။'));
    for (const a of info.accounts) {
      accounts.append(h('div', { class: 'pm' }, h('b', {}, a.label), h('div', { class: 'mono' }, a.number), a.holder ? h('div', { class: 'small mute' }, a.holder) : null,
        h('button', { class: 'btn sm sec', onclick: async () => { try { await navigator.clipboard.writeText(a.number); toast('Copy ပြီးပါပြီ', 'ok'); } catch { toast(a.number); } } }, 'Copy')));
    }
    const method = h('select', {}, info.accounts.map((a) => h('option', { value: a.method }, a.label)));
    const amount = h('input', { type: 'number', inputmode: 'numeric', min: String(info.min_deposit_mmk), placeholder: `အနည်းဆုံး ${num(info.min_deposit_mmk)}` });
    const txn = h('input', { placeholder: 'ငွေလွှဲပြီးရရှိသော Transaction ID', autocapitalize: 'characters' });
    const note = h('input', { placeholder: 'မှတ်ချက် (မဖြည့်လည်းရ)', maxlength: '200' });
    const err = h('div', { class: 'err', style: 'display:none' });
    const btn = h('button', { class: 'btn block', type: 'submit', disabled: !info.accounts.length }, 'တင်ပြမည်');
    body.append(
      h('div', { class: 'card' }, h('h2', {}, 'လက်ကျန်ငွေ'), h('div', { class: 'stat' }, h('div', { class: 'v' }, ks(S.me.balance_c)))),
      h('div', { class: 'card' }, h('h2', {}, '၁။ ငွေလွှဲရန်'), accounts),
      h('div', { class: 'card' }, h('h2', {}, '၂။ လွှဲပြီးကြောင်း တင်ပြရန်'),
        h('form', { onsubmit: async (e) => {
          e.preventDefault(); err.style.display = 'none'; btn.disabled = true;
          try {
            await post('/api/deposits', { method: method.value, amount: Number(amount.value), txnRef: txn.value, note: note.value });
            toast('တင်ပြပြီးပါပြီ၊ အတည်ပြုရန် စောင့်ပါ', 'ok'); amount.value = ''; txn.value = ''; note.value = ''; loadHist();
          } catch (x) { err.textContent = x.message; err.style.display = ''; } finally { btn.disabled = !info.accounts.length; }
        } }, h('label', {}, 'နည်းလမ်း'), method, h('label', {}, 'ပမာဏ (ကျပ်)'), amount, h('label', {}, 'Transaction ID'), txn, h('label', {}, 'မှတ်ချက်'), note, err, btn)),
      histBox);
    await loadHist();
  }

  // ---------- customer: updates feed ----------
  const KIND = { rate: 'ဈေးနှုန်း', limits: 'အနည်း/အများ ကန့်သတ်ချက်', flags: 'Refill/Cancel', new: 'ဝန်ဆောင်မှုအသစ်', removed: 'ဖယ်ရှားခဲ့သည်', restored: 'ပြန်ရရှိသည်' };
  async function updatesView() {
    const body = shell('#/updates');
    const box = h('div', { class: 'card' });
    const load = async () => {
      const r = await get('/api/updates');
      clear(box).append(h('h2', {}, 'ဝန်ဆောင်မှု အပြောင်းအလဲများ'));
      if (!r.updates.length) box.append(h('div', { class: 'empty' }, 'အပြောင်းအလဲ မရှိသေးပါ'));
      for (const u of r.updates) {
        let detail = '';
        if (u.kind === 'rate') detail = `${num(u.old)} → ${num(u.new)} ကျပ် / ၁၀၀၀`;
        else if (u.old || u.new) detail = `${u.old ?? ''} → ${u.new ?? ''}`;
        const up = u.kind === 'rate' && u.new > u.old;
        box.append(h('div', { class: 'item' }, h('div', { class: 'head' }, h('b', {}, `#${u.service_id} ${u.name}`), h('span', { class: 'badge ' + (u.kind === 'rate' ? (up ? 'bad' : 'ok') : 'info') }, KIND[u.kind] || u.kind)),
          detail ? h('div', { class: up ? 'up' : u.kind === 'rate' ? 'down' : '' }, detail) : null, h('div', { class: 'small mute' }, when(u.created_at))));
      }
    };
    S.view = { tags: ['services'], reload: load };
    body.append(box);
    await load();
  }

  // ---------- account ----------
  async function accountView() {
    const body = shell('#/account');
    S.view = null;
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const nxt = h('input', { type: 'password', autocomplete: 'new-password' });
    body.append(
      h('div', { class: 'card' }, h('h2', {}, S.me.username), h('div', { class: 'mute small' }, `${S.me.email || ''} · ${S.me.role}`)),
      h('div', { class: 'card' }, h('h2', {}, 'စကားဝှက် ပြောင်းရန်'), h('label', {}, 'လက်ရှိ'), cur, h('label', {}, 'အသစ် (၈ လုံးနှင့်အထက်)'), nxt,
        h('button', { class: 'btn block', onclick: (e) => guarded(e.target, async () => { await post('/api/account/password', { current: cur.value, next: nxt.value }); cur.value = ''; nxt.value = ''; toast('ပြောင်းပြီးပါပြီ', 'ok'); }) }, 'ပြောင်းမည်')),
      isStaff() ? twoFaCard() : null,
      h('button', { class: 'btn sec block', onclick: async () => { try { await post('/api/logout'); } catch { /* ignore */ } S.me = null; S.services = null; closeLive(); location.hash = '#/login'; route(); } }, 'ထွက်မည်'));
  }
  function twoFaCard() {
    const box = h('div', { class: 'card' });
    const draw = () => {
      clear(box).append(h('h2', {}, '2FA (Authenticator app)'));
      const pw = h('input', { type: 'password', placeholder: 'စကားဝှက်' });
      if (S.me.totp_enabled) {
        const code = h('input', { placeholder: '2FA code', inputmode: 'numeric', maxlength: '6' });
        box.append(h('p', { class: 'badge ok' }, 'ဖွင့်ထားသည်'), pw, h('div', { class: 'row' }, code),
          h('button', { class: 'btn bad block', onclick: (e) => guarded(e.target, async () => { await post('/api/account/2fa/disable', { password: pw.value, code: code.value }); S.me.totp_enabled = false; draw(); toast('ပိတ်ပြီးပါပြီ'); }) }, 'ပိတ်မည်'));
      } else {
        box.append(h('p', { class: 'mute small' }, 'Owner/Staff အကောင့်ကို ပိုလုံခြုံစေရန် ဖွင့်ထားရန် အကြံပြုပါသည်။'), pw,
          h('button', { class: 'btn block', onclick: (e) => guarded(e.target, async () => {
            const r = await post('/api/account/2fa/setup', { password: pw.value });
            const code = h('input', { placeholder: 'App ထဲက code ၆ လုံး', inputmode: 'numeric', maxlength: '6' });
            clear(box).append(h('h2', {}, '2FA setup'), h('p', { class: 'small' }, 'Google Authenticator စသည့် app ထဲတွင် ဤ key ကို ထည့်ပါ:'), h('div', { class: 'mono card' }, r.secret),
              h('a', { href: r.uri, class: 'small' }, 'App ဖြင့် တိုက်ရိုက်ဖွင့်ရန်'), code,
              h('button', { class: 'btn block', onclick: (e2) => guarded(e2.target, async () => { await post('/api/account/2fa/enable', { code: code.value }); S.me.totp_enabled = true; draw(); toast('2FA ဖွင့်ပြီးပါပြီ', 'ok'); }) }, 'အတည်ပြုမည်'));
          }) }, 'Setup စမည်'));
      }
    };
    draw();
    return box;
  }

  // ---------- staff ----------
  async function adminDeposits() {
    const body = shell('#/admin/deposits', 'admin');
    let status = 'pending';
    const box = h('div', { class: 'card' });
    const chips = h('div', { class: 'tabs' });
    const load = async () => {
      clear(chips).append(...[['pending', 'စောင့်ဆိုင်းဆဲ'], ['approved', 'အတည်ပြုပြီး'], ['rejected', 'ပယ်ချပြီး']].map(([v, l]) => h('button', { class: 'chip' + (status === v ? ' on' : ''), onclick: () => { status = v; load(); } }, l)));
      const r = await get('/api/staff/deposits?status=' + status);
      clear(box);
      if (!r.deposits.length) box.append(h('div', { class: 'empty' }, 'မရှိပါ'));
      for (const d of r.deposits) {
        const act = status === 'pending' ? h('div', { class: 'row' },
          h('button', { class: 'btn sm ok', onclick: (e) => { const amt = prompt('အတည်ပြုမည့် ပမာဏ (ကျပ်)', String(d.amount_c / 100)); if (amt == null) return; guarded(e.target, async () => { await post(`/api/staff/deposits/${d.id}/approve`, { amount: Number(amt) }); toast('အတည်ပြုပြီး', 'ok'); load(); loadBadges(); }); } }, 'Approve'),
          h('button', { class: 'btn sm bad', onclick: (e) => { const why = prompt('ပယ်ချရသည့် အကြောင်းရင်း') ; if (why == null) return; guarded(e.target, async () => { await post(`/api/staff/deposits/${d.id}/reject`, { reason: why }); load(); loadBadges(); }); } }, 'Reject')) : null;
        box.append(h('div', { class: 'item' }, h('div', { class: 'head' }, h('b', {}, `${d.username} · ${ks(d.amount_c)}`), h('span', { class: 'badge' }, d.method)),
          h('div', { class: 'small mono' }, d.txn_ref), d.note ? h('div', { class: 'small' }, d.note) : null, h('div', { class: 'small mute' }, when(d.created_at)), act));
      }
    };
    S.view = { tags: ['staff'], reload: load };
    body.append(chips, box);
    await load();
  }

  async function adminOrders() {
    const body = shell('#/admin/orders', 'admin');
    let status = 'attention';
    let q = '';
    const box = h('div', { class: 'card' });
    const chips = h('div', { class: 'tabs' });
    const search = h('input', { placeholder: 'Order ID / username / link', type: 'search' });
    let timer;
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value; load(); }, 300); };
    const load = async () => {
      clear(chips).append(...[['attention', 'စစ်ဆေးရန်'], ['', 'အားလုံး'], ['Failed', 'မအောင်မြင်']].map(([v, l]) => h('button', { class: 'chip' + (status === v ? ' on' : ''), onclick: () => { status = v; load(); } }, l)));
      const r = await get(`/api/staff/orders?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`);
      clear(box);
      if (!r.orders.length) box.append(h('div', { class: 'empty' }, 'မရှိပါ'));
      for (const o of r.orders) {
        const act = o.status === 'Review' ? h('div', { class: 'row' },
          h('button', { class: 'btn sm bad', onclick: (e) => { if (confirm('ငွေပြန်အမ်းမလား? (upstream တွင် အော်ဒါ မရောက်ကြောင်း သေချာမှ)')) guarded(e.target, async () => { await post(`/api/staff/orders/${o.id}/resolve`, { action: 'refund' }); load(); loadBadges(); }); } }, 'Refund'),
          h('button', { class: 'btn sm sec', onclick: (e) => { const id = prompt('AuraBurma ရှိ order ID'); if (!id) return; guarded(e.target, async () => { await post(`/api/staff/orders/${o.id}/resolve`, { action: 'confirm', upstream_order_id: id }); load(); loadBadges(); }); } }, 'Upstream ID ချိတ်မည်')) : null;
        box.append(h('div', { class: 'item' }, h('div', { class: 'head' }, h('div', {}, h('b', {}, `#${o.id} `), `${o.username} · ${o.service_name}`), badge(o.status)),
          h('div', { class: 'small mono mute' }, o.link), h('div', { class: 'small' }, `${num(o.quantity)} · ${ks(o.charge_c)}${o.refunded_c ? ' · ပြန်အမ်း ' + ks(o.refunded_c) : ''}${o.upstream_order_id ? ' · up#' + o.upstream_order_id : ''}`),
          o.note ? h('div', { class: 'small mute' }, o.note) : null, h('div', { class: 'small mute' }, when(o.created_at)), act));
      }
    };
    S.view = { tags: ['staff', 'orders'], reload: load };
    body.append(h('div', { class: 'card' }, search), chips, box);
    await load();
  }

  async function adminUsers() {
    const body = shell('#/admin/users', 'admin');
    let q = '';
    const box = h('div', { class: 'card' });
    const search = h('input', { placeholder: 'username / email', type: 'search' });
    let timer;
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value; load(); }, 300); };
    const load = async () => {
      const r = await get('/api/staff/users?q=' + encodeURIComponent(q));
      clear(box);
      for (const u of r.users) {
        box.append(h('div', { class: 'item' }, h('div', { class: 'head' }, h('div', {}, h('b', {}, u.username), ' ', h('span', { class: 'badge' + (u.role === 'owner' ? ' info' : '') }, u.role), u.is_banned ? h('span', { class: 'badge bad' }, 'banned') : null), h('b', {}, ks(u.balance_c))),
          h('div', { class: 'small mute' }, `${u.email || '-'} · ${when(u.created_at)}`),
          h('div', { class: 'row' },
            isOwner() ? h('button', { class: 'btn sm sec', onclick: () => ownerUserModal(u.id, load) }, 'စီမံမည်') : null,
            u.role === 'owner' || u.id === S.me.id ? null : h('button', { class: 'btn sm ' + (u.is_banned ? 'ok' : 'bad'), onclick: (e) => guarded(e.target, async () => { await post(`/api/staff/users/${u.id}/ban`, { banned: !u.is_banned }); load(); }) }, u.is_banned ? 'Unban' : 'Ban'))));
      }
    };
    S.view = { tags: ['staff'], reload: load };
    body.append(h('div', { class: 'card' }, search), box);
    await load();
  }

  // ---------- owner ----------
  async function ownerUserModal(id, after) {
    const r = await get('/api/owner/users/' + id);
    const u = r.user;
    const amount = h('input', { type: 'number', inputmode: 'numeric', placeholder: 'ကျပ် (အနုတ်ဖြင့် နှုတ်နိုင်)' });
    const reason = h('input', { placeholder: 'အကြောင်းရင်း (လိုအပ်)' });
    const pw = h('input', { type: 'text', placeholder: 'စကားဝှက်အသစ်' });
    const m = modal([
      h('h2', {}, `${u.username} · ${ks(u.balance_c)}`), h('div', { class: 'small mute' }, `${u.email || '-'} · ${u.role}${u.totp_enabled ? ' · 2FA' : ''}`),
      h('h3', {}, 'လက်ကျန်ငွေ ချိန်ညှိ'), amount, reason,
      h('button', { class: 'btn block', onclick: (e) => guarded(e.target, async () => { await post(`/api/owner/users/${id}/adjust`, { amount: Number(amount.value), reason: reason.value }); toast('ပြီးပါပြီ', 'ok'); m.remove(); after && after(); }) }, 'ချိန်ညှိမည်'),
      u.role !== 'owner' ? [
        h('h3', {}, 'Role'),
        h('button', { class: 'btn sec block', onclick: (e) => guarded(e.target, async () => { await post(`/api/owner/users/${id}/role`, { role: u.role === 'staff' ? 'user' : 'staff' }); m.remove(); after && after(); }) }, u.role === 'staff' ? 'Staff မှ ဖယ်မည်' : 'Staff ခန့်မည်'),
        h('h3', {}, 'စကားဝှက် reset'), pw,
        h('button', { class: 'btn sec block', onclick: (e) => guarded(e.target, async () => { await post(`/api/owner/users/${id}/password`, { password: pw.value }); toast('Reset ပြီးပါပြီ', 'ok'); }) }, 'Reset'),
      ] : null,
      h('h3', {}, 'လတ်တလော မှတ်တမ်း'),
      h('div', { class: 'scroll' }, h('table', {}, h('tbody', {}, r.ledger.slice(0, 12).map((l) => h('tr', {}, h('td', {}, when(l.created_at)), h('td', {}, l.reason), h('td', { class: 'right' }, (l.delta_c > 0 ? '+' : '') + num(l.delta_c / 100))))))),
      h('button', { class: 'btn sec block', onclick: () => m.remove() }, 'ပိတ်မည်'),
    ]);
  }

  function statBox(k, v, s) { return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null); }

  async function ownerOverview() {
    const body = shell('#/owner', 'owner');
    const box = h('div');
    const load = async () => {
      const o = await get('/api/owner/overview');
      const c = o.counts;
      const alerts = [];
      if (o.upstream.error) alerts.push('AuraBurma နှင့် ချိတ်ဆက်၍မရပါ: ' + o.upstream.error);
      if (!o.upstream.configured) alerts.push('UPSTREAM_API_KEY မထည့်ရသေးပါ (.env)');
      if (o.upstream.balance_mmk != null && o.upstream.balance_mmk < o.low_balance_threshold_mmk) alerts.push('AuraBurma လက်ကျန်ငွေ နည်းနေပါသည် — ငွေဖြည့်ပါ');
      if (c.review_orders) alerts.push(`${c.review_orders} ခု စစ်ဆေးရန် ရှိသည်`);
      if (c.pending_deposits) alerts.push(`${c.pending_deposits} ခု ငွေဖြည့်တောင်းဆိုမှု စောင့်ဆိုင်းနေသည်`);
      if (o.rate_increases_24h) alerts.push(`ယနေ့ AuraBurma က ဈေးတက်ထားသော ဝန်ဆောင်မှု ${o.rate_increases_24h} ခု`);
      const max = Math.max(1, ...o.series.map((d) => d.revenue_c));
      const bars = h('div', { class: 'bars' }, o.series.map((d) => { const b = h('div', { class: 'b', title: `${d.day}: ${ks(d.revenue_c)} / အမြတ် ${ks(d.profit_c)}` }); b.style.height = Math.max(2, (d.revenue_c / max) * 100) + '%'; return b; }));
      clear(box).append(
        alerts.length ? h('div', { class: 'note' }, alerts.map((a) => h('div', {}, '⚠ ' + a))) : null,
        h('div', { class: 'grid g2' },
          statBox('AuraBurma လက်ကျန်', o.upstream.balance != null ? `$${num(o.upstream.balance)}` : '-', o.upstream.balance_mmk != null ? `≈ ${num(o.upstream.balance_mmk)} ကျပ်` : null),
          statBox('Customers ၏ လက်ကျန်စုစုပေါင်း', ks(o.customer_balances_c), 'ဆိုင်က ပြန်ပေးရန် တာဝန်'),
          statBox('ယနေ့ ရောင်းအား', ks(o.today.revenue_c), `အမြတ် ${ks(Math.round(o.today.revenue_c - o.today.cost_mmk * 100))} · ${o.today.orders} orders`),
          statBox('၃၀ ရက် ရောင်းအား', ks(o.last_30_days.revenue_c), `အမြတ် ${ks(Math.round(o.last_30_days.revenue_c - o.last_30_days.cost_mmk * 100))}`),
          statBox('စုစုပေါင်း ရောင်းအား', ks(o.all_time.revenue_c), `အမြတ် ${ks(Math.round(o.all_time.revenue_c - o.all_time.cost_mmk * 100))}`),
          statBox('Customers', num(c.users), `Staff ${c.staff} · Active orders ${c.active_orders}`)),
        h('div', { class: 'card' }, h('h2', {}, 'နောက်ဆုံး ၁၄ ရက် ရောင်းအား'), bars,
          h('div', { class: 'barlbl' }, o.series.map((d) => h('span', {}, d.day.slice(5))))),
        h('div', { class: 'card' }, h('h2', {}, 'ရောင်းအားအကောင်းဆုံး (၃၀ ရက်)'),
          o.top_services.length ? o.top_services.map((t) => h('div', { class: 'item row' }, h('div', { class: 'grow' }, t.service_name), h('b', {}, ks(t.revenue_c)), h('span', { class: 'mute small' }, t.orders + ' orders'))) : h('div', { class: 'empty' }, 'မရှိသေးပါ')),
        h('div', { class: 'card' }, h('h2', {}, 'AuraBurma နှင့် Sync'),
          h('div', { class: 'small mute' }, `ဝန်ဆောင်မှုများ ${o.sync_every_sec.services}s တစ်ကြိမ် / အော်ဒါများ ${o.sync_every_sec.orders}s တစ်ကြိမ် စစ်သည် · နောက်ဆုံး ${when(o.services_synced_at)} · ၂၄ နာရီအတွင်း ပြောင်းလဲမှု ${o.changes_24h}`),
          h('div', { class: 'row' },
            h('button', { class: 'btn sm', onclick: (e) => guarded(e.target, async () => { const r = await post('/api/owner/sync', { what: 'services' }); toast(`Sync ပြီး — ပြောင်းလဲမှု ${r.changes}`, 'ok'); load(); }) }, 'ဝန်ဆောင်မှု ယခု Sync'),
            h('button', { class: 'btn sm sec', onclick: (e) => guarded(e.target, async () => { const r = await post('/api/owner/sync', { what: 'orders' }); toast(`Orders updated ${r.updated}`, 'ok'); load(); }) }, 'Orders ယခု Sync'))));
    };
    S.view = { tags: ['services', 'orders', 'staff', 'balance'], reload: load };
    body.append(box);
    await load();
  }

  async function ownerServices() {
    const body = shell('#/owner/services', 'owner');
    let q = '';
    const box = h('div');
    const search = h('input', { placeholder: 'ID / နာမည် / category ရှာရန်', type: 'search' });
    let timer;
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value; load(); }, 300); };
    const edit = (s) => {
      const name = h('input', { value: s.custom_name || '', placeholder: s.name });
      const desc = h('textarea', { value: s.description || '' });
      const mk = h('input', { type: 'number', step: 'any', value: s.markup_override ?? '', placeholder: `Global (${s.markup_effective}%)` });
      const m = modal([h('h2', {}, `#${s.id} ${s.name}`), h('div', { class: 'small mute' }, `Cost ${num(s.cost_per_thousand_mmk)} → Sell ${num(s.sell_per_thousand_mmk)} ကျပ်/၁၀၀၀`),
        h('label', {}, 'ပြသမည့် နာမည်'), name, h('label', {}, 'Markup % (ဗလာ = global)'), mk, h('label', {}, 'ဖော်ပြချက်'), desc,
        h('button', { class: 'btn block', onclick: (e) => guarded(e.target, async () => { await post('/api/owner/services/' + s.id, { custom_name: name.value, description: desc.value, markup_override: mk.value === '' ? null : Number(mk.value) }); m.remove(); load(); }) }, 'သိမ်းမည်'),
        h('button', { class: 'btn sec block', onclick: () => m.remove() }, 'ပိတ်မည်')]);
    };
    const load = async () => {
      const r = await get('/api/owner/services?q=' + encodeURIComponent(q));
      const byCat = new Map();
      for (const s of r.services) { if (!byCat.has(s.category)) byCat.set(s.category, []); byCat.get(s.category).push(s); }
      clear(box);
      for (const [cat, rows] of byCat) {
        const card = h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, `${cat} (${rows.length})`),
          h('button', { class: 'btn sm sec', onclick: (e) => guarded(e.target, async () => { await post('/api/owner/services/bulk', { category: cat, enabled: true }); load(); }) }, 'အားလုံးဖွင့်'),
          h('button', { class: 'btn sm sec', onclick: (e) => guarded(e.target, async () => { await post('/api/owner/services/bulk', { category: cat, enabled: false }); load(); }) }, 'အားလုံးပိတ်'),
          h('button', { class: 'btn sm sec', onclick: (e) => { const v = prompt(`${cat} အားလုံးအတွက် Markup % (ဗလာ = global)`); if (v == null) return; guarded(e.target, async () => { await post('/api/owner/services/bulk', { category: cat, markup_override: v === '' ? null : Number(v) }); load(); }); } }, 'Markup %')));
        for (const s of rows) {
          card.append(h('div', { class: 'item' }, h('div', { class: 'head' }, h('div', {}, h('b', {}, `#${s.id} `), s.custom_name || s.name, s.missing ? h('span', { class: 'badge bad' }, 'AuraBurma တွင်မရှိ') : null, !s.supported ? h('span', { class: 'badge' }, s.type + ' (မပံ့ပိုး)') : null),
            h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: s.enabled, disabled: !s.supported, onchange: (e) => guarded(e.target, async () => { await post('/api/owner/services/' + s.id, { enabled: e.target.checked }); load(); }) }), 'ရောင်းမည်')),
            h('div', { class: 'small' }, `Cost ${num(s.cost_per_thousand_mmk)} → Sell ${num(s.sell_per_thousand_mmk)} ကျပ်/၁၀၀၀ · Markup ${s.markup_effective}%${s.markup_override != null ? ' (သီးသန့်)' : ''} · ${num(s.min)}–${num(s.max)}`),
            h('button', { class: 'btn sm sec', onclick: () => edit(s) }, 'ပြင်မည်')));
        }
        box.append(card);
      }
      if (!byCat.size) box.append(h('div', { class: 'card empty' }, 'မရှိပါ — Overview မှ Sync လုပ်ပါ'));
    };
    S.view = { tags: ['services'], reload: load };
    body.append(h('div', { class: 'card' }, search), box);
    await load();
  }

  async function ownerChanges() {
    const body = shell('#/owner/changes', 'owner');
    const box = h('div', { class: 'card' });
    const load = async () => {
      const r = await get('/api/owner/changes');
      clear(box).append(h('h2', {}, 'AuraBurma မှ ပြောင်းလဲမှုများ'), h('p', { class: 'small mute' }, 'AuraBurma ဘက်က ပြောင်းလိုက်သမျှ ဤနေရာတွင် မြင်ရပြီး သင့် app ထဲသို့ အလိုအလျောက် ပြောင်းသွားပါသည်။'));
      if (!r.changes.length) box.append(h('div', { class: 'empty' }, 'ပြောင်းလဲမှု မရှိသေးပါ'));
      for (const c of r.changes) {
        let d = '';
        if (c.kind === 'rate') d = `$${c.old} → $${c.new} (${c.change_pct > 0 ? '+' : ''}${c.change_pct}%) · Sell ${num(c.new_sell_per_thousand_mmk)} ကျပ်/၁၀၀၀ · Cost ${num(c.new_cost_per_thousand_mmk)}`;
        else if (c.old || c.new) d = `${c.old ?? ''} → ${c.new ?? ''}`;
        box.append(h('div', { class: 'item' }, h('div', { class: 'head' }, h('b', {}, `#${c.service_id} ${c.name}`), h('span', { class: 'badge ' + (c.kind === 'rate' && c.change_pct > 0 ? 'bad' : 'info') }, KIND[c.kind] || c.kind)),
          d ? h('div', { class: c.kind === 'rate' && c.change_pct > 0 ? 'up' : '' }, d) : null, h('div', { class: 'small mute' }, when(c.created_at))));
      }
    };
    S.view = { tags: ['services'], reload: load };
    body.append(box);
    await load();
  }

  async function ownerSettings() {
    const body = shell('#/owner/settings', 'owner');
    S.view = null;
    const r = await get('/api/owner/settings');
    const s = r.settings;
    const f = (label, el) => [h('label', {}, label), el];
    const site = h('input', { value: s.site_name });
    const markup = h('input', { type: 'number', step: 'any', value: s.markup_percent });
    const fx = h('input', { type: 'number', step: 'any', value: s.usd_mmk });
    const mind = h('input', { type: 'number', value: s.min_deposit_mmk });
    const ann = h('textarea', { value: s.announcement || '' });
    const sup = h('input', { value: s.support_contact || '' });
    const pms = h('div');
    const accounts = s.payment_accounts.map((a) => ({ ...a }));
    const drawPm = () => {
      clear(pms);
      accounts.forEach((a, i) => {
        const inp = (k, ph) => h('input', { value: a[k] || '', placeholder: ph, oninput: (e) => { a[k] = e.target.value; } });
        pms.append(h('div', { class: 'pm' }, inp('method', 'code (wave, kbz, aya...)'), inp('label', 'ပြသမည့်နာမည်'), inp('number', 'ဖုန်း/အကောင့်နံပါတ်'), inp('holder', 'အကောင့်ပိုင်ရှင်'),
          h('button', { class: 'btn sm bad', onclick: () => { accounts.splice(i, 1); drawPm(); } }, 'ဖယ်ရှား')));
      });
      if (accounts.length < 6) pms.append(h('button', { class: 'btn sm sec', onclick: () => { accounts.push({ method: '', label: '', number: '', holder: '' }); drawPm(); } }, '+ အကောင့်ထည့်'));
    };
    drawPm();
    body.append(
      h('div', { class: 'card' }, h('h2', {}, 'ဆိုင် Settings'),
        f('ဆိုင်နာမည်', site), f('Markup % (AuraBurma ဈေးအပေါ် ထပ်ပေါင်း)', markup), f('USD → ကျပ် rate', fx), f('အနည်းဆုံး ငွေဖြည့်ပမာဏ', mind), f('Announcement', ann), f('Support contact', sup),
        h('p', { class: 'small mute' }, `Upstream: ${r.upstream_url} · API key ${r.upstream_configured ? 'ထည့်ပြီး' : 'မထည့်ရသေးပါ (.env)'}`),
        h('button', { class: 'btn block', onclick: (e) => guarded(e.target, async () => {
          await post('/api/owner/settings', { site_name: site.value, markup_percent: Number(markup.value), usd_mmk: Number(fx.value), min_deposit_mmk: Number(mind.value), announcement: ann.value, support_contact: sup.value });
          S.pub = await get('/api/public'); S.services = null; toast('သိမ်းပြီးပါပြီ', 'ok');
        }) }, 'သိမ်းမည်')),
      h('div', { class: 'card' }, h('h2', {}, 'ငွေလက်ခံမည့် အကောင့်များ'), pms,
        h('button', { class: 'btn block', onclick: (e) => guarded(e.target, async () => { await post('/api/owner/settings', { payment_accounts: accounts }); toast('သိမ်းပြီးပါပြီ', 'ok'); }) }, 'သိမ်းမည်')));
  }

  async function ownerAudit() {
    const body = shell('#/owner/audit', 'owner');
    S.view = null;
    const r = await get('/api/owner/audit');
    body.append(h('div', { class: 'card' }, h('h2', {}, 'Audit log'),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'အချိန်'), h('th', {}, 'ဘယ်သူ'), h('th', {}, 'လုပ်ဆောင်ချက်'), h('th', {}, 'အသေးစိတ်'))),
        h('tbody', {}, r.entries.map((e) => h('tr', {}, h('td', {}, when(e.created_at)), h('td', {}, e.actor_name), h('td', {}, e.action), h('td', { class: 'small' }, [e.target, e.detail].filter(Boolean).join(' · ')))))))));
  }

  // ---------- router ----------
  const ROUTES = {
    '#/new': newOrderView, '#/orders': ordersView, '#/funds': fundsView, '#/updates': updatesView, '#/account': accountView,
    '#/admin/deposits': adminDeposits, '#/admin/orders': adminOrders, '#/admin/users': adminUsers,
    '#/owner': ownerOverview, '#/owner/services': ownerServices, '#/owner/changes': ownerChanges, '#/owner/settings': ownerSettings, '#/owner/audit': ownerAudit,
  };
  async function route() {
    S.view = null;
    if (!S.me) { authView(); return; }
    openLive();
    let hash = location.hash || '#/new';
    if (hash === '#/login') hash = '#/new';
    const fn = ROUTES[hash];
    if (!fn || (hash.startsWith('#/owner') && !isOwner()) || (hash.startsWith('#/admin') && !isStaff())) { location.hash = '#/new'; return; }
    try { await fn(); } catch (e) { if (S.me) toast(e.message, 'bad'); }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  // Phones sleep tabs; when the app comes back, catch up on anything missed.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !S.me) return;
    try { S.me = (await get('/api/me')).user; paintBalance(); S.services = null; refreshView(); } catch { /* ignore */ }
    if (S.es && S.es.readyState === 2) { S.es = null; openLive(); }
  });

  (async () => {
    try { S.pub = await get('/api/public'); document.title = S.pub.site_name || 'Boostmm'; } catch { /* ignore */ }
    try { S.me = (await get('/api/me')).user; } catch { S.me = null; }
    route();
  })();
})();
