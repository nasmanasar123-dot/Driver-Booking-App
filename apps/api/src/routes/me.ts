import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizePhone, requireRole } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../errors.ts';
import { findUserByPhone, getUser, userDto } from '../users.ts';

export function meRoutes(ctx: Ctx) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireRole('customer', 'driver', 'admin'));

    app.get('/', async (req) => {
      const user = getUser(ctx.db, req.user.sub);
      if (!user) throw new HttpError(401, 'Account not found');
      return userDto(user);
    });

    // Name and contact number. The phone isn't verified by SMS; it's what drivers and customers use to call each other.
    app.patch('/', async (req) => {
      const body = z
        .object({ name: z.string().trim().min(1).max(100).optional(), phone: z.string().optional() })
        .parse(req.body);
      if (body.name) ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(body.name, req.user.sub);
      if (body.phone) {
        const phone = normalizePhone(body.phone);
        const owner = findUserByPhone(ctx.db, phone);
        if (owner && owner.id !== req.user.sub) throw new HttpError(409, 'This number is used by another account');
        ctx.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user.sub);
      }
      return userDto(getUser(ctx.db, req.user.sub)!);
    });
  };
}
