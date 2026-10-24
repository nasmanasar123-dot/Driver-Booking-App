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
  maxCashOwedFils: num(env.MAX_CASH_OWED_AED, 500) * 100,
  // Rough bounding box around Dubai emirate; bookings outside it are rejected.
  serviceArea: { name: 'Dubai', minLat: 24.6, maxLat: 25.45, minLng: 54.85, maxLng: 56.0 },
};

if (config.isProd && config.jwtSecret === DEV_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}
