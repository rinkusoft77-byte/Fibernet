import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/v18-profile.js';
import { __test as gateway } from '../src/index-v18.js';

test('v18 gateway version', () => {
  assert.equal(gateway.version, '18.0.0');
});

test('profile requires realistic first and last names', () => {
  assert.equal(__test.validName('Ali'), 'Ali');
  assert.equal(__test.validName('Abdulloh O‘g‘li'), 'Abdulloh O‘g‘li');
  assert.equal(__test.validName('A1i'), null);
  assert.equal(__test.validName('A'), null);
});

test('profile status text is localized', () => {
  assert.match(__test.profileStatusText('approved', 'uz'), /Tasdiqlagan/);
  assert.match(__test.profileStatusText('pending', 'ru'), /подтверждения/i);
  assert.match(__test.profileStatusText('skipped', 'uz'), /o‘tkazib/i);
});
