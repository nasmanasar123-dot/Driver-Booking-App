import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateFare, defaultPricing as p, isNight } from '../src/pricing.ts';

// 10:00 and 23:00 Dubai time (UTC+4)
const day = new Date('2026-10-24T06:00:00Z');
const night = new Date('2026-10-24T19:00:00Z');

test('short trips pay the minimum fare', () => {
  const f = calculateFare(p, { tripType: 'hourly', minutes: 20, startAt: day });
  assert.equal(f.billedMinutes, 120);
  assert.equal(f.fare, 12000);
  assert.equal(f.commission, 2400);
  assert.equal(f.driverEarning, 9600);
});

test('time beyond the minimum is billed in started blocks', () => {
  // 2h01m -> 2h15m billed -> one extra block
  assert.equal(calculateFare(p, { tripType: 'hourly', minutes: 121, startAt: day }).fare, 12000 + 1250 + 50);
  // 3h exactly -> four extra blocks = AED 170
  assert.equal(calculateFare(p, { tripType: 'hourly', minutes: 180, startAt: day }).fare, 17000);
});

test('fares round up to a whole dirham', () => {
  const f = calculateFare(p, { tripType: 'hourly', minutes: 135, startAt: day });
  assert.equal(f.fare % 100, 0);
  assert.equal(f.fare, 13300); // 132.50 -> 133
});

test('night surcharge applies to the time-based fare, one-way fee on top', () => {
  assert.equal(isNight(p, night), true);
  assert.equal(isNight(p, day), false);
  assert.equal(calculateFare(p, { tripType: 'hourly', minutes: 60, startAt: night }).fare, 14400);
  assert.equal(calculateFare(p, { tripType: 'one_way', minutes: 60, startAt: night }).fare, 17400);
});
