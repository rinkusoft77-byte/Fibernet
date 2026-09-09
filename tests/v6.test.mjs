import test from 'node:test';
import assert from 'node:assert/strict';
import app,{__test} from '../src/index-v6.js';

test('v6 worker imports',()=>{assert.equal(typeof app.fetch,'function');assert.equal(typeof app.scheduled,'function')});

test('phone normalization accepts Uzbekistan contact formats',()=>{
  assert.equal(__test.normalizePhone('+998 90 138 18 04'),'+998901381804');
  assert.equal(__test.normalizePhone('90 138 18 04'),'+998901381804');
  assert.equal(__test.normalizePhone('0901381804'),'+998901381804');
});

test('smart routing sends common issues to correct departments',()=>{
  assert.deepEqual(__test.classifyText('wifi ishlamayapti'),{action:'ticket',department:'tech',category:'wifi'});
  assert.deepEqual(__test.classifyText("to'lov tushmadi"),{action:'ticket',department:'accounting',category:'payment_missing'});
  assert.deepEqual(__test.classifyText('yangi internet kerak'),{action:'ticket',department:'connection',category:'connection'});
  assert.equal(__test.classifyText('tariflar').action,'tariffs');
  assert.equal(__test.classifyText('hophop haqida').action,'tv');
  assert.deepEqual(__test.classifyText('menga yordam kerak'),{action:'ticket',department:'general',category:'other'});
});
