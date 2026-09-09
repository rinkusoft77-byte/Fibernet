import test from 'node:test';
import assert from 'node:assert/strict';
import app,{__test} from '../src/index-v8.js';

test('v8 worker imports',()=>{
  assert.equal(typeof app.fetch,'function');
  assert.equal(typeof app.scheduled,'function');
});

test('phone normalization accepts Uzbekistan formats',()=>{
  assert.equal(__test.normalizePhone('+998 90 138 18 04'),'+998901381804');
  assert.equal(__test.normalizePhone('90 138 18 04'),'+998901381804');
  assert.equal(__test.normalizePhone('0901381804'),'+998901381804');
});

test('free text opens guided flow instead of direct ticket',()=>{
  assert.deepEqual(__test.classifyText('wifi ishlamayapti'),{action:'choose_type',department:'tech',category:'wifi'});
  assert.deepEqual(__test.classifyText("to'lov tushmadi"),{action:'issue',department:'accounting',entityType:'none',category:'payment_missing'});
  assert.deepEqual(__test.classifyText('yangi internet kerak'),{action:'issue',department:'connection',entityType:'none',category:'connection'});
  assert.deepEqual(__test.classifyText('menga yordam kerak'),{action:'departments'});
});
