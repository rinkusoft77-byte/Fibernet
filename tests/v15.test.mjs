import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/v15-helpdesk.js';
import { __test as gateway } from '../src/index-v15.js';

test('v15 gateway version', () => {
  assert.equal(gateway.version, '15.0.0');
});

test('normalizes operator skills', () => {
  assert.deepEqual(
    __test.normalizeSkills('GPON, wifi; iptv wifi unknown'),
    ['gpon', 'wifi', 'iptv']
  );
});

test('derives skills from GPON Wi-Fi ticket', () => {
  assert.deepEqual(
    __test.requiredSkills('wifi', 'gpon_onuwifi'),
    ['gpon', 'wifi']
  );
});

test('skill match improves assignment score', () => {
  const t = { priority: 'high', created_at: new Date(Date.now() - 60000).toISOString() };
  const matched = __test.assignmentScore(t, ['gpon','wifi'], ['gpon','wifi'], 1, 5);
  const unmatched = __test.assignmentScore(t, ['gpon','wifi'], ['ethernet'], 1, 5);
  assert.ok(matched > unmatched);
});

test('relayKind supports professional Telegram media', () => {
  assert.equal(__test.relayKind({ sticker: {} }), 'sticker');
  assert.equal(__test.relayKind({ video: {} }), 'video');
  assert.equal(__test.relayKind({ photo: [{}] }), 'photo');
  assert.equal(__test.relayKind({ voice: {} }), 'voice');
  assert.equal(__test.relayKind({ location: {} }), 'location');
});
