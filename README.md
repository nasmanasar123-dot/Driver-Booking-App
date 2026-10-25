# Driver Booking

On-demand driver service for Kochi, India: customers book a driver to drive **their own car**, pay in cash
after the trip, and the platform takes a commission that drivers settle with ops.

```
apps/api        Node + Fastify + SQLite (better-sqlite3) + Socket.IO
apps/customer   Customer PWA      (React + Vite)   dev: http://localhost:5173
apps/driver     Driver PWA                          dev: http://localhost:5174
apps/admin      Ops dashboard                        dev: http://localhost:5175
packages/shared API client, live updates, Google sign-in screen, types, styles
deploy/         systemd user service for the course server
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

The customer and driver apps also have a "dev only" option to use a location in Edappally, Kochi, so you can test from anywhere.

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
   - `https://driverbooking-nasmanasar123.dhilber.in` (production: one address serves all three apps)
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) into `apps/api/.env`:
   ```
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   ```
5. Restart `npm run dev`. The "Continue with Google" button appears on all three sign-in screens.

There's no client secret to manage: the apps get a signed ID token from Google, and the API verifies it against your client ID.

## Setting up Razorpay (online payments)

Optional: without keys the app is cash only. With keys, customers choose **Cash to driver** or **UPI / card in app**
when booking. Online customers pay the final fare in the app after the trip; the driver's earning is then credited
to their account (shown as "owed to you") and ops pays it out (Admin → Drivers → Account → *Paid to driver*).

1. Sign up at <https://dashboard.razorpay.com/>. Stay in **Test mode** (toggle at the top) until you're ready to take real money.
2. **Account & Settings → API Keys → Generate key.** Copy both into `apps/api/.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxx
   ```
3. **Account & Settings → Webhooks → Add new webhook**:
   - **Webhook URL:** `https://driverbooking-nasmanasar123.dhilber.in/api/payments/razorpay/webhook`
   - **Secret:** make up a long random string, and put the same value in `.env` as `RAZORPAY_WEBHOOK_SECRET`
   - **Active events:** `payment.captured` and `order.paid`
4. Restart the API.

Razorpay can't reach `localhost`. To test the webhook from your own computer, run a tunnel to the API, e.g.
`cloudflared tunnel --url http://localhost:4000`, and use `https://<random>.trycloudflare.com/api/payments/razorpay/webhook`. Payments still work without the webhook, since the app
also confirms them when checkout finishes; the webhook covers customers who close the app mid-payment.

If an online customer pays the driver in cash instead, ops can click **Paid in cash** on the booking (Admin → Bookings).

## How it works

**Booking states:** `requested → assigned → started → completed`, or `cancelled` from any open state.

**Dispatch:** a new booking is offered to approved, online drivers within 15 km (with a location ping in the
last 5 minutes, not on another trip, and able to drive manual if the car is manual). First driver to accept gets it.
If nobody is nearby, or nobody accepts within 90 seconds, it lands in the admin **Dispatch** tab for manual assignment.

**Service area:** Kochi only for now (roughly Aluva to Tripunithura, `serviceArea` in `apps/api/src/config.ts`).
Bookings with a pickup outside it are rejected. Money is stored in paise (₹1 = 100 paise); times are shown in IST.

**Pricing** (editable in admin, placeholders for now): ₹500 minimum covering 2 hours, then ₹60 per
15 minutes, +20% between 22:00 and 06:00 India time, +₹200 for one-way trips, rounded up to a whole rupee.
Each booking saves the pricing settings at booking time; the final fare is based on actual trip time.

**Cash and commission:** when a trip completes, the commission (default 20%) is recorded as owed by the driver.
Ops record settlements when drivers pay. A driver owing more than ₹3,000 (`MAX_CASH_OWED_INR`) can't go online.

**Phone numbers** are collected in the profile so drivers and customers can call each other. They aren't
verified by SMS; ops can check a driver's number during approval.

## Production

Live at **https://driverbooking-nasmanasar123.dhilber.in** on the shared course server. The API serves everything from that one address:

| Path | What |
|---|---|
| `/` | Customer app |
| `/driver/` | Driver app |
| `/admin/` | Ops dashboard |
| `/api/...` | API (`/api/payments/razorpay/webhook` for Razorpay) |

Server details, folder layout, update steps and the server rules are in [CLAUDE.md](CLAUDE.md#deployment).
`NODE_ENV=production` turns off the development sign-in and makes the API serve the built apps.

## Before launch

- [ ] Google OAuth consent screen published (out of *Testing*) so any Google account can sign in
- [ ] PNG app icons (192×192, 512×512) in each `public/`; the current SVG icons are placeholders
- [ ] Real pricing numbers
- [ ] Terms of service covering damage to the car, traffic challans and FASTag tolls during trips

## Later

- Refunds and failed-payment follow-up for online payments; automatic driver payouts (RazorpayX)
- SMS-verified phone numbers
- Pin-drop map for pickup, driver document uploads, cancellation fees, scheduled bookings
