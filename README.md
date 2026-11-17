# Shop Manager — Inventory + POS + Purchases + Seller + Reporting System

A production-quality inventory, point-of-sale, purchasing, and reporting
system built with React + Vite + Tailwind (frontend), Node.js + Express
(backend), and MongoDB + Mongoose.

## Stack

- **Frontend:** React 19, Vite, Tailwind CSS v4, React Router, Recharts, Axios
- **Backend:** Node.js, Express, Mongoose, JWT auth (jsonwebtoken + bcryptjs)
- **Database:** MongoDB

## Getting Started

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env    # edit MONGO_URI / JWT_SECRET if needed
npm run seed             # creates a local dev admin user + sample inventory
npm run dev               # starts the API on http://localhost:5010
```

Seeded login (local dev only, via `npm run seed`): **admin / admin123**

For a real deployment, use `npm run seed:admin` instead (see "Production
deployment" below) -- it never uses a hardcoded password.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev               # starts the app on http://localhost:5173
```

In development the frontend talks to the API directly at the URL in
`frontend/.env.development` (`VITE_API_URL`, defaults to
`http://localhost:5010/api`); the Vite dev server's `/api` proxy (also
pointed at port 5010) is kept as a fallback for tooling that relies on it.

### 3. Production build

```bash
cd frontend
npm run build              # outputs static files to frontend/dist
```

`frontend/.env.production` sets `VITE_API_URL=https://inventory.elivateict.com/api`
at build time -- update it if you deploy to a different domain. Serve
`frontend/dist` as static files behind Nginx (or any reverse proxy) on the
public domain, and proxy `/api/` on that same domain to the backend:

```nginx
# In the server { ... } block for the domain:
server_tokens off;   # do not show the nginx version
add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
# Content Security Policy: which scripts/styles/fonts the browser may load.
# Starts as Report-Only (blocks nothing, only reports in the browser console);
# once a few days of normal use show no reports, change the header name to
# "Content-Security-Policy" to enforce it. The sha256 is the small theme
# script in frontend/index.html -- update it if that script ever changes.
add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self' 'sha256-bH0s6beOr52B/5Bx0dgS8nQE1FW6cHpLnjyZY/1trac='; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;

location /api/ {
    # A generous ceiling per address (every till in a shop shares one
    # internet address, and the POS loads a quotation's items all at once):
    # 50 requests a second, bursts of 200. See
    # the limit_req_zone line below, which goes in the http { ... } block.
    limit_req zone=api burst=200 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:5010;
    # The visitor's real address -- the login attempt limit counts by it.
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
}
```

```nginx
# In the http { ... } block (e.g. /etc/nginx/nginx.conf), once:
limit_req_zone $binary_remote_addr zone=api:10m rate=50r/s;
```

The backend listens on `0.0.0.0:5010` by default (see `PORT` in the backend
`.env`) and must never be reachable from the internet directly -- only via the
reverse proxy on the same public domain. With nginx on the same machine, set
`HOST=127.0.0.1` in the backend `.env` so the API port is closed to the
network, and/or block it in the firewall:

```bash
sudo ufw deny 5010
```

Set `CLIENT_ORIGIN` in the backend
`.env` to a comma-separated list of the origins allowed to call the API
(your deployed frontend origin, plus `http://localhost:5173` for local dev
against a shared backend).

### 4. Production admin account

```bash
cd backend
# set SEED_ADMIN_EMAIL / SEED_ADMIN_NAME / SEED_ADMIN_PASSWORD in .env first
npm run seed:admin
```

This creates exactly one admin user from environment variables (never a
hardcoded password), and safely no-ops if that username already exists.

Public sign-up (`POST /api/auth/register`) is closed: on a new or wiped
database, whoever reached it first would become the admin. `seed:admin` is
the way to create the first admin. (Only if you really need the old sign-up
for a brand-new install, set `ALLOW_REGISTER=true` in `.env`, restart, sign
up, then remove it and restart again.)

### 5. Updating the server (nagaad.online)

```bash
cd /var/www/nagaad && git pull
cd /var/www/nagaad/backend && npm ci --omit=dev && pm2 restart nagaad-api
cd /var/www/nagaad/frontend && npm ci && npm run build
```

### 6. Server maintenance commands (run in `/var/www/nagaad/backend`)

| Command | What it does |
|---|---|
| `npm run reset:admin` | New password for `admin` (asks for it, hidden, twice). Another user: `npm run reset:admin -- name@example.com`. Give a user from before emails an email at the same time: `npm run reset:admin -- admin --email name@example.com`. Signs out logins made with the old password. |
| `npm run seed:admin` | Creates the first admin from `SEED_ADMIN_*` in `.env` (for a new or wiped database). |
| `npm run db:wipe` | **Deletes everything** in the database in `MONGO_URI`. Shows what is there and asks you to type the database name. Cannot be undone -- back up first. |
| `npm run db:wipe -- --keep-super-admin` | **Deletes everything except the Super Admin's account**: sign in as before and start clean (on restart the server creates "Main Branch" with the default accounts). Same confirmation; cannot be undone -- back up first. |

New JWT secret (everyone signs in again):

```bash
NEW=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$NEW|" .env && pm2 restart nagaad-api
```

Backup before anything risky:

```bash
mongodump --uri "$(grep '^MONGO_URI=' .env | cut -d= -f2-)" --out ~/nagaad-backup-$(date +%F)
```

## Architecture notes

- **Money** is stored as integer cents (`*Cents` fields) throughout the
  database to avoid floating-point accounting bugs. The API converts to/from
  decimal dollars at the boundary.
- **Sale/Purchase atomicity**: `backend/src/utils/transaction.js` wraps the
  sale and purchase creation/void flows in a MongoDB session transaction,
  falling back to sequential (non-transactional) execution if the server is
  a standalone instance without replica-set support. For true atomicity in
  production, deploy MongoDB as a replica set (MongoDB Atlas does this by
  default).
- **Historical cost/profit**: every sale line stores the item's cost price
  *at the time of sale*, so profit reports remain accurate even after an
  item's current cost price changes later.
- **Customer search UX**: the POS never uses a customer dropdown. The seller
  types a name, matching customers appear live (debounced), and if none
  match, a customer can be created inline without leaving the sale.
- **Stock validation** happens server-side on every sale. An item may be
  sold with none in stock (its stock goes negative, and the next stock
  received makes it up first); the one exception is when expired units of
  it are still on hand -- those must be removed with Stock Adjustment first.
- **Price changes at the till** are allowed (rate, line discount, invoice
  discount) and each one is recorded in the audit log as
  `sale.price_override` (who, which item, list price, price sold at).
- **Voiding** sales/purchases (rather than deleting) preserves the audit
  trail: stock and customer/supplier balances are reversed, and the record
  is marked `voided` with a reason.

## Default credentials

| Username | Password | Role  |
|----------|----------|-------|
| admin    | admin123 | admin |

Local development only. On a real server, create the first admin with
`npm run seed:admin` and add everyone else on the Users page.
