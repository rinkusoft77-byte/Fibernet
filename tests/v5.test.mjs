import test from 'node:test';
import assert from 'node:assert/strict';
import app,{__test} from '../src/index-v5.js';

test('v5 worker imports',()=>{ assert.equal(typeof app.fetch,'function'); assert.equal(typeof app.scheduled,'function'); });
test('phone normalization',()=>{
  assert.equal(__test.normalizePhone('+998 90 138 18 04'),'+998901381804');
  assert.equal(__test.normalizePhone('90 138 18 04'),'+998901381804');
  assert.equal(__test.normalizePhone('0901381804'),'+998901381804');
});
test('free text routes to correct department',()=>{
  assert.deepEqual(__test.classifyText('wifi ishlamayapti'),{action:'ticket',department:'tech',category:'wifi'});
  assert.deepEqual(__test.classifyText("to'lov tushmadi"),{action:'ticket',department:'accounting',category:'payment_missing'});
  assert.deepEqual(__test.classifyText('yangi internet kerak'),{action:'ticket',department:'connection',category:'connection'});
  assert.equal(__test.classifyText('tariflar').action,'tariffs');
});
