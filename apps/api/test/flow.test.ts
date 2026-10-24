import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { sweepStaleRequests } from '../src/bookings.ts';
import { openDb } from '../src/db.ts';
import { createUser } from '../src/users.ts';

type Event = { to: string; event: string; data: any };

async function setup() {
  const db = openDb(':memory:');
  const events: Event[] = [];
  const { app, ctx } = await buildApp({
    db,
    realtime: {
      toUser: (id, event, data) => void events.push({ to: `user:${id}`, event, data }),
      toAdmins: (event, data) => void events.push({ to: 'admins', event, data }),
      close: async () => {},
    },
    // In tests the "Google ID token" is just the email address.
    verifyGoogleToken: async (email) => ({ sub: `google-${email}`, email, name: email.split('@')[0] }),
  });

  async function call(method: string, url: string, token?: string, body?: unknown) {
    const res = await app.inject({
      method: method as any,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as any } : {}),
    });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  }

  async function login(email: string, appName: 'customer' | 'driver' | 'admin') {
    const res = await call('POST', '/auth/google', undefined, { idToken: email, app: appName });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.token as string;
  }

  async function approvedDriver(n: number, admin: string, location = DOWNTOWN) {
    const token = await login(`driver${n}@example.com`, 'driver');
    const me = await call('GET', '/me', token);
    const profile = await call('PUT', '/driver/profile', token, {
      name: `Driver ${n}`,
      phone: `05022200${String(n).padStart(2, '0')}`,
      emiratesId: '784-1990-1234567-1',
      licenseNumber: 'DL123456',
      licenseExpiry: '2028-01-01',
      canDriveManual: false,
    });
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    assert.equal((await call('POST', `/admin/drivers/${me.body.id}/status`, admin, { status: 'approved' })).status, 200);
    assert.equal((await call('POST', '/driver/online', token, { online: true, location })).status, 200);
    return { token, id: me.body.id as number };
  }

  createUser(db, { role: 'admin', email: 'ops@example.com', name: 'Ops' });
  const admin = await login('ops@example.com', 'admin');
  return { db, app, ctx, call, login, approvedDriver, events, admin };
}

const DOWNTOWN = { lat: 25.1972, lng: 55.2744 };
const MARINA = { lat: 25.0805, lng: 55.1403 }; // ~18 km from downtown

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});

async function customerWithCar(email = 'customer@example.com', transmission = 'automatic') {
  const token = await t.login(email, 'customer');
  assert.equal((await t.call('PATCH', '/me', token, { name: 'Sara', phone: '050 111 2222' })).status, 200);
  const car = await t.call('POST', '/customer/vehicles', token, { make: 'Toyota', model: 'Camry', plate: 'dubai a 12345', transmission });
  assert.equal(car.status, 200);
  return { token, vehicleId: car.body.id as number };
}

const bookingBody = (vehicleId: number) => ({
  vehicleId,
  tripType: 'hourly',
  pickup: { address: 'Burj Khalifa, Downtown Dubai', ...DOWNTOWN },
  estimatedMinutes: 180,
});

