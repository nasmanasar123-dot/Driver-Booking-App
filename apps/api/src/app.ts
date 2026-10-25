import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { ZodError } from 'zod';
import { authRoutes } from './auth.ts';
import { sweepStaleRequests } from './bookings.ts';
import { config } from './config.ts';
import type { Ctx, GoogleProfile } from './context.ts';
import type { DB } from './db.ts';
import { HttpError } from './errors.ts';
import { razorpayFromConfig, type Razorpay } from './payments.ts';
import { attachRealtime, type Realtime } from './realtime.ts';
import { adminRoutes } from './routes/admin.ts';
import { customerRoutes } from './routes/customer.ts';
import { driverRoutes } from './routes/driver.ts';
import { meRoutes } from './routes/me.ts';
import { paymentRoutes } from './routes/payments.ts';
import { serveApps } from './static.ts';

const googleClient = new OAuth2Client();

async function verifyGoogleToken(idToken: string): Promise<GoogleProfile> {
  if (!config.googleClientId) throw new HttpError(503, 'Google sign-in is not configured');
  const ticket = await googleClient.verifyIdToken({ idToken, audience: config.googleClientId }).catch(() => {
    throw new HttpError(401, 'Google sign-in failed');
  });
  const p = ticket.getPayload();
  if (!p?.sub || !p.email || !p.email_verified) throw new HttpError(401, 'Google sign-in failed');
  return { sub: p.sub, email: p.email, name: p.name };
}

export type AppDeps = {
  db: DB;
  realtime?: Realtime; // defaults to Socket.IO on the app's HTTP server
  verifyGoogleToken?: Ctx['verifyGoogleToken'];
  razorpay?: Razorpay | null; // defaults to the keys in config
  logger?: boolean;
  sweep?: boolean; // run the stale-request sweeper on a timer
  serveApps?: boolean; // also serve the built web apps (production)
};

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });
  await app.register(fastifyJwt, { secret: config.jwtSecret });
  await app.register(rateLimit, { global: false });

  const realtime = deps.realtime ?? attachRealtime(app.server, (token) => app.jwt.verify(token));
  const ctx: Ctx = {
    db: deps.db,
    realtime,
    verifyGoogleToken: deps.verifyGoogleToken ?? verifyGoogleToken,
    razorpay: deps.razorpay === undefined ? razorpayFromConfig() : deps.razorpay,
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => i.message).join('; ') });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (err instanceof HttpError || (status && status < 500)) {
      return reply.code(status!).send({ error: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));
      await api.register(authRoutes(ctx), { prefix: '/auth' });
      await api.register(meRoutes(ctx), { prefix: '/me' });
      await api.register(customerRoutes(ctx), { prefix: '/customer' });
      await api.register(driverRoutes(ctx), { prefix: '/driver' });
      await api.register(adminRoutes(ctx), { prefix: '/admin' });
      await api.register(paymentRoutes(ctx), { prefix: '/payments' });
    },
    { prefix: '/api' },
  );
  if (deps.serveApps) await serveApps(app);

  if (deps.sweep) {
    const timer = setInterval(() => {
      try {
        sweepStaleRequests(ctx);
      } catch (err) {
        app.log.error(err);
      }
    }, config.dispatch.sweepIntervalSec * 1000);
    app.addHook('onClose', async () => clearInterval(timer));
  }
  app.addHook('onClose', async () => realtime.close());

  return { app, ctx };
}
