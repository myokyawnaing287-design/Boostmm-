# Boostmm — AuraBurma Reseller (AuraBurma API)

Zero-dependency Node.js (>= 22.13) storefront + Owner Dashboard. Customers deposit Kyats, order services,
and every order is forwarded to AuraBurma with YOUR API key. Prices = AuraBurma price × USD rate × (1 + markup%).

## Run
```
cp .env.example .env      # fill UPSTREAM_API_KEY and OWNER_PASSWORD
node src/server.js        # http://localhost:3000
```
Log in at `/` with the owner email (myokyawnaing287@gmail.com) or username `owner`.
Put it behind HTTPS (Caddy/nginx/Cloudflare) and keep `COOKIE_SECURE=true`.
Back up `data/shop.db` regularly — it holds all balances.

## AuraBurma changes → your app
AuraBurma has no webhooks, so the server polls it: services every `SERVICES_SYNC_SEC` (120s), orders every
`SYNC_INTERVAL_SEC` (60s). Any change (price, min/max, refill/cancel flags, new/removed service) is
saved, shown in Owner → "AuraBurma ပြောင်းလဲမှု", re-priced instantly, and pushed live to every open
app (Server-Sent Events) — no refresh needed. Customers see price changes in "အပြောင်းအလဲ" in your selling price only.
Removed upstream services disappear from the shop automatically.

## Owner Dashboard (owner only, enforced on the server)
Overview (profit, upstream balance, alerts) · Services (enable, markup per service/category, rename, description) ·
Changes feed · Users (adjust balance with reason, staff role, reset password, ban) · Deposits · Orders (resolve
"Review" orders) · Settings (shop name, markup, USD rate, payment accounts) · Audit log · 2FA (Account page).

## Safety rules built in
- Every balance change is a ledger row; balance can never go negative; refunds can never exceed the charge.
- Retrying an order (bad network) never double-charges. If AuraBurma's answer is unknown (timeout), the order
  goes to "Review" — the money is held, nothing is lost — and you choose Refund or attach the upstream ID.
- Definite rejection by AuraBurma → automatic refund. Cancel/Partial from AuraBurma → automatic (proportional) refund.
- Deposits are manual: customer submits a unique transaction ID, you verify in your Wave/KBZ app and approve.

## Tests
`node test/e2e.js` (101 checks, mock AuraBurma) · `node test/ui-smoke.js` (real browser; needs playwright).

## Before going live
1. Create a NEW AuraBurma API key (the one shared in chat must be treated as leaked).
2. Check AuraBurma's terms allow reselling via API.
3. Supported order types: Default and Custom Comments. Other types (Poll, Subscriptions, Package…) stay disabled.

## Deploy (Docker / any host)
`docker build -t shop . && docker run -d -p 3000:3000 -v shopdata:/data -e UPSTREAM_API_KEY=... -e OWNER_PASSWORD=... shop`
The `/data` volume MUST be persistent (it holds the database). Platforms with a free, non-persistent disk will lose all balances on restart.