test('happy path: book, offer, accept, start with code, complete, settle cash commission', async () => {
  const near = await t.approvedDriver(1, t.admin);
  const far = await t.approvedDriver(2, t.admin, MARINA);
  const customer = await customerWithCar();

  const created = await t.call('POST', '/customer/bookings', customer.token, bookingBody(customer.vehicleId));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal(created.body.status, 'requested');
  assert.equal(created.body.startOtp, null);

  // Only the driver within the radius gets the offer, and it doesn't reveal the customer.
  const offers = t.events.filter((e) => e.event === 'offer:new');
  assert.deepEqual(offers.map((e) => e.to), [`user:${near.id}`]);
  assert.equal(offers[0].data.customer, undefined);
  assert.equal((await t.call('GET', '/driver/offers', far.token)).body.length, 0);

  // A second booking from the same customer is refused while one is open.
  assert.equal((await t.call('POST', '/customer/bookings', customer.token, bookingBody(customer.vehicleId))).status, 409);

  const accepted = await t.call('POST', `/driver/offers/${id}/accept`, near.token);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.customer.phone, '+971501112222');

  const assigned = await t.call('GET', `/customer/bookings/${id}`, customer.token);
  assert.equal(assigned.body.status, 'assigned');
  assert.equal(assigned.body.driver.phone, '+971502220001');
  const otp = assigned.body.startOtp;
  assert.match(otp, /^\d{4}$/);

  assert.equal((await t.call('POST', `/driver/bookings/${id}/start`, near.token, { otp: otp === '0000' ? '1111' : '0000' })).status, 400);
  assert.equal((await t.call('POST', `/driver/bookings/${id}/start`, near.token, { otp })).body.status, 'started');

  const done = await t.call('POST', `/driver/bookings/${id}/complete`, near.token);
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'completed');
  assert.equal(done.body.finalFareFils % 100, 0);
  assert.equal(done.body.commissionFils + done.body.driverEarningFils, done.body.finalFareFils);

  // Driver now owes the commission from the cash they collected.
  const ledger = await t.call('GET', '/driver/ledger', near.token);
  assert.equal(ledger.body.balanceOwedFils, done.body.commissionFils);

  assert.equal((await t.call('POST', `/admin/drivers/${near.id}/settlements`, t.admin, { amountFils: done.body.commissionFils })).status, 200);
  assert.equal((await t.call('GET', '/driver/ledger', near.token)).body.balanceOwedFils, 0);

  assert.equal((await t.call('POST', `/customer/bookings/${id}/rate`, customer.token, { rating: 5 })).status, 200);
  assert.equal((await t.call('POST', `/customer/bookings/${id}/rate`, customer.token, { rating: 1 })).status, 409);

  // Admins were pushed every status change.
  const pushed = t.events.filter((e) => e.event === 'booking:updated' && e.to === 'admins').map((e) => e.data.status);
  for (const s of ['requested', 'assigned', 'started', 'completed']) assert.ok(pushed.includes(s), s);
});

test('no nearby drivers -> admin dispatch queue -> manual assignment', async () => {
  const far = await t.approvedDriver(2, t.admin, MARINA);
  const customer = await customerWithCar();
  const { body } = await t.call('POST', '/customer/bookings', customer.token, bookingBody(customer.vehicleId));

  const queue = await t.call('GET', '/admin/bookings?status=open', t.admin);
  assert.equal(queue.body[0].needsDispatch, true);
  assert.equal((await t.call('GET', '/admin/overview', t.admin)).body.needsDispatch, 1);

  const assigned = await t.call('POST', `/admin/bookings/${body.id}/assign`, t.admin, { driverId: far.id });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.status, 'assigned');
  assert.equal(assigned.body.needsDispatch, false);
  assert.equal((await t.call('GET', '/driver/bookings/current', far.token)).body.id, body.id);
});

test('offers time out into the dispatch queue and are revoked from drivers', async () => {
  const driver = await t.approvedDriver(1, t.admin);
  const customer = await customerWithCar();
  const { body } = await t.call('POST', '/customer/bookings', customer.token, bookingBody(customer.vehicleId));

  t.db.prepare("UPDATE bookings SET offered_at = '2000-01-01T00:00:00.000Z'").run();
  sweepStaleRequests(t.ctx);

  assert.ok(t.events.some((e) => e.event === 'offer:revoked' && e.to === `user:${driver.id}`));
  assert.equal((await t.call('GET', '/driver/offers', driver.token)).body.length, 0);
  assert.equal((await t.call('POST', `/driver/offers/${body.id}/accept`, driver.token)).status, 409);
  assert.equal((await t.call('GET', `/admin/bookings/${body.id}`, t.admin)).body.needsDispatch, true);
});

test('first driver to accept wins; driver release re-offers to others', async () => {
  const a = await t.approvedDriver(1, t.admin);
  const b = await t.approvedDriver(3, t.admin);
  const customer = await customerWithCar();
  const { body } = await t.call('POST', '/customer/bookings', customer.token, bookingBody(customer.vehicleId));

  assert.equal((await t.call('POST', `/driver/offers/${body.id}/accept`, a.token)).status, 200);
  assert.equal((await t.call('POST', `/driver/offers/${body.id}/accept`, b.token)).status, 409);

  // b's offer was expired when a accepted; after a releases, b isn't re-offered (already saw it) -> dispatch queue.
  assert.equal((await t.call('POST', `/driver/bookings/${body.id}/release`, a.token)).status, 200);
  const after = await t.call('GET', `/admin/bookings/${body.id}`, t.admin);
  assert.equal(after.body.status, 'requested');
  assert.equal(after.body.needsDispatch, true);
});

