import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.ts';
import type { Ctx, GoogleProfile } from './context.ts';
import { HttpError } from './errors.ts';
import { createUser, findUserByEmail, findUserByGoogleSub, userDto, type Role, type UserRow } from './users.ts';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: number; role: Role };
    user: { sub: number; role: Role };
  }
}

// Accepts local UAE formats (05x..., 9715x...) and any E.164 number.
export function normalizePhone(input: string): string {
  let p = input.replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  else if (p.startsWith('05')) p = '+971' + p.slice(1);
  else if (p.startsWith('971')) p = '+' + p;
  if (!/^\+[1-9]\d{7,14}$/.test(p)) throw new HttpError(400, 'Enter a valid mobile number');
  return p;
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest) => {
    await req.jwtVerify();
    if (!roles.includes(req.user.role)) throw new HttpError(403, 'Forbidden');
  };
}

const session = (app: FastifyInstance, user: UserRow) => ({
  token: app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: '30d' }),
  user: userDto(user),
});

// One account = one role. Customers and drivers are created on first sign-in;
// admins must be created beforehand by email (scripts/create-admin.ts) and are linked on first sign-in.
function findOrCreateUser(ctx: Ctx, profile: GoogleProfile, role: Role): UserRow {
  const { db } = ctx;
  let user = findUserByGoogleSub(db, profile.sub);
  if (!user) {
    const byEmail = findUserByEmail(db, profile.email);
    if (byEmail?.google_sub) throw new HttpError(409, 'This email is linked to a different Google account');
    if (byEmail) {
      db.prepare('UPDATE users SET google_sub = ?, name = COALESCE(name, ?) WHERE id = ?').run(profile.sub, profile.name ?? null, byEmail.id);
      user = findUserByGoogleSub(db, profile.sub)!;
    }
  }
  if (!user) {
    if (role === 'admin') throw new HttpError(403, 'This Google account is not an admin');
    user = createUser(db, { role, googleSub: profile.sub, email: profile.email, name: profile.name });
  }
  if (user.role !== role) throw new HttpError(403, `This Google account is registered as a ${user.role} — use a different account`);
  return user;
}

const appName = z.enum(['customer', 'driver', 'admin']);

export function authRoutes(ctx: Ctx) {
  return async (app: FastifyInstance) => {
    const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

    // Lets the apps configure their sign-in screen without separate env files.
    app.get('/config', async () => ({ googleClientId: config.googleClientId || null, devLogin: config.devLogin }));

    app.post('/google', limited, async (req) => {
      const body = z.object({ idToken: z.string(), app: appName }).parse(req.body);
      const profile = await ctx.verifyGoogleToken(body.idToken);
      return session(app, findOrCreateUser(ctx, profile, body.app));
    });

    if (config.devLogin) {
      // Development only: sign in as any email, so you can test all three roles without three Google accounts.
      app.post('/dev', async (req) => {
        const body = z.object({ email: z.email(), app: appName }).parse(req.body);
        const email = body.email.toLowerCase();
        const existing = findUserByEmail(ctx.db, email);
        const user = existing ?? (body.app === 'admin' ? null : createUser(ctx.db, { role: body.app, email }));
        if (!user) throw new HttpError(403, 'Not an admin — run npm run create-admin first');
        if (user.role !== body.app) throw new HttpError(403, `This email is registered as a ${user.role}`);
        return session(app, user);
      });
    }
  };
}
