import { config } from './config.ts';
import type { DB } from './db.ts';

const toRad = (deg: number) => (deg * Math.PI) / 180;

export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Approved, online, recently-pinged drivers within the radius who aren't already on a trip, nearest first.
export function findNearbyDrivers(db: DB, pickup: { lat: number; lng: number; manual: boolean }): number[] {
  const { radiusKm, locationFreshSec, maxOffers } = config.dispatch;
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos(toRad(pickup.lat)));
  const freshSince = new Date(Date.now() - locationFreshSec * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT user_id, lat, lng FROM drivers d
       WHERE status = 'approved' AND is_online = 1 AND location_updated_at >= ?
         AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
         AND (? = 0 OR can_drive_manual = 1)
         AND NOT EXISTS (
           SELECT 1 FROM bookings b WHERE b.driver_id = d.user_id AND b.status IN ('assigned', 'started')
         )`,
    )
    .all(freshSince, pickup.lat - dLat, pickup.lat + dLat, pickup.lng - dLng, pickup.lng + dLng, pickup.manual ? 1 : 0) as {
    user_id: number;
    lat: number;
    lng: number;
  }[];
  return rows
    .map((r) => ({ id: r.user_id, km: distanceKm(pickup.lat, pickup.lng, r.lat, r.lng) }))
    .filter((r) => r.km <= radiusKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, maxOffers)
    .map((r) => r.id);
}
