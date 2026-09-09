import test from 'node:test';
import assert from 'node:assert/strict';
import app,{__test} from '../src/index-v7.js';

test('v7 worker imports',()=>{
  assert.equal(typeof app.fetch,'function');
  assert.equal(typeof app.scheduled,'function');
});

test('v7 routes client issues to departments',()=>{
  assert.deepEqual(__test.classifyText('wifi ishlamayapti'),{action:'ticket',department:'tech',category:'wifi'});
  assert.deepEqual(__test.classifyText("to'lov tushmadi"),{action:'ticket',department:'accounting',category:'payment_missing'});
  assert.deepEqual(__test.classifyText('yangi internet kerak'),{action:'ticket',department:'connection',category:'connection'});
  assert.deepEqual(__test.classifyText('menga yordam kerak'),{action:'ticket',department:'general',category:'other'});
});

test('v7 department bindings accept supported departments only',()=>{
  for(const d of ['general','tech','accounting','subscriber','connection']) assert.equal(__test.validDepartment(d),true);
  assert.equal(__test.validDepartment('random'),false);
  assert.equal(__test.ENV_CHAT_KEYS.tech,'TECH_CHAT_ID');
  assert.equal(__test.ENV_CHAT_KEYS.accounting,'ACCOUNTING_CHAT_ID');
});
