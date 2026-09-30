import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as v10 } from '../src/index-v10.js';
import {
  safeEqual, isValidUpdate, updateActor, secureWebhook
} from '../src/v24-security.js';
import {
  validOfficialLink, validMediaInput, parsePublicHttps
} from '../src/v24-validation.js';
import gateway, { __test as version } from '../src/index-v24.js';

function fakeEnv() {
  const updates = new Map();
  const rates = new Map();
  return {
    TELEGRAM_BOT_TOKEN:'123:unit-test-token',
    ADMIN_IDS:'111',
    updates,
    DB:{
      prepare(sql) {
        const stmt=(args=[])=>({
          async run(){
            if(sql.includes('INSERT INTO fn24_updates')){
              const id=args[0], prev=updates.get(id);
              if(!prev||prev.status==='retry'){
                updates.set(id,{status:'processing',attempts:(prev?.attempts||0)+1});
                return {meta:{changes:1}};
              }
              return {meta:{changes:0}};
            }
            if(sql.includes("UPDATE fn24_updates SET status='done'")){
              const row=updates.get(args[1]);
              if(row) row.status='done';
              return {meta:{changes:row?1:0}};
            }
            if(sql.includes("UPDATE fn24_updates SET status='retry'")){
              const row=updates.get(args[1]);
              if(row) row.status='retry';
              return {meta:{changes:row?1:0}};
            }
            if(sql.includes('INSERT INTO fn24_rate')){
              rates.set(args[0],(rates.get(args[0])||0)+1);
              return {meta:{changes:1}};
            }
            return {meta:{changes:0}};
          },
          async first(){
            if(sql.includes('SELECT status FROM fn24_updates')) return updates.get(args[0])||null;
            if(sql.includes('SELECT hits FROM fn24_rate')) return {hits:rates.get(args[0])||0};
            return {ok:1};
          }
        });
        return {...stmt(), bind:(...args)=>stmt(args)};
      }
    }
  };
}

async function signedRequest(env, update, overrides={}) {
  const secret=await v10.derivedWebhookSecret(env);
  return new Request('https://fibernet.example/telegram/webhook',{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'X-Telegram-Bot-Api-Secret-Token':secret,
      ...overrides
    },
    body:JSON.stringify(update)
  });
}

test('v24 version and constant-time-style string comparison',()=>{
  assert.equal(version.version,'24.0.0');
  assert.equal(safeEqual('abc','abc'),true);
  assert.equal(safeEqual('abc','abd'),false);
  assert.equal(safeEqual('abc','ab'),false);
  assert.equal(safeEqual('', ''),false);
});

test('validate Telegram update identity',()=>{
  assert.equal(isValidUpdate({update_id:123}),true);
  assert.equal(isValidUpdate({update_id:-1}),false);
  assert.equal(isValidUpdate({update_id:'123'}),false);
  assert.equal(isValidUpdate([]),false);
  assert.deepEqual(updateActor({update_id:1,message:{from:{id:22},chat:{id:22,type:'private'}}}),
    {id:'22',chatType:'private'});
});

test('only official links and public image URLs are accepted',()=>{
  assert.equal(validOfficialLink('https://www.fibernet.uz/contacts/'),true);
  assert.equal(validOfficialLink('https://corp.fibernet.uz/uz/'),true);
  assert.equal(validOfficialLink('https://t.me/fibernet_channel'),true);
  assert.equal(validOfficialLink('https://fibernet.uz.evil.example/'),false);
  assert.equal(validOfficialLink('https://t.me/other_channel'),false);
  assert.equal(validOfficialLink('https://127.0.0.1/'),false);
  assert.equal(validOfficialLink('http://fibernet.uz/'),false);
  assert.equal(validOfficialLink('https://admin:pw@fibernet.uz/'),false);
  assert.equal(validMediaInput('AgACAgQAAxkBAAEBfake123456',true),true);
  assert.equal(validMediaInput('https://cdn.example.com/picture.jpg'),true);
  assert.equal(parsePublicHttps('https://localhost/picture.jpg'),null);
  assert.equal(parsePublicHttps('https://[::1]/picture.jpg'),null);
});

test('invalid webhook secret is rejected without reaching legacy handler',async()=>{
  const env=fakeEnv();
  let called=0;
  const req=await signedRequest(env,{update_id:1},{'X-Telegram-Bot-Api-Secret-Token':'wrong'});
  const res=await secureWebhook(req,env,{},async()=>{called++;return new Response('ok');});
  assert.equal(res.status,403);
  assert.equal(called,0);
});

test('same update is processed once at ingress',async()=>{
  const env=fakeEnv();let called=0;
  const handler=async(req)=>{called++;assert.equal((await req.json()).update_id,11);return new Response('ok');};
  const a=await secureWebhook(await signedRequest(env,{update_id:11}),env,{},handler);
  const b=await secureWebhook(await signedRequest(env,{update_id:11}),env,{},handler);
  assert.equal(a.status,200);assert.equal(b.status,200);
  assert.equal(called,1);
  assert.equal(env.updates.get(11)?.status,'done');
});

test('failed delivery remains retryable rather than marked complete',async()=>{
  const env=fakeEnv();let calls=0;
  const handler=async()=>new Response('retry',{status:++calls===1?503:200});
  const a=await secureWebhook(await signedRequest(env,{update_id:12}),env,{},handler);
  const b=await secureWebhook(await signedRequest(env,{update_id:12}),env,{},handler);
  assert.equal(a.status,503);assert.equal(b.status,200);
  assert.equal(calls,2);
  assert.equal(env.updates.get(12)?.status,'done');
});

test('public health contains no customer or admin metrics',async()=>{
  const env=fakeEnv();
  const result=await gateway.fetch(new Request('https://example/health'),env,{});
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{ok:true,service:'fibernet-bot',version:'24.0.0'});
  const detail=await gateway.fetch(new Request('https://example/health?details=1'),env,{});
  assert.equal(detail.status,403);
  const other=await gateway.fetch(new Request('https://example/private'),env,{});
  assert.equal(other.status,404);
});
