import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/index-v4.js';

test('v4 module imports and normalizes Telegram contact numbers', () => {
  assert.equal(__test.normalizePhone('+998 90 138 18 04'), '+998901381804');
  assert.equal(__test.normalizePhone('90 138 18 04'), '+998901381804');
  assert.equal(__test.normalizePhone('0901381804'), '+998901381804');
});

test('v4 text routing reaches the expected department', () => {
  assert.deepEqual(__test.classifyText('wifi ishlamayapti'), { action: 'ticket', department: 'tech', category: 'wifi' });
  assert.deepEqual(__test.classifyText("to'lov tushmadi"), { action: 'ticket', department: 'accounting', category: 'payment_missing' });
  assert.deepEqual(__test.classifyText('yangi internet ulanish kerak'), { action: 'ticket', department: 'connection', category: 'connection' });
  assert.deepEqual(__test.classifyText('tariflar'), { action: 'tariffs' });
});

test('unknown text does not create a random ticket', () => {
  assert.deepEqual(__test.classifyText('abc xyz'), { action: 'departments' });
});
