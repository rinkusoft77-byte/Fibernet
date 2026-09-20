import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/v19-group-guard.js';
import { __test as gateway } from '../src/index-v19.js';

test('v19 gateway version', () => {
  assert.equal(gateway.version, '19.0.0');
});

test('group command parser ignores normal conversation', () => {
  assert.equal(__test.commandName('salom operatorlar'), null);
  assert.equal(__test.commandName('/panel'), 'panel');
  assert.equal(__test.commandName('/panel@FiberNetBot'), 'panel');
  assert.equal(__test.commandName('/find 29374'), 'find');
});

test('ticket callback extraction is strict', () => {
  assert.equal(
    __test.extractTicketNo('v17:priority:FN-260920-ABC123:high'),
    'FN-260920-ABC123'
  );
  assert.equal(__test.extractTicketNo('random callback'), null);
});

test('only known operator commands are allowed to legacy routers', () => {
  assert.equal(__test.isKnownOperatorCommand('panel'), true);
  assert.equal(__test.isKnownOperatorCommand('setup'), true);
  assert.equal(__test.isKnownOperatorCommand('operatorhelp'), true);
  assert.equal(__test.isKnownOperatorCommand('start'), false);
  assert.equal(__test.isKnownOperatorCommand('random'), false);
});
