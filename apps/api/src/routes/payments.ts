import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { handleWebhook } from '../payments.ts';

// Public routes (no sign-in).
export function paymentRoutes(ctx: Ctx) {
  return async (app: FastifyInstance) => {
    app.get('/config', async () => ({ online: !!ctx.razorpay }));

    // The webhook signature is computed over the raw bytes, so keep the body unparsed in this plugin.
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    app.post('/razorpay/webhook', async (req) => {
      handleWebhook(ctx, req.body as Buffer, req.headers['x-razorpay-signature'] as string | undefined);
      return { ok: true };
    });
  };
}