test('manual cars are only offered to drivers who can drive manual', async () => {
  await t.approvedDriver(1, t.admin);
  const customer = await customerWithCar('customer@example.com', 'manual');
  const { body } = await t.call('POST', '/customer/bookings', customer.token, bookingBody(customer.vehicleId));
  assert.equal(t.events.filter((e) => e.event === 'offer:new').length, 0);
  assert.equal((await t.call('GET', `/admin/bookings/${body.id}`, t.admin)).body.needsDispatch, true);
});

test('guards: service area, roles, approval, cash limit, cancellation', async () => {
  const customer = await customerWithCar();
  const outside = await t.call('POST', '/customer/bookings', customer.token, {
    ...bookingBody(customer.vehicleId),
    pickup: { address: 'Abu Dhabi Corniche', lat: 24.47, lng: 54.35 },
  });
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /Dubai/);

  assert.equal((await t.call('GET', '/admin/overview', customer.token)).status, 403);

  // Unapproved drivers can't go online.
  const pending = await t.login('newdriver@example.com', 'driver');
  assert.equal((await t.call('POST', '/driver/online', pending, { online: true })).status, 403);

  // Drivers owing more than the cash limit can't go online.
  const d = await t.approvedDriver(1, t.admin);
  t.db.prepare("INSERT INTO ledger_entries (driver_id, kind, amount, created_at) VALUES (?, 'adjustment', 999999, 'x')").run(d.id);
  assert.equal((await t.call('POST', '/driver/online', d.token, { online: true })).status, 403);

  // Customers can cancel before the trip starts.
  const { body } = await t.call('POST', '/customer/bookings', customer.token, bookingBody(customer.vehicleId));
  const cancelled = await t.call('POST', `/customer/bookings/${body.id}/cancel`, customer.token, { reason: 'Plans changed' });
  assert.equal(cancelled.body.status, 'cancelled');
});

test('sign-in: one Google account per role, admins must be pre-created', async () => {
  await t.login('sara@example.com', 'customer');
  const asDriver = await t.call('POST', '/auth/google', undefined, { idToken: 'sara@example.com', app: 'driver' });
  assert.equal(asDriver.status, 403);
  assert.match(asDriver.body.error, /customer/);

  assert.equal((await t.call('POST', '/auth/google', undefined, { idToken: 'stranger@example.com', app: 'admin' })).status, 403);

  // Pre-created admin is linked to their Google account on first sign-in.
  const linked = t.db.prepare("SELECT google_sub FROM users WHERE email = 'ops@example.com'").pluck().get();
  assert.equal(linked, 'google-ops@example.com');
});

test('a mobile number is required before booking, and must be unique', async () => {
  const token = await t.login('nophone@example.com', 'customer');
  const car = await t.call('POST', '/customer/vehicles', token, { make: 'Nissan', model: 'Patrol', plate: 'B 1', transmission: 'automatic' });
  const blocked = await t.call('POST', '/customer/bookings', token, bookingBody(car.body.id));
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /mobile/);

  assert.equal((await t.call('PATCH', '/me', token, { phone: 'not a phone' })).status, 400);
  await customerWithCar('first@example.com'); // takes 050 111 2222
  assert.equal((await t.call('PATCH', '/me', token, { phone: '0501112222' })).status, 409);
});

test('dev sign-in works without Google (development only)', async () => {
  const res = await t.call('POST', '/auth/dev', undefined, { email: 'Tester@Example.com', app: 'driver' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'tester@example.com');
  assert.equal((await t.call('POST', '/auth/dev', undefined, { email: 'nobody@example.com', app: 'admin' })).status, 403);
  assert.equal((await t.call('POST', '/auth/dev', undefined, { email: 'ops@example.com', app: 'admin' })).status, 200);
  assert.deepEqual((await t.call('GET', '/auth/config')).body, { googleClientId: null, devLogin: true });
});
