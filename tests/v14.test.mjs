import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as indexTest } from '../src/index-v14.js';
import { __test, ACCESS_TYPES } from '../src/v14-access.js';

test('v14 worker version', () => {
  assert.equal(indexTest.version, '14.0.0');
});

test('access types include ethernet and both GPON ONU variants', () => {
  assert.deepEqual(ACCESS_TYPES, ['ethernet', 'gpon_onu', 'gpon_onuwifi']);
});

test('access labels are bilingual', () => {
  assert.match(__test.accessLabel('ethernet', 'uz'), /Ethernet/);
  assert.match(__test.accessLabel('gpon_onu', 'ru'), /GPON/);
  assert.match(__test.accessLabel('gpon_onuwifi', 'uz'), /Wi/);
});

test('GPON no internet diagnostic checks PON and LOS', () => {
  const text = __test.diagnosticText('uz', 'gpon_onu', 'no_internet', 'physical');
  assert.match(text, /PON/);
  assert.match(text, /LOS/);
});

test('Ethernet diagnostic is cable aware', () => {
  const text = __test.diagnosticText('uz', 'ethernet', 'no_internet', 'physical');
  assert.match(text, /Ethernet/);
  assert.match(text, /LAN\/WAN/);
});
