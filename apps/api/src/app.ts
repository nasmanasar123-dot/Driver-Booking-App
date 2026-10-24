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
import { attachRealtime, type Realtime } from './realtime.ts';
import { adminRoutes } from './routes/admin.ts';
import { customerRoutes } from './routes/customer.ts';
import { driverRoutes } from './routes/driver.ts';
import { meRoutes } from './routes/me.ts';

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
  logger?: boolean;
  sweep?: boolean; // run the stale-request sweeper on a timer
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

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes(ctx), { prefix: '/auth' });
  await app.register(meRoutes(ctx), { prefix: '/me' });
  await app.register(customerRoutes(ctx), { prefix: '/customer' });
  await app.register(driverRoutes(ctx), { prefix: '/driver' });
  await app.register(adminRoutes(ctx), { prefix: '/admin' });

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
