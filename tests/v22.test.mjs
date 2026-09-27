import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as content } from '../src/v22-content.js';
import { __test as gateway } from '../src/index-v22.js';

test('v22 gateway version', () => {
  assert.equal(gateway.version, '22.0.0');
});

test('premium content uses only official FiberNet source domains', () => {
  const urls = Object.values(content.OFFICIAL);
  assert.ok(urls.length >= 10);
  for (const url of urls) {
    assert.match(url, /^https:\/\//);
    assert.ok(
      url.includes('fibernet.uz') || url.includes('t.me/fibernet_'),
      `unexpected source: ${url}`
    );
  }
});

test('premium artwork is hosted by official FiberNet site', () => {
  for (const url of Object.values(content.ART)) {
    assert.ok(url.startsWith('https://www.fibernet.uz/'));
  }
});
