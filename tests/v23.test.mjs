import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as admin } from '../src/v23-admin.js';
import { __test as gateway } from '../src/index-v23.js';

test('v23 gateway version', () => {
  assert.equal(gateway.version, '23.0.0');
  assert.equal(admin.version, '23.0.0');
});

test('admin panel is restricted to ADMIN_IDS', () => {
  const env = { ADMIN_IDS: '7294324265, 111;222' };
  assert.equal(admin.isBotAdmin(env, 7294324265), true);
  assert.equal(admin.isBotAdmin(env, '111'), true);
  assert.equal(admin.isBotAdmin(env, 222), true);
  assert.equal(admin.isBotAdmin(env, 333), false);
});

test('empty ADMIN_IDS grants nobody admin access', () => {
  assert.equal(admin.isBotAdmin({ ADMIN_IDS: '' }, 1), false);
});
