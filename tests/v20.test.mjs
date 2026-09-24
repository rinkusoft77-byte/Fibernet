import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as topicOnly } from '../src/v20-topic-only.js';
import { __test as gateway } from '../src/index-v20.js';

test('v20 gateway version', () => {
  assert.equal(gateway.version, '20.0.0');
});

test('customer conversation policy is strict topic-only', () => {
  assert.equal(topicOnly.TOPIC_POLICY, 'strict-topic-only-customer-conversations');
});
