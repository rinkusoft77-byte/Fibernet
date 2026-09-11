import test from 'node:test';
import assert from 'node:assert/strict';
import app, { __test as appTest } from '../src/index-v11.js';
import { __test } from '../src/v11-support.js';

test('v11 worker exports fetch and scheduled', () => {
  assert.equal(typeof app.fetch, 'function');
  assert.equal(typeof app.scheduled, 'function');
  assert.equal(appTest.version, '11.0.0');
});

test('operator keyboard includes claim reply transfer and close', () => {
  const k = __test.operatorKeyboard('FN-TEST');
  const callbacks = k.inline_keyboard.flat().map(x => x.callback_data);
  assert.ok(callbacks.includes('op:claim:FN-TEST'));
  assert.ok(callbacks.includes('op:reply:FN-TEST'));
  assert.ok(callbacks.includes('op:transfer:FN-TEST'));
  assert.ok(callbacks.includes('op:close:FN-TEST'));
});

test('transfer keyboard excludes current department', () => {
  const k = __test.transferKeyboard('FN-TEST', 'tech');
  const callbacks = k.inline_keyboard.flat().map(x => x.callback_data);
  assert.ok(!callbacks.includes('opmove:tech:FN-TEST'));
  assert.ok(callbacks.includes('opmove:subscriber:FN-TEST'));
  assert.ok(callbacks.includes('opmove:accounting:FN-TEST'));
});

test('professional ticket stages are readable', () => {
  assert.match(__test.stageLabel('new'), /Yangi/);
  assert.match(__test.stageLabel('waiting_customer'), /Mijoz/);
  assert.match(__test.stageLabel('resolved'), /Hal qilindi/);
});
