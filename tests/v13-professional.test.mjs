import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test as indexTest } from '../src/index-v13.js';
import { __test } from '../src/v13-professional.js';

test('v13 worker imports and exposes version', () => {
  assert.equal(typeof worker.fetch, 'function');
  assert.equal(indexTest.version, '13.0.0');
});

test('professional SLA priorities are ordered correctly', () => {
  assert.equal(__test.SLA_MINUTES.critical, 10);
  assert.equal(__test.SLA_MINUTES.high, 20);
  assert.ok(__test.SLA_MINUTES.normal > __test.SLA_MINUTES.high);
  assert.ok(__test.SLA_MINUTES.low > __test.SLA_MINUTES.normal);
});

test('minutesSince returns a non-negative age', () => {
  const d = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const age = __test.minutesSince(d);
  assert.ok(age >= 4 && age <= 6);
});
