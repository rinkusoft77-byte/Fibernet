import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/v16-ux.js';
import { __test as gateway } from '../src/index-v16.js';

test('v16 gateway version', () => {
  assert.equal(gateway.version, '16.0.0');
});

test('service hub is problem-first, not department-first', () => {
  const kb = __test.serviceHubKeyboard('uz');
  const labels = kb.inline_keyboard.flat().map(x => x.text);
  assert.ok(labels.some(x => x.includes('Internet ishlamayapti')));
  assert.ok(labels.some(x => x.includes('To‘lov / balans')));
  assert.ok(labels.some(x => x.includes('Muammoni o‘zim yozaman')));
});

test('shorten keeps operator cards compact', () => {
  assert.equal(__test.shorten('1234567890', 6), '12345…');
  assert.equal(__test.shorten('short', 10), 'short');
});

test('operator ask templates exist in both languages', () => {
  for (const key of ['login','address','photo','los','speedtest','restart']) {
    assert.ok(__test.ASK_TEMPLATES[key].uz.length > 5);
    assert.ok(__test.ASK_TEMPLATES[key].ru.length > 5);
  }
});
