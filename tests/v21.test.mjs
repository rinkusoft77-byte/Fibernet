import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/v21-conversation.js';
import { __test as gateway } from '../src/index-v21.js';

test('v21 gateway version', () => {
  assert.equal(gateway.version, '21.0.0');
});

test('topic closed errors are recognized for automatic reopen', () => {
  assert.equal(__test.looksLikeClosedTopicError('Bad Request: TOPIC_CLOSED'), true);
  assert.equal(__test.looksLikeClosedTopicError('message thread is closed'), true);
  assert.equal(__test.looksLikeClosedTopicError('other error'), false);
});

test('deleted thread errors are recognized for topic recreation', () => {
  assert.equal(__test.looksLikeMissingTopicError('Bad Request: message thread not found'), true);
  assert.equal(__test.looksLikeMissingTopicError('TOPIC_DELETED'), true);
  assert.equal(__test.looksLikeMissingTopicError('network timeout'), false);
});
