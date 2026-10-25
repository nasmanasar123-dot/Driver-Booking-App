const env = process.env;
const num = (value: string | undefined, fallback: number) => (value ? Number(value) : fallback);

const DEV_SECRET = 'dev-secret-change-me';

export const config = {
  port: num(env.PORT, 4000),
  host: env.HOST ?? '127.0.0.1',
  dbPath: env.DB_PATH ?? './data/app.db',
  isProd: env.NODE_ENV === 'production',
  jwtSecret: env.JWT_SECRET || DEV_SECRET,
  googleClientId: env.GOOGLE_CLIENT_ID ?? '',
  // Sign in by typing an email, no Google needed. Local development only — never enabled in production.
  devLogin: env.NODE_ENV !== 'production' && env.DEV_LOGIN !== '0',
  dispatch: {
    radiusKm: num(env.DISPATCH_RADIUS_KM, 15),
    offerTimeoutSec: num(env.OFFER_TIMEOUT_SEC, 90),
    maxOffers: 10,
    // Drivers whose last location ping is older than this are treated as unavailable.
    locationFreshSec: 300,
    sweepIntervalSec: 15,
  },
  maxCashOwedPaise: num(env.MAX_CASH_OWED_INR, 3000) * 100,
  // India Standard Time is UTC+5:30 year-round (no daylight saving).
  utcOffsetMinutes: 330,
  // Online payments are offered only when the key ID and secret are set (Razorpay Dashboard → Account & Settings → API Keys).
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID ?? '',
    keySecret: env.RAZORPAY_KEY_SECRET ?? '',
    // Chosen by you when adding the webhook in Razorpay Dashboard → Account & Settings → Webhooks.
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? '',
  },
  // Rough bounding box around Kochi (Aluva to Tripunithura); bookings outside it are rejected.
  serviceArea: { name: 'Kochi', minLat: 9.8, maxLat: 10.2, minLng: 76.1, maxLng: 76.5 },
};

if (config.isProd && config.jwtSecret === DEV_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}
