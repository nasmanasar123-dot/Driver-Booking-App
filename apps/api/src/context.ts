import type { DB } from './db.ts';
import type { Razorpay } from './payments.ts';
import type { Realtime } from './realtime.ts';

export type GoogleProfile = { sub: string; email: string; name?: string };

// Everything a route or service needs, passed explicitly so tests can swap pieces out.
export type Ctx = {
  db: DB;
  realtime: Realtime;
  verifyGoogleToken: (idToken: string) => Promise<GoogleProfile>;
  razorpay: Razorpay | null; // null when online payments aren't configured
};
