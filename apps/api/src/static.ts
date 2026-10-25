// In production the API also serves the three built web apps, so everything runs from one address:
// customer app at /, driver app at /driver/, admin dashboard at /admin/, and the API itself under /api.
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const APPS = [
  { prefix: '/driver/', dir: '../../driver/dist' },
  { prefix: '/admin/', dir: '../../admin/dist' },
  { prefix: '/', dir: '../../customer/dist' },
];

// The service worker, manifest and pages must never be cached, or app updates won't roll out.
const NO_CACHE = /[\\/](sw\.js|registerSW\.js|manifest\.webmanifest|index\.html)$/;
const HASHED = /[\\/]assets[\\/]/;

export async function serveApps(app: FastifyInstance) {
  for (const [i, { prefix, dir }] of APPS.entries()) {
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL(dir, import.meta.url)),
      prefix,
      decorateReply: i === 0,
      setHeaders: (res, path) => {
        if (NO_CACHE.test(path)) res.setHeader('cache-control', 'no-cache');
        else if (HASHED.test(path)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    if (prefix !== '/') app.get(prefix.slice(0, -1), (_req, reply) => reply.redirect(prefix)); // /driver -> /driver/
  }
}
