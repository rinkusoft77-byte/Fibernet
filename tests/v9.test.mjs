import test from 'node:test';
import assert from 'node:assert/strict';
import app,{detectDepartment} from '../src/index-v9.js';

test('v9 worker imports',()=>{
  assert.equal(typeof app.fetch,'function');
  assert.equal(typeof app.scheduled,'function');
});

test('operator group title detection',()=>{
  assert.equal(detectDepartment('FiberNet Texnik yordam'),'tech');
  assert.equal(detectDepartment('FiberNet Бухгалтерия'),'accounting');
  assert.equal(detectDepartment('Abonent bo‘limi'),'subscriber');
  assert.equal(detectDepartment('Новое подключение'),'connection');
  assert.equal(detectDepartment('FiberNet Operators'),null);
});
