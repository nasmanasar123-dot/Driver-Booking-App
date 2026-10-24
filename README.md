# Driver Booking

On-demand driver service for Dubai: customers book a driver to drive **their own car**, pay in cash
after the trip, and the platform takes a commission that drivers settle with ops.

```
apps/api        Node + Fastify + SQLite (better-sqlite3) + Socket.IO
apps/customer   Customer PWA      (React + Vite)   dev: http://localhost:5173
apps/driver     Driver PWA                          dev: http://localhost:5174
apps/admin      Ops dashboard                        dev: http://localhost:5175
packages/shared API client, live updates, Google sign-in screen, types, styles
deploy/         Caddy, systemd and Litestream configs for the VPS
```

## Running locally

Requires Node 22.18+ (the API runs TypeScript directly, no build step).

```sh
npm install
npm run create-admin -w apps/api -- you@gmail.com "Your Name"
npm run dev           # API + all three apps
npm test              # API tests
```

**Signing in:** everyone signs in with Google. Each Google account is one role: an account that
signed up as a customer can't also be a driver. Admins must be created first with `create-admin`.

While developing you don't need Google at all: the sign-in screen has a **development sign-in** box where
you type any email (e.g. `driver1@test.com`, `customer1@test.com`). It's switched off automatically in production.

The customer and driver apps also have a "dev only" option to use a Downtown Dubai location, so you can test from anywhere.

To try the whole flow, open the three apps side by side:
1. **Driver app**: sign in, fill in details (incl. mobile number). **Admin** (sign in with your admin email): approve them under Drivers. **Driver**: go online.
2. **Customer app**: sign in, add name, mobile number and car, then book. The driver gets the request live.
3. Driver accepts → customer sees the 4-digit start code → driver enters it → trip starts → driver ends trip and collects cash.
4. **Admin → Drivers → Account**: record the driver's commission settlement.

## Setting up Google sign-in

1. Go to <https://console.cloud.google.com/>, create a project (e.g. "Driver Booking").
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in app name and your email.
   While it's in *Testing* mode, only the Google accounts you add as test users can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
   Under **Authorized JavaScript origins** add:
   - `http://localhost:5173`, `http://localhost:5174`, `http://localhost:5175` (development)
   - later, your real domains, e.g. `https://app.example.com`, `https://driver.example.com`, `https://ops.example.com`
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) into `apps/api/.env`:
   ```
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   ```
5. Restart `npm run dev`. The "Continue with Google" button appears on all three sign-in screens.

There's no client secret to manage: the apps get a signed ID token from Google, and the API verifies it against your client ID.

## How it works

**Booking states:** `requested → assigned → started → completed`, or `cancelled` from any open state.

**Dispatch:** a new booking is offered to approved, online drivers within 15 km (with a location ping in the
last 5 minutes, not on another trip, and able to drive manual if the car is manual). First driver to accept gets it.
If nobody is nearby, or nobody accepts within 90 seconds, it lands in the admin **Dispatch** tab for manual assignment.

**Pricing** (editable in admin, placeholders for now): AED 120 minimum covering 2 hours, then AED 12.50 per
15 minutes, +20% between 22:00 and 06:00 Dubai time, +AED 30 for one-way trips, rounded up to a whole dirham.
Each booking saves the pricing settings at booking time; the final fare is based on actual trip time.

**Cash and commission:** when a trip completes, the commission (default 20%) is recorded as owed by the driver.
Ops record settlements when drivers pay. A driver owing more than AED 500 (`MAX_CASH_OWED_AED`) can't go online.

**Phone numbers** are collected in the profile so drivers and customers can call each other. They aren't
verified by SMS; ops can check a driver's number during approval.

## Deploying to the VPS (Ubuntu)

1. Install Node 22.18+ and Caddy; create a `driverbooking` user; clone to `/srv/driver-booking`.
2. `npm ci && npm run build`
3. `cp apps/api/.env.example apps/api/.env`; set `JWT_SECRET` (`openssl rand -hex 32`) and `GOOGLE_CLIENT_ID`.
4. Install `deploy/driver-booking-api.service` into systemd, then `systemctl enable --now driver-booking-api`.
   It sets `NODE_ENV=production`, which turns off the development sign-in.
5. Edit domains in `deploy/Caddyfile`, copy to `/etc/caddy/Caddyfile`, `systemctl reload caddy`.
   Add the same domains as authorized JavaScript origins in Google Cloud Console.
6. Set up Litestream backups (`deploy/litestream.yml`). **Don't skip this**: the database is one file on one server.
7. `npm run create-admin -w apps/api -- you@gmail.com`

## Before launch

- [ ] Google OAuth consent screen published (out of *Testing*) so any Google account can sign in
- [ ] PNG app icons (192×192, 512×512) in each `public/`; the current SVG icons are placeholders
- [ ] Real pricing numbers
- [ ] Terms of service covering damage to the car, traffic fines and Salik tolls during trips

## Later

- Online payments with Stripe or Network International (currently cash only)
- SMS-verified phone numbers
- Pin-drop map for pickup, driver document uploads, cancellation fees, scheduled bookings
