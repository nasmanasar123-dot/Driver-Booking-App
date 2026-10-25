import { buildApp } from './app.ts';
import { config } from './config.ts';
import { openDb } from './db.ts';

const db = openDb(config.dbPath);
const { app } = await buildApp({ db, logger: true, sweep: true, serveApps: config.isProd });

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
