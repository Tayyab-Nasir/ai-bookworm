import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextEditionTimestamp } from './lib/edition-timestamp.js';

test('advances exact microseconds when the clock is equal or behind', () => {
  const clock = Date.parse('2026-11-03T00:00:00.123Z');
  assert.equal(nextEditionTimestamp('2026-11-03T00:00:00.123456Z', clock), '2026-11-03T00:00:00.123457Z');
  assert.equal(nextEditionTimestamp('2026-11-03T05:00:00.123456+05:00', clock), '2026-11-03T00:00:00.123457Z');
  assert.equal(nextEditionTimestamp('2026-11-02T19:30:00.123456-04:30', clock), '2026-11-03T00:00:00.123457Z');
  assert.equal(nextEditionTimestamp('2026-11-03T00:00:00.1Z', clock), '2026-11-03T00:00:00.123000Z');
  assert.equal(nextEditionTimestamp('2026-11-03T00:00:00.123999Z', clock), '2026-11-03T00:00:00.124000Z');
  assert.equal(nextEditionTimestamp('2026-11-03T00:00:00.123456Z', clock - 1_000_000), '2026-11-03T00:00:00.123457Z');
});
test('uses a later clock and handles microseconds before the Unix epoch', () => {
  assert.equal(nextEditionTimestamp('2026-11-03T00:00:00.123456Z', Date.parse('2026-11-03T00:00:01Z')), '2026-11-03T00:00:01.000000Z');
  assert.equal(nextEditionTimestamp('1969-12-31T23:59:59.999998Z', -1000), '1969-12-31T23:59:59.999999Z');
  assert.equal(nextEditionTimestamp('1969-12-31T23:59:59.999999Z', -1000), '1970-01-01T00:00:00.000000Z');
});
test('rejects malformed, impossible and unadvanceable revisions', () => {
  for (const invalid of ['bad', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '0000-01-01T00:00:00Z',
    '2026-01-01T24:00:00Z', '2026-01-01T00:00:00.1234567Z', '2026-01-01T00:00:00+16:00', '2026-01-01T00:00:00+05:60',
    '9999-12-31T23:59:59.999999Z']) assert.throws(() => nextEditionTimestamp(invalid, 0), invalid);
  assert.throws(() => nextEditionTimestamp('2026-01-01T00:00:00Z', NaN));
});
test('calendar validation handles leap centuries without JavaScript date rollover', () => {
  assert.equal(nextEditionTimestamp('2000-02-29T00:00:00.999999Z', 0), '2000-02-29T00:00:01.000000Z');
  assert.throws(() => nextEditionTimestamp('1900-02-29T00:00:00Z', 0));
});
