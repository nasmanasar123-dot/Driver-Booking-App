import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateFare, defaultPricing as p, isNight } from '../src/pricing.ts';

// 10:00 and 23:00 India time (UTC+5:30)
const day = new Date('2026-10-24T04:30:00Z');
const night = new Date('2026-10-24T17:30:00Z');

test('short trips pay the minimum fare', () => {
  const f = calculateFare(p, { tripType: 'hourly', minutes: 20, startAt: day });
  assert.equal(f.billedMinutes, 120);
  assert.equal(f.fare, 50000);
  assert.equal(f.commission, 10000);
  assert.equal(f.driverEarning, 40000);
});

test('time beyond the minimum is billed in started blocks', () => {
  // 2h01m -> 2h15m billed -> one extra block
  assert.equal(calculateFare(p, { tripType: 'hourly', minutes: 121, startAt: day }).fare, 50000 + 6000);
  // 3h exactly -> four extra blocks = ₹740
  assert.equal(calculateFare(p, { tripType: 'hourly', minutes: 180, startAt: day }).fare, 74000);
});

test('fares round up to a whole rupee', () => {
  const f = calculateFare({ ...p, blockFare: 6250 }, { tripType: 'hourly', minutes: 135, startAt: day });
  assert.equal(f.fare % 100, 0);
  assert.equal(f.fare, 56300); // 562.50 -> 563
});

test('night is judged in India time', () => {
  assert.equal(isNight(p, night), true);
  assert.equal(isNight(p, day), false);
  // 21:59 IST is still day, 22:00 IST is night
  assert.equal(isNight(p, new Date('2026-10-24T16:29:00Z')), false);
  assert.equal(isNight(p, new Date('2026-10-24T16:30:00Z')), true);
});

test('night surcharge applies to the time-based fare, one-way fee on top', () => {
  assert.equal(calculateFare(p, { tripType: 'hourly', minutes: 60, startAt: night }).fare, 60000);
  assert.equal(calculateFare(p, { tripType: 'one_way', minutes: 60, startAt: night }).fare, 80000);
});
