import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/v17-operator.js';
import { __test as gateway } from '../src/index-v17.js';

test('v17 gateway version', () => {
  assert.equal(gateway.version, '17.0.0');
});

test('relay supports operator media types', () => {
  assert.equal(__test.relayKind({ text: 'x' }), 'text');
  assert.equal(__test.relayKind({ sticker: {} }), 'sticker');
  assert.equal(__test.relayKind({ photo: [{}] }), 'photo');
  assert.equal(__test.relayKind({ video: {} }), 'video');
  assert.equal(__test.relayKind({ voice: {} }), 'voice');
  assert.equal(__test.relayKind({ document: {} }), 'document');
});

test('priority keyboard exposes all service priorities', () => {
  const labels = __test.priorityKeyboard('FN-260920-ABCDEF').inline_keyboard.flat().map(x => x.text);
  assert.ok(labels.some(x => x.includes('Critical')));
  assert.ok(labels.some(x => x.includes('High')));
  assert.ok(labels.some(x => x.includes('Normal')));
  assert.ok(labels.some(x => x.includes('Low')));
});

test('snooze keyboard has quick follow-up intervals', () => {
  const callbacks = __test.snoozeKeyboard('FN-260920-ABCDEF').inline_keyboard.flat().map(x => x.callback_data);
  assert.ok(callbacks.some(x => x.endsWith(':15')));
  assert.ok(callbacks.some(x => x.endsWith(':60')));
  assert.ok(callbacks.some(x => x.endsWith(':240')));
  assert.ok(callbacks.some(x => x.endsWith(':1440')));
});
