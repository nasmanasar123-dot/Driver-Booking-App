import type { DB } from './db.ts';

export type Role = 'customer' | 'driver' | 'admin';

export type UserRow = {
  id: number;
  role: Role;
  name: string | null;
  phone: string | null;
  email: string | null;
  google_sub: string | null;
  created_at: string;
};

export const getUser = (db: DB, id: number) =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;

export const findUserByPhone = (db: DB, phone: string) =>
  db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) as UserRow | undefined;

export const findUserByEmail = (db: DB, email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) as UserRow | undefined;

export const findUserByGoogleSub = (db: DB, sub: string) =>
  db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub) as UserRow | undefined;

export function createUser(
  db: DB,
  data: { role: Role; phone?: string; name?: string; email?: string; googleSub?: string },
): UserRow {
  return db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (role, name, phone, email, google_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(data.role, data.name ?? null, data.phone ?? null, data.email ?? null, data.googleSub ?? null, new Date().toISOString());
    if (data.role === 'driver') db.prepare('INSERT INTO drivers (user_id) VALUES (?)').run(lastInsertRowid);
    return getUser(db, Number(lastInsertRowid))!;
  })();
}

export const userDto = (u: UserRow) => ({ id: u.id, role: u.role, name: u.name, phone: u.phone, email: u.email });
