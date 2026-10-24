// Booking lifecycle: requested -> assigned -> started -> completed, or -> cancelled from any open state.
// Every transition is a conditional UPDATE on the current status, so a stale or duplicate request fails cleanly.
import { randomInt } from 'node:crypto';
import { config } from './config.ts';
import type { Ctx } from './context.ts';
import type { DB } from './db.ts';
import { findNearbyDrivers } from './dispatch.ts';
import { HttpError } from './errors.ts';
import { calculateFare, getPricing, type Pricing } from './pricing.ts';

export type BookingStatus = 'requested' | 'assigned' | 'started' | 'completed' | 'cancelled';
export type TripType = 'hourly' | 'one_way';

export type BookingRow = {
  id: number;
  customer_id: number;
  driver_id: number | null;
  vehicle_id: number;
  trip_type: TripType;
  status: BookingStatus;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  estimated_minutes: number;
  estimated_fare: number;
  pricing: string;
  start_otp: string;
  needs_dispatch: number;
  offered_at: string;
  actual_minutes: number | null;
  final_fare: number | null;
  commission: number | null;
  driver_earning: number | null;
  cash_collected: number;
  cancelled_by: string | null;
  cancel_reason: string | null;
  customer_rating: number | null;
  customer_comment: string | null;
  requested_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

export const OPEN_STATUSES: BookingStatus[] = ['requested', 'assigned', 'started'];

const now = () => new Date().toISOString();

export const getBooking = (db: DB, id: number) =>
  db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as BookingRow | undefined;

function mustGet(db: DB, id: number) {
  const b = getBooking(db, id);
  if (!b) throw new HttpError(404, 'Booking not found');
  return b;
}

// ---------- Views: each audience sees a different slice of a booking ----------

const party = (db: DB, id: number | null) =>
  id ? (db.prepare('SELECT id, name, phone FROM users WHERE id = ?').get(id) as { id: number; name: string | null; phone: string | null }) : null;

const vehicleOf = (db: DB, id: number) =>
  db.prepare('SELECT id, make, model, plate, transmission FROM vehicles WHERE id = ?').get(id) as {
    id: number;
    make: string;
    model: string;
    plate: string;
    transmission: 'automatic' | 'manual';
  };

function baseView(db: DB, b: BookingRow) {
  return {
    id: b.id,
    status: b.status,
    tripType: b.trip_type,
    pickup: { address: b.pickup_address, lat: b.pickup_lat, lng: b.pickup_lng },
    dropoff: b.dropoff_address ? { address: b.dropoff_address, lat: b.dropoff_lat, lng: b.dropoff_lng } : null,
    vehicle: vehicleOf(db, b.vehicle_id),
    estimatedMinutes: b.estimated_minutes,
    estimatedFareFils: b.estimated_fare,
    actualMinutes: b.actual_minutes,
    finalFareFils: b.final_fare,
    paymentMethod: 'cash' as const,
    cancelledBy: b.cancelled_by,
    cancelReason: b.cancel_reason,
    rating: b.customer_rating,
    requestedAt: b.requested_at,
    assignedAt: b.assigned_at,
    startedAt: b.started_at,
    completedAt: b.completed_at,
    cancelledAt: b.cancelled_at,
  };
}

export const customerView = (db: DB, b: BookingRow) => ({
  ...baseView(db, b),
  startOtp: b.status === 'assigned' ? b.start_otp : null,
  driver: party(db, b.driver_id),
});

export const driverView = (db: DB, b: BookingRow) => ({
  ...baseView(db, b),
  customer: party(db, b.customer_id),
  commissionFils: b.commission,
  driverEarningFils: b.driver_earning,
});

export const adminView = (db: DB, b: BookingRow) => ({
  ...driverView(db, b),
  driver: party(db, b.driver_id),
  startOtp: b.start_otp,
  needsDispatch: !!b.needs_dispatch,
  customerComment: b.customer_comment,
});

// What a driver sees before accepting: no customer identity yet.
export function offerView(db: DB, b: BookingRow) {
  const pricing = JSON.parse(b.pricing) as Pricing;
  const v = vehicleOf(db, b.vehicle_id);
  return {
    bookingId: b.id,
    tripType: b.trip_type,
    pickup: { address: b.pickup_address, lat: b.pickup_lat, lng: b.pickup_lng },
    dropoffAddress: b.dropoff_address,
    vehicle: { make: v.make, model: v.model, transmission: v.transmission },
    estimatedMinutes: b.estimated_minutes,
    estimatedFareFils: b.estimated_fare,
    estimatedEarningFils: b.estimated_fare - Math.round((b.estimated_fare * pricing.commissionPercent) / 100),
    requestedAt: b.requested_at,
  };
}

export function publishBooking(ctx: Ctx, id: number) {
  const b = getBooking(ctx.db, id);
  if (!b) return;
  ctx.realtime.toUser(b.customer_id, 'booking:updated', customerView(ctx.db, b));
  if (b.driver_id) ctx.realtime.toUser(b.driver_id, 'booking:updated', driverView(ctx.db, b));
  ctx.realtime.toAdmins('booking:updated', adminView(ctx.db, b));
}

// ---------- Dispatch ----------

function expireOffers(ctx: Ctx, bookingId: number) {
  const drivers = ctx.db
    .prepare("SELECT driver_id FROM booking_offers WHERE booking_id = ? AND status = 'sent'")
    .pluck()
    .all(bookingId) as number[];
  ctx.db
    .prepare("UPDATE booking_offers SET status = 'expired', responded_at = ? WHERE booking_id = ? AND status = 'sent'")
    .run(now(), bookingId);
  for (const d of drivers) ctx.realtime.toUser(d, 'offer:revoked', { bookingId });
}

function flagForDispatch(ctx: Ctx, bookingId: number) {
  ctx.db.prepare("UPDATE bookings SET needs_dispatch = 1 WHERE id = ? AND status = 'requested'").run(bookingId);
}

// Sends the booking to nearby drivers who haven't seen it yet; first to accept wins.
// With nobody to offer it to, it goes straight to the admin dispatch queue.
export function offerBooking(ctx: Ctx, bookingId: number) {
  const b = getBooking(ctx.db, bookingId);
  if (!b || b.status !== 'requested') return;
  const manual = vehicleOf(ctx.db, b.vehicle_id).transmission === 'manual';
  const insert = ctx.db.prepare(
    "INSERT OR IGNORE INTO booking_offers (booking_id, driver_id, status, created_at) VALUES (?, ?, 'sent', ?)",
  );
  const offer = offerView(ctx.db, b);
  for (const driverId of findNearbyDrivers(ctx.db, { lat: b.pickup_lat, lng: b.pickup_lng, manual })) {
    if (insert.run(bookingId, driverId, now()).changes) ctx.realtime.toUser(driverId, 'offer:new', offer);
  }
  const open = ctx.db
    .prepare("SELECT COUNT(*) FROM booking_offers WHERE booking_id = ? AND status = 'sent'")
    .pluck()
    .get(bookingId) as number;
  if (open === 0) flagForDispatch(ctx, bookingId);
}

// Runs on a timer: requests nobody accepted in time move to the admin dispatch queue.
export function sweepStaleRequests(ctx: Ctx) {
  const cutoff = new Date(Date.now() - config.dispatch.offerTimeoutSec * 1000).toISOString();
  const stale = ctx.db
    .prepare("SELECT id FROM bookings WHERE status = 'requested' AND needs_dispatch = 0 AND offered_at < ?")
    .pluck()
    .all(cutoff) as number[];
  for (const id of stale) {
    expireOffers(ctx, id);
    flagForDispatch(ctx, id);
    publishBooking(ctx, id);
  }
}

function assertDriverFree(db: DB, driverId: number) {
  const busy = db
    .prepare("SELECT 1 FROM bookings WHERE driver_id = ? AND status IN ('assigned', 'started')")
    .get(driverId);
  if (busy) throw new HttpError(409, 'Driver already has an active booking');
}

function assertDriverApproved(db: DB, driverId: number) {
  const status = db.prepare('SELECT status FROM drivers WHERE user_id = ?').pluck().get(driverId);
  if (status !== 'approved') throw new HttpError(403, 'Driver is not approved');
}

// ---------- Transitions ----------

export type NewBooking = {
  vehicleId: number;
  tripType: TripType;
  pickup: { address: string; lat: number; lng: number };
  dropoff?: { address: string; lat?: number; lng?: number };
  estimatedMinutes: number;
};

export function createBooking(ctx: Ctx, customerId: number, input: NewBooking): number {
  const { db } = ctx;
  const phone = db.prepare('SELECT phone FROM users WHERE id = ?').pluck().get(customerId);
  if (!phone) throw new HttpError(400, 'Please add your mobile number before booking');

  const area = config.serviceArea;
  const { lat, lng } = input.pickup;
  if (lat < area.minLat || lat > area.maxLat || lng < area.minLng || lng > area.maxLng) {
    throw new HttpError(400, `Sorry, we currently only serve ${area.name}`);
  }
  if (input.tripType === 'one_way' && !input.dropoff) throw new HttpError(400, 'One-way trips need a drop-off address');

  const vehicle = db
    .prepare('SELECT id FROM vehicles WHERE id = ? AND customer_id = ? AND deleted = 0')
    .get(input.vehicleId, customerId);
  if (!vehicle) throw new HttpError(404, 'Vehicle not found');

  const active = db
    .prepare("SELECT 1 FROM bookings WHERE customer_id = ? AND status IN ('requested', 'assigned', 'started')")
    .get(customerId);
  if (active) throw new HttpError(409, 'You already have an active booking');

  const pricing = getPricing(db);
  const estimate = calculateFare(pricing, { tripType: input.tripType, minutes: input.estimatedMinutes, startAt: new Date() });
  const ts = now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO bookings (customer_id, vehicle_id, trip_type, status, pickup_address, pickup_lat, pickup_lng,
         dropoff_address, dropoff_lat, dropoff_lng, estimated_minutes, estimated_fare, pricing, start_otp,
         offered_at, requested_at)
       VALUES (?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      customerId,
      input.vehicleId,
      input.tripType,
      input.pickup.address,
      lat,
      lng,
      input.dropoff?.address ?? null,
      input.dropoff?.lat ?? null,
      input.dropoff?.lng ?? null,
      input.estimatedMinutes,
      estimate.fare,
      JSON.stringify(pricing),
      String(randomInt(1000, 10000)),
      ts,
      ts,
    );
  const id = Number(lastInsertRowid);
  offerBooking(ctx, id);
  publishBooking(ctx, id);
  return id;
}

export function acceptOffer(ctx: Ctx, driverId: number, bookingId: number) {
  const { db } = ctx;
  db.transaction(() => {
    const offer = db
      .prepare('SELECT status FROM booking_offers WHERE booking_id = ? AND driver_id = ?')
      .pluck()
      .get(bookingId, driverId);
    if (offer !== 'sent') throw new HttpError(409, 'This booking is no longer available');
    assertDriverApproved(db, driverId);
    assertDriverFree(db, driverId);
    const r = db
      .prepare(
        "UPDATE bookings SET status = 'assigned', driver_id = ?, assigned_at = ?, needs_dispatch = 0 WHERE id = ? AND status = 'requested'",
      )
      .run(driverId, now(), bookingId);
    if (r.changes === 0) throw new HttpError(409, 'This booking is no longer available');
    db.prepare("UPDATE booking_offers SET status = 'accepted', responded_at = ? WHERE booking_id = ? AND driver_id = ?").run(
      now(),
      bookingId,
      driverId,
    );
  })();
  expireOffers(ctx, bookingId);
  publishBooking(ctx, bookingId);
}

export function declineOffer(ctx: Ctx, driverId: number, bookingId: number) {
  ctx.db
    .prepare(
      "UPDATE booking_offers SET status = 'declined', responded_at = ? WHERE booking_id = ? AND driver_id = ? AND status = 'sent'",
    )
    .run(now(), bookingId, driverId);
  const open = ctx.db
    .prepare("SELECT COUNT(*) FROM booking_offers WHERE booking_id = ? AND status = 'sent'")
    .pluck()
    .get(bookingId) as number;
  if (open === 0) {
    flagForDispatch(ctx, bookingId);
    publishBooking(ctx, bookingId);
  }
}

export function adminAssign(ctx: Ctx, bookingId: number, driverId: number) {
  const { db } = ctx;
  const b = mustGet(db, bookingId);
  if (b.status !== 'requested' && b.status !== 'assigned') throw new HttpError(409, `Cannot assign a ${b.status} booking`);
  if (b.driver_id === driverId) return;
  assertDriverApproved(db, driverId);
  assertDriverFree(db, driverId);
  db.prepare(
    "UPDATE bookings SET status = 'assigned', driver_id = ?, assigned_at = ?, needs_dispatch = 0 WHERE id = ? AND status IN ('requested', 'assigned')",
  ).run(driverId, now(), bookingId);
  expireOffers(ctx, bookingId);
  if (b.driver_id) ctx.realtime.toUser(b.driver_id, 'booking:removed', { bookingId });
  publishBooking(ctx, bookingId);
}

// Driver backs out before starting: the booking goes back out to other drivers.
export function releaseBooking(ctx: Ctx, driverId: number, bookingId: number) {
  const { db } = ctx;
  const r = db
    .prepare(
      `UPDATE bookings SET status = 'requested', driver_id = NULL, assigned_at = NULL, offered_at = ?
       WHERE id = ? AND driver_id = ? AND status = 'assigned'`,
    )
    .run(now(), bookingId, driverId);
  if (r.changes === 0) throw new HttpError(409, 'Only an assigned, not-yet-started booking can be released');
  // Keeps them from being re-offered the same booking (offers are unique per booking+driver).
  db.prepare(
    `INSERT INTO booking_offers (booking_id, driver_id, status, created_at, responded_at) VALUES (?, ?, 'declined', ?, ?)
     ON CONFLICT(booking_id, driver_id) DO UPDATE SET status = 'declined', responded_at = excluded.responded_at`,
  ).run(bookingId, driverId, now(), now());
  ctx.realtime.toUser(driverId, 'booking:removed', { bookingId });
  offerBooking(ctx, bookingId);
  publishBooking(ctx, bookingId);
}

export function startTrip(ctx: Ctx, driverId: number, bookingId: number, otp: string) {
  const b = mustGet(ctx.db, bookingId);
  if (b.driver_id !== driverId || b.status !== 'assigned') throw new HttpError(409, 'This trip cannot be started');
  if (b.start_otp !== otp) throw new HttpError(400, 'Incorrect code — ask the customer for the 4-digit code in their app');
  ctx.db
    .prepare("UPDATE bookings SET status = 'started', started_at = ? WHERE id = ? AND status = 'assigned'")
    .run(now(), bookingId);
  publishBooking(ctx, bookingId);
}

// Ends the trip, prices it from actual time, and records the commission the driver owes from the cash collected.
export function completeTrip(ctx: Ctx, driverId: number, bookingId: number) {
  const { db } = ctx;
  const b = mustGet(db, bookingId);
  if (b.driver_id !== driverId || b.status !== 'started') throw new HttpError(409, 'This trip cannot be completed');
  const startedAt = new Date(b.started_at!);
  const minutes = Math.max(1, Math.ceil((Date.now() - startedAt.getTime()) / 60000));
  const fare = calculateFare(JSON.parse(b.pricing), { tripType: b.trip_type, minutes, startAt: startedAt });
  db.transaction(() => {
    const r = db
      .prepare(
        `UPDATE bookings SET status = 'completed', completed_at = ?, actual_minutes = ?, final_fare = ?,
           commission = ?, driver_earning = ?, cash_collected = 1
         WHERE id = ? AND status = 'started'`,
      )
      .run(now(), minutes, fare.fare, fare.commission, fare.driverEarning, bookingId);
    if (r.changes === 0) throw new HttpError(409, 'This trip cannot be completed');
    db.prepare(
      "INSERT INTO ledger_entries (driver_id, booking_id, kind, amount, note, created_at) VALUES (?, ?, 'commission', ?, ?, ?)",
    ).run(driverId, bookingId, fare.commission, `Commission on booking #${bookingId}`, now());
  })();
  publishBooking(ctx, bookingId);
}

export function cancelBooking(ctx: Ctx, bookingId: number, by: 'customer' | 'admin', reason: string | undefined) {
  const b = mustGet(ctx.db, bookingId);
  const allowed: BookingStatus[] = by === 'admin' ? OPEN_STATUSES : ['requested', 'assigned'];
  if (!allowed.includes(b.status)) throw new HttpError(409, `A ${b.status} booking cannot be cancelled`);
  const placeholders = allowed.map(() => '?').join(', ');
  const r = ctx.db
    .prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, needs_dispatch = 0
       WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(now(), by, reason ?? null, bookingId, ...allowed);
  if (r.changes === 0) throw new HttpError(409, 'Booking changed, please refresh');
  expireOffers(ctx, bookingId);
  publishBooking(ctx, bookingId);
}

export function rateBooking(ctx: Ctx, customerId: number, bookingId: number, rating: number, comment: string | undefined) {
  const r = ctx.db
    .prepare(
      `UPDATE bookings SET customer_rating = ?, customer_comment = ?
       WHERE id = ? AND customer_id = ? AND status = 'completed' AND customer_rating IS NULL`,
    )
    .run(rating, comment ?? null, bookingId, customerId);
  if (r.changes === 0) throw new HttpError(409, 'This booking cannot be rated');
}

export const driverBalance = (db: DB, driverId: number) =>
  db.prepare('SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE driver_id = ?').pluck().get(driverId) as number;
