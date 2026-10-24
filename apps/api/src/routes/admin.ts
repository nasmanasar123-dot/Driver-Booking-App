import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth.ts';
import { adminAssign, adminView, cancelBooking, getBooking, type BookingRow } from '../bookings.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../errors.ts';
import { getPricing, pricingSchema, savePricing } from '../pricing.ts';

const idParam = z.object({ id: z.coerce.number().int() });

export function adminRoutes(ctx: Ctx) {
  const { db } = ctx;

  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireRole('admin'));

    app.get('/overview', async () => {
      const count = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number;
      const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10); // Dubai date
      return {
        needsDispatch: count("SELECT COUNT(*) FROM bookings WHERE status = 'requested' AND needs_dispatch = 1"),
        active: count("SELECT COUNT(*) FROM bookings WHERE status IN ('requested', 'assigned', 'started')"),
        driversOnline: count("SELECT COUNT(*) FROM drivers WHERE is_online = 1 AND status = 'approved'"),
        driversPending: count("SELECT COUNT(*) FROM drivers WHERE status = 'pending' AND license_number IS NOT NULL"),
        completedToday: count(
          "SELECT COUNT(*) FROM bookings WHERE status = 'completed' AND date(completed_at, '+4 hours') = ?",
          today,
        ),
        commissionOutstandingFils: count('SELECT COALESCE(SUM(amount), 0) FROM ledger_entries'),
      };
    });

    app.get('/bookings', async (req) => {
      const q = z
        .object({ status: z.enum(['open', 'requested', 'assigned', 'started', 'completed', 'cancelled']).optional() })
        .parse(req.query);
      const where =
        q.status === 'open'
          ? "WHERE status IN ('requested', 'assigned', 'started')"
          : q.status
            ? 'WHERE status = @status'
            : '';
      const rows = db
        .prepare(`SELECT * FROM bookings ${where} ORDER BY needs_dispatch DESC, id DESC LIMIT 200`)
        .all(q.status && q.status !== 'open' ? { status: q.status } : {}) as BookingRow[];
      return rows.map((b) => adminView(db, b));
    });

    app.get('/bookings/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const b = getBooking(db, id);
      if (!b) throw new HttpError(404, 'Booking not found');
      return adminView(db, b);
    });

    app.post('/bookings/:id/assign', async (req) => {
      const { id } = idParam.parse(req.params);
      const { driverId } = z.object({ driverId: z.number().int() }).parse(req.body);
      adminAssign(ctx, id, driverId);
      return adminView(db, getBooking(db, id)!);
    });

    app.post('/bookings/:id/cancel', async (req) => {
      const { id } = idParam.parse(req.params);
      const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
      cancelBooking(ctx, id, 'admin', reason);
      return adminView(db, getBooking(db, id)!);
    });

    app.get('/drivers', async (req) => {
      const { status } = z
        .object({ status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional() })
        .parse(req.query);
      return db
        .prepare(
          `SELECT u.id, u.name, u.phone, d.status, d.emirates_id AS emiratesId, d.license_number AS licenseNumber,
             d.license_expiry AS licenseExpiry, d.can_drive_manual AS canDriveManual, d.is_online AS isOnline,
             d.lat, d.lng, d.location_updated_at AS locationUpdatedAt, d.admin_notes AS adminNotes,
             (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries l WHERE l.driver_id = u.id) AS balanceOwedFils,
             (SELECT id FROM bookings b WHERE b.driver_id = u.id AND b.status IN ('assigned', 'started')) AS activeBookingId,
             (SELECT ROUND(AVG(customer_rating), 1) FROM bookings b WHERE b.driver_id = u.id) AS rating,
             (SELECT COUNT(*) FROM bookings b WHERE b.driver_id = u.id AND b.status = 'completed') AS tripsCompleted
           FROM users u JOIN drivers d ON d.user_id = u.id
           ${status ? 'WHERE d.status = ?' : ''}
           ORDER BY u.id DESC`,
        )
        .all(...(status ? [status] : []))
        .map((d: any) => ({ ...d, canDriveManual: !!d.canDriveManual, isOnline: !!d.isOnline }));
    });

    app.post('/drivers/:id/status', async (req) => {
      const { id } = idParam.parse(req.params);
      const { status, notes } = z
        .object({ status: z.enum(['approved', 'rejected', 'suspended']), notes: z.string().max(500).optional() })
        .parse(req.body);
      const r = db
        .prepare(
          `UPDATE drivers SET status = ?, admin_notes = ?, is_online = CASE WHEN ? = 'approved' THEN is_online ELSE 0 END,
             approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END
           WHERE user_id = ?`,
        )
        .run(status, notes ?? null, status, status, new Date().toISOString(), id);
      if (r.changes === 0) throw new HttpError(404, 'Driver not found');
      return { ok: true };
    });

    app.get('/drivers/:id/ledger', async (req) => {
      const { id } = idParam.parse(req.params);
      return db
        .prepare(
          'SELECT id, booking_id AS bookingId, kind, amount AS amountFils, note, created_at AS createdAt FROM ledger_entries WHERE driver_id = ? ORDER BY id DESC',
        )
        .all(id);
    });

    // Driver handed over cash commission: recorded as a negative entry that reduces what they owe.
    app.post('/drivers/:id/settlements', async (req) => {
      const { id } = idParam.parse(req.params);
      const { amountFils, note } = z
        .object({ amountFils: z.number().int().positive(), note: z.string().max(300).optional() })
        .parse(req.body);
      const isDriver = db.prepare('SELECT 1 FROM drivers WHERE user_id = ?').get(id);
      if (!isDriver) throw new HttpError(404, 'Driver not found');
      db.prepare(
        "INSERT INTO ledger_entries (driver_id, kind, amount, note, created_by, created_at) VALUES (?, 'settlement', ?, ?, ?, ?)",
      ).run(id, -amountFils, note ?? 'Cash settlement', req.user.sub, new Date().toISOString());
      return { ok: true };
    });

    app.get('/customers', async () =>
      db
        .prepare(
          `SELECT u.id, u.name, u.phone, u.email, u.created_at AS createdAt,
             (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id) AS bookings
           FROM users u WHERE role = 'customer' ORDER BY u.id DESC LIMIT 500`,
        )
        .all(),
    );

    app.get('/settings/pricing', async () => getPricing(db));

    // Applies to new bookings only; existing bookings keep their pricing snapshot.
    app.put('/settings/pricing', async (req) => {
      const pricing = pricingSchema.parse(req.body);
      savePricing(db, pricing);
      return pricing;
    });
  };
}
