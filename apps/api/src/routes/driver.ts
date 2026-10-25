import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizePhone, requireRole } from '../auth.ts';
import {
  acceptOffer,
  completeTrip,
  declineOffer,
  driverBalance,
  driverView,
  getBooking,
  offerView,
  releaseBooking,
  startTrip,
  type BookingRow,
} from '../bookings.ts';
import { config } from '../config.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../errors.ts';
import { findUserByPhone } from '../users.ts';

const idParam = z.object({ id: z.coerce.number().int() });
const location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

type DriverRow = {
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  license_number: string | null;
  license_expiry: string | null;
  can_drive_manual: number;
  is_online: number;
  admin_notes: string | null;
};

export function driverRoutes(ctx: Ctx) {
  const { db } = ctx;
  const getDriver = (id: number) => db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(id) as DriverRow;

  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireRole('driver'));

    app.get('/me', async (req) => {
      const d = getDriver(req.user.sub);
      return {
        status: d.status,
        licenseNumber: d.license_number,
        licenseExpiry: d.license_expiry,
        canDriveManual: !!d.can_drive_manual,
        isOnline: !!d.is_online,
        adminNotes: d.admin_notes,
        balanceOwedPaise: driverBalance(db, req.user.sub),
        maxCashOwedPaise: config.maxCashOwedPaise,
      };
    });

    // Submitting details puts a rejected application back into review.
    app.put('/profile', async (req) => {
      const p = z
        .object({
          name: z.string().trim().min(2).max(100),
          phone: z.string(),
          licenseNumber: z.string().trim().min(3).max(30),
          licenseExpiry: z.iso.date(),
          canDriveManual: z.boolean(),
        })
        .parse(req.body);
      const d = getDriver(req.user.sub);
      if (d.status === 'approved' || d.status === 'suspended') {
        throw new HttpError(409, 'Contact support to change your details');
      }
      const phone = normalizePhone(p.phone);
      const owner = findUserByPhone(db, phone);
      if (owner && owner.id !== req.user.sub) throw new HttpError(409, 'This number is used by another account');
      db.transaction(() => {
        db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(p.name, phone, req.user.sub);
        db.prepare(
          `UPDATE drivers SET license_number = ?, license_expiry = ?, can_drive_manual = ?, status = 'pending'
           WHERE user_id = ?`,
        ).run(p.licenseNumber, p.licenseExpiry, p.canDriveManual ? 1 : 0, req.user.sub);
      })();
      return { ok: true };
    });

    app.post('/online', async (req) => {
      const body = z.object({ online: z.boolean(), location: location.optional() }).parse(req.body);
      if (body.online) {
        if (getDriver(req.user.sub).status !== 'approved') throw new HttpError(403, 'Your account is not approved yet');
        if (driverBalance(db, req.user.sub) > config.maxCashOwedPaise) {
          throw new HttpError(403, 'Please settle your outstanding commission before going online');
        }
      }
      db.prepare('UPDATE drivers SET is_online = ? WHERE user_id = ?').run(body.online ? 1 : 0, req.user.sub);
      if (body.location) {
        db.prepare('UPDATE drivers SET lat = ?, lng = ?, location_updated_at = ? WHERE user_id = ?').run(
          body.location.lat,
          body.location.lng,
          new Date().toISOString(),
          req.user.sub,
        );
      }
      return { online: body.online };
    });

    app.post('/location', async (req) => {
      const { lat, lng } = location.parse(req.body);
      db.prepare('UPDATE drivers SET lat = ?, lng = ?, location_updated_at = ? WHERE user_id = ?').run(
        lat,
        lng,
        new Date().toISOString(),
        req.user.sub,
      );
      return { ok: true };
    });

    app.get('/offers', async (req) => {
      const rows = db
        .prepare(
          `SELECT b.* FROM booking_offers o JOIN bookings b ON b.id = o.booking_id
           WHERE o.driver_id = ? AND o.status = 'sent' AND b.status = 'requested' ORDER BY b.id`,
        )
        .all(req.user.sub) as BookingRow[];
      return rows.map((b) => offerView(db, b));
    });

    app.post('/offers/:id/accept', async (req) => {
      const { id } = idParam.parse(req.params);
      acceptOffer(ctx, req.user.sub, id);
      return driverView(db, getBooking(db, id)!);
    });

    app.post('/offers/:id/decline', async (req) => {
      const { id } = idParam.parse(req.params);
      declineOffer(ctx, req.user.sub, id);
      return { ok: true };
    });

    app.get('/bookings/current', async (req) => {
      const b = db
        .prepare("SELECT * FROM bookings WHERE driver_id = ? AND status IN ('assigned', 'started')")
        .get(req.user.sub) as BookingRow | undefined;
      return b ? driverView(db, b) : null;
    });

    app.get('/bookings', async (req) => {
      const rows = db
        .prepare('SELECT * FROM bookings WHERE driver_id = ? ORDER BY id DESC LIMIT 50')
        .all(req.user.sub) as BookingRow[];
      return rows.map((b) => driverView(db, b));
    });

    app.post('/bookings/:id/start', async (req) => {
      const { id } = idParam.parse(req.params);
      const { otp } = z.object({ otp: z.string().trim() }).parse(req.body);
      startTrip(ctx, req.user.sub, id, otp);
      return driverView(db, getBooking(db, id)!);
    });

    app.post('/bookings/:id/complete', async (req) => {
      const { id } = idParam.parse(req.params);
      completeTrip(ctx, req.user.sub, id);
      return driverView(db, getBooking(db, id)!);
    });

    app.post('/bookings/:id/release', async (req) => {
      const { id } = idParam.parse(req.params);
      releaseBooking(ctx, req.user.sub, id);
      return { ok: true };
    });

    app.get('/ledger', async (req) => ({
      balanceOwedPaise: driverBalance(db, req.user.sub),
      entries: db
        .prepare('SELECT id, booking_id AS bookingId, kind, amount AS amountPaise, note, created_at AS createdAt FROM ledger_entries WHERE driver_id = ? ORDER BY id DESC LIMIT 100')
        .all(req.user.sub),
    }));
  };
}
