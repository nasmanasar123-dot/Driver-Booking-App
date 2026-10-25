// Online payments with Razorpay. Customers who chose "pay online" pay the final fare after the trip
// through Razorpay Checkout. A payment is confirmed by whichever arrives first: the checkout callback
// (signature checked with the key secret) or Razorpay's webhook (signature checked with the webhook
// secret). Both go through markPaid, which is idempotent.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getBooking, publishBooking } from './bookings.ts';
import { config } from './config.ts';
import type { Ctx } from './context.ts';
import { HttpError } from './errors.ts';

export type Razorpay = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  createOrder: (order: { amount: number; receipt: string; notes: Record<string, string> }) => Promise<{ id: string }>;
};

export function razorpayFromConfig(): Razorpay | null {
  const { keyId, keySecret, webhookSecret } = config.razorpay;
  if (!keyId || !keySecret) return null;
  return {
    keyId,
    keySecret,
    webhookSecret,
    createOrder: async ({ amount, receipt, notes }) => {
      const res = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ amount, currency: 'INR', receipt, notes }),
      });
      const body = (await res.json().catch(() => null)) as { id?: string; error?: { description?: string } } | null;
      if (!res.ok || !body?.id) throw new HttpError(502, `Razorpay: ${body?.error?.description ?? `error ${res.status}`}`);
      return { id: body.id };
    },
  };
}

const hmacHex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

function signatureMatches(expected: string, given: string | undefined) {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function razorpayOf(ctx: Ctx) {
  if (!ctx.razorpay) throw new HttpError(503, 'Online payment is not available');
  return ctx.razorpay;
}

type PaymentRow = { id: number; booking_id: number; razorpay_order_id: string; amount: number; status: 'created' | 'paid' };

// Creates (or reuses) the Razorpay order the customer's checkout will pay.
export async function startPayment(ctx: Ctx, customerId: number, bookingId: number) {
  const rp = razorpayOf(ctx);
  const b = getBooking(ctx.db, bookingId);
  if (!b || b.customer_id !== customerId) throw new HttpError(404, 'Booking not found');
  if (b.payment_method !== 'online' || b.status !== 'completed' || b.payment_status !== 'unpaid') {
    throw new HttpError(409, 'This booking has nothing to pay online');
  }
  const amount = b.final_fare!;
  let orderId = ctx.db
    .prepare("SELECT razorpay_order_id FROM payments WHERE booking_id = ? AND status = 'created' AND amount = ? ORDER BY id DESC")
    .pluck()
    .get(bookingId, amount) as string | undefined;
  if (!orderId) {
    orderId = (await rp.createOrder({ amount, receipt: `booking_${bookingId}`, notes: { bookingId: String(bookingId) } })).id;
    ctx.db
      .prepare("INSERT INTO payments (booking_id, razorpay_order_id, amount, status, created_at) VALUES (?, ?, ?, 'created', ?)")
      .run(bookingId, orderId, amount, new Date().toISOString());
  }
  return { keyId: rp.keyId, orderId, amountPaise: amount, currency: 'INR' };
}

// Called by the customer app with what Razorpay Checkout returned on success.
export function verifyCheckout(
  ctx: Ctx,
  customerId: number,
  bookingId: number,
  p: { orderId: string; paymentId: string; signature: string },
) {
  const rp = razorpayOf(ctx);
  const b = getBooking(ctx.db, bookingId);
  if (!b || b.customer_id !== customerId) throw new HttpError(404, 'Booking not found');
  const owned = ctx.db.prepare('SELECT 1 FROM payments WHERE razorpay_order_id = ? AND booking_id = ?').get(p.orderId, bookingId);
  if (!owned || !signatureMatches(hmacHex(rp.keySecret, `${p.orderId}|${p.paymentId}`), p.signature)) {
    throw new HttpError(400, 'Payment could not be verified');
  }
  markPaid(ctx, p.orderId, p.paymentId);
}

// Razorpay → POST /payments/razorpay/webhook. The signature over the exact raw body is the authentication.
export function handleWebhook(ctx: Ctx, rawBody: Buffer, signature: string | undefined) {
  const rp = razorpayOf(ctx);
  if (!rp.webhookSecret) throw new HttpError(503, 'Webhook secret is not configured');
  if (!signatureMatches(hmacHex(rp.webhookSecret, rawBody), signature)) throw new HttpError(400, 'Invalid signature');
  const event = JSON.parse(rawBody.toString('utf8')) as {
    event: string;
    payload?: { payment?: { entity?: { id: string; order_id: string | null } } };
  };
  const payment = event.payload?.payment?.entity;
  if ((event.event === 'payment.captured' || event.event === 'order.paid') && payment?.order_id) {
    markPaid(ctx, payment.order_id, payment.id);
  }
  // Every other event (payment.failed, refunds, ...) is acknowledged and ignored for now.
}

// Marks the order and its booking paid, and credits the driver their earning (the platform holds the money).
export function markPaid(ctx: Ctx, orderId: string, paymentId: string) {
  const { db } = ctx;
  const now = new Date().toISOString();
  const bookingId = db.transaction(() => {
    const pay = db.prepare('SELECT * FROM payments WHERE razorpay_order_id = ?').get(orderId) as PaymentRow | undefined;
    // Orders we didn't create (e.g. other apps on the same Razorpay account) and repeat deliveries are ignored.
    if (!pay || pay.status === 'paid') return null;
    db.prepare("UPDATE payments SET status = 'paid', razorpay_payment_id = ?, paid_at = ? WHERE id = ?").run(paymentId, now, pay.id);
    const r = db.prepare("UPDATE bookings SET payment_status = 'paid' WHERE id = ? AND payment_status = 'unpaid'").run(pay.booking_id);
    if (r.changes) {
      const b = getBooking(db, pay.booking_id)!;
      db.prepare(
        "INSERT INTO ledger_entries (driver_id, booking_id, kind, amount, note, created_at) VALUES (?, ?, 'earning', ?, ?, ?)",
      ).run(b.driver_id, b.id, -b.driver_earning!, `Earning on booking #${b.id} (paid online)`, now);
    }
    return pay.booking_id;
  })();
  if (bookingId) publishBooking(ctx, bookingId);
}
