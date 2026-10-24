// Usage: npm run create-admin -w apps/api -- you@gmail.com "Your Name"
// The admin then signs in to the ops dashboard with that Google account.
import { config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { createUser, findUserByEmail } from '../src/users.ts';

const [rawEmail, name] = process.argv.slice(2);
if (!rawEmail || !rawEmail.includes('@')) {
  console.error('Usage: npm run create-admin -w apps/api -- <google email> [name]');
  process.exit(1);
}

const db = openDb(config.dbPath);
const email = rawEmail.trim().toLowerCase();
const existing = findUserByEmail(db, email);
if (existing && existing.role !== 'admin') {
  console.error(`${email} is already registered as a ${existing.role}.`);
  process.exit(1);
}
const admin = existing ?? createUser(db, { role: 'admin', email, name });
console.log(`Admin ready: #${admin.id} ${email}. Sign in to the ops dashboard with this Google account.`);
db.close();
