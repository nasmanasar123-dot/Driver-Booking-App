import { z } from 'zod';
import type { DB } from './db.ts';

// Amounts are in fils. Defaults are placeholders — set real numbers from the admin dashboard.
export const pricingSchema = z
  .object({
    minimumMinutes: z.number().int().min(15),
    minimumFare: z.number().int().min(0),
    blockMinutes: z.number().int().min(5),
    blockFare: z.number().int().min(0),
    oneWayFee: z.number().int().min(0),
    nightSurchargePercent: z.number().min(0).max(200),
    nightStartHour: z.number().int().min(0).max(23),
    nightEndHour: z.number().int().min(0).max(23),
    commissionPercent: z.number().min(0).max(100),
  })
  .refine((p) => p.minimumMinutes % p.blockMinutes === 0, {
    message: 'minimumMinutes must be a multiple of blockMinutes',
  });

export type Pricing = z.infer<typeof pricingSchema>;

export const defaultPricing: Pricing = {
  minimumMinutes: 120, // first 2 hours...
  minimumFare: 12000, // ...cost AED 120
  blockMinutes: 15, // then billed per 15 minutes...
  blockFare: 1250, // ...at AED 12.50 (AED 50/hour)
  oneWayFee: 3000, // AED 30 for the driver's trip back
  nightSurchargePercent: 20,
  nightStartHour: 22, // Dubai local time
  nightEndHour: 6,
  commissionPercent: 20,
};

export function getPricing(db: DB): Pricing {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'pricing'").get() as { value: string } | undefined;
  return row ? { ...defaultPricing, ...JSON.parse(row.value) } : defaultPricing;
}

export function savePricing(db: DB, pricing: Pricing) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('pricing', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(pricing));
}

// Dubai is UTC+4 year-round (no daylight saving).
export const dubaiHour = (date: Date) => (date.getUTCHours() + 4) % 24;

export function isNight(p: Pricing, date: Date) {
  const h = dubaiHour(date);
  return p.nightStartHour > p.nightEndHour
    ? h >= p.nightStartHour || h < p.nightEndHour
    : h >= p.nightStartHour && h < p.nightEndHour;
}

export function calculateFare(
  p: Pricing,
  trip: { tripType: 'hourly' | 'one_way'; minutes: number; startAt: Date },
) {
  const billedMinutes = Math.max(p.minimumMinutes, Math.ceil(trip.minutes / p.blockMinutes) * p.blockMinutes);
  const extraBlocks = (billedMinutes - p.minimumMinutes) / p.blockMinutes;
  let fare = p.minimumFare + extraBlocks * p.blockFare;
  const night = isNight(p, trip.startAt);
  if (night) fare += (fare * p.nightSurchargePercent) / 100;
  if (trip.tripType === 'one_way') fare += p.oneWayFee;
  // Cash trips: round up to a whole dirham so drivers aren't dealing in fils.
  fare = Math.ceil(fare / 100) * 100;
  const commission = Math.round((fare * p.commissionPercent) / 100);
  return { billedMinutes, night, fare, commission, driverEarning: fare - commission };
}
