import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth.ts';
import {
  cancelBooking,
  createBooking,
  customerView,
  getBooking,
  rateBooking,
  type BookingRow,
} from '../bookings.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../errors.ts';
import { startPayment, verifyCheckout } from '../payments.ts';
import { calculateFare, getPricing } from '../pricing.ts';

const idParam = z.object({ id: z.coerce.number().int() });
const address = z.string().trim().min(3).max(300);
const tripType = z.enum(['hourly', 'one_way']);
const estimatedMinutes = z.number().int().min(30).max(24 * 60);

export function customerRoutes(ctx: Ctx) {
  const { db } = ctx;

  const ownBooking = (customerId: number, id: number) => {
    const b = getBooking(db, id);
    if (!b || b.customer_id !== customerId) throw new HttpError(404, 'Booking not found');
    return b;
  };

  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireRole('customer'));

    app.get('/vehicles', async (req) =>
      db
        .prepare('SELECT id, make, model, plate, transmission FROM vehicles WHERE customer_id = ? AND deleted = 0 ORDER BY id')
        .all(req.user.sub),
    );

    app.post('/vehicles', async (req) => {
      const v = z
        .object({
          make: z.string().trim().min(1).max(50),
          model: z.string().trim().min(1).max(50),
          plate: z.string().trim().min(1).max(20),
          transmission: z.enum(['automatic', 'manual']),
        })
        .parse(req.body);
      const { lastInsertRowid } = db
        .prepare('INSERT INTO vehicles (customer_id, make, model, plate, transmission, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.user.sub, v.make, v.model, v.plate.toUpperCase(), v.transmission, new Date().toISOString());
      return { id: Number(lastInsertRowid), ...v, plate: v.plate.toUpperCase() };
    });

    // Soft delete: past bookings still reference the vehicle.
    app.delete('/vehicles/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      db.prepare('UPDATE vehicles SET deleted = 1 WHERE id = ? AND customer_id = ?').run(id, req.user.sub);
      return { ok: true };
    });

    app.post('/estimate', async (req) => {
      const body = z.object({ tripType, estimatedMinutes }).parse(req.body);
      const fare = calculateFare(getPricing(db), { tripType: body.tripType, minutes: body.estimatedMinutes, startAt: new Date() });
      return { farePaise: fare.fare, billedMinutes: fare.billedMinutes, night: fare.night };
    });

    app.post('/bookings', async (req) => {
      const body = z
        .object({
          vehicleId: z.number().int(),
          tripType,
          pickup: z.object({ address, lat: z.number(), lng: z.number() }),
          dropoff: z.object({ address, lat: z.number().optional(), lng: z.number().optional() }).optional(),
          estimatedMinutes,
          paymentMethod: z.enum(['cash', 'online']).default('cash'),
        })
        .parse(req.body);
      const id = createBooking(ctx, req.user.sub, body);
      return customerView(db, getBooking(db, id)!);
    });

    app.get('/bookings', async (req) => {
      const rows = db
        .prepare('SELECT * FROM bookings WHERE customer_id = ? ORDER BY id DESC LIMIT 50')
        .all(req.user.sub) as BookingRow[];
      return rows.map((b) => customerView(db, b));
    });

    app.get('/bookings/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      return customerView(db, ownBooking(req.user.sub, id));
    });

    app.post('/bookings/:id/cancel', async (req) => {
      const { id } = idParam.parse(req.params);
      const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
      ownBooking(req.user.sub, id);
      cancelBooking(ctx, id, 'customer', reason);
      return customerView(db, getBooking(db, id)!);
    });

    app.post('/bookings/:id/rate', async (req) => {
      const { id } = idParam.parse(req.params);
      const { rating, comment } = z
        .object({ rating: z.number().int().min(1).max(5), comment: z.string().max(500).optional() })
        .parse(req.body);
      rateBooking(ctx, req.user.sub, id, rating, comment);
      return customerView(db, getBooking(db, id)!);
    });

    // Online payment: get a Razorpay order to open Checkout with...
    app.post('/bookings/:id/pay', async (req) => {
      const { id } = idParam.parse(req.params);
      return startPayment(ctx, req.user.sub, id);
    });

    // ...then send back what Checkout returned on success.
    app.post('/bookings/:id/pay/verify', async (req) => {
      const { id } = idParam.parse(req.params);
      const p = z
        .object({ orderId: z.string().min(1), paymentId: z.string().min(1), signature: z.string().min(1) })
        .parse(req.body);
      verifyCheckout(ctx, req.user.sub, id, p);
      return customerView(db, getBooking(db, id)!);
    });
  };
}
