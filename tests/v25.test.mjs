import test from 'node:test';
import assert from 'node:assert/strict';
import gateway, { __test as version } from '../src/index-v25.js';
import { __test as sec, isSecurityAdmin } from '../src/v25-security-center.js';

test('v25 gateway version',()=>{
  assert.equal(version.version,'25.0.0');
  assert.equal(sec.version,'25.0.0');
});

test('security admin is allowlisted only by ADMIN_IDS',()=>{
  const env={ADMIN_IDS:'111,222;333'};
  assert.equal(isSecurityAdmin(env,111),true);
  assert.equal(isSecurityAdmin(env,'222'),true);
  assert.equal(isSecurityAdmin(env,333),true);
  assert.equal(isSecurityAdmin(env,444),false);
});

test('actor extraction ignores bot actors',()=>{
  assert.deepEqual(
    sec.actorOf({message:{from:{id:10},chat:{id:10,type:'private'}}}),
    {id:10,chatId:10,chatType:'private'}
  );
  assert.equal(sec.actorOf({message:{from:{id:10,is_bot:true},chat:{id:10,type:'private'}}}),null);
});

test('public v25 health stays minimal',async()=>{
  const env={DB:{prepare(){return {async first(){return {ok:1}}}}}};
  const r=await gateway.fetch(new Request('https://example/health'),env,{});
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{ok:true,service:'fibernet-bot',version:'25.0.0'});
});
