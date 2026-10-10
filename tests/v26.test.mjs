import test from 'node:test';
import assert from 'node:assert/strict';
import gateway,{__test as version} from '../src/index-v26.js';
import {verifyInitData,__test as admin} from '../src/v26-admin-web.js';
import {ADMIN_HTML,ADMIN_CSS,ADMIN_JS} from '../src/v26-admin-ui.js';

const env={TELEGRAM_BOT_TOKEN:'123456:unit-test-token',ADMIN_IDS:'111;222'};
async function signature(data){
 const enc=new TextEncoder();
 const key=await crypto.subtle.importKey('raw',enc.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const secret=await crypto.subtle.sign('HMAC',key,enc.encode(env.TELEGRAM_BOT_TOKEN));
 const s=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const result=await crypto.subtle.sign('HMAC',s,enc.encode(data));
 return Array.from(new Uint8Array(result),v=>v.toString(16).padStart(2,'0')).join('');
}
async function initData(id,date=Math.floor(Date.now()/1000)){
 const s='auth_date='+date+'\nuser='+JSON.stringify({id,first_name:'Test'});
 return new URLSearchParams({auth_date:String(date),user:JSON.stringify({id,first_name:'Test'}),hash:await signature(s)}).toString();
}
test('v26 renders responsive admin assets and valid JavaScript',()=>{
 assert.equal(version.version,'26.0.0');
 assert.match(ADMIN_HTML,/telegram-web-app\.js/);
 assert.match(ADMIN_CSS,/\.sidebar/);
 assert.doesNotThrow(()=>new Function(ADMIN_JS));
});
test('Telegram Mini App HMAC verification, admin allowlist and expiry',async()=>{
 const valid=await initData(111);
 assert.equal((await verifyInitData(valid,env)).id,111);
 assert.equal(await verifyInitData(await initData(999),env),null);
 assert.equal(await verifyInitData(await initData(111,Math.floor(Date.now()/1000)-900),env),null);
 assert.equal(await verifyInitData(valid.replace('Test','Changed'),env),null);
 assert.equal(await verifyInitData(valid+'&auth_date=9999999999',env),null);
});
test('admin API rejects anonymous access and forged Telegram data',async()=>{
 const denied=await gateway.fetch(new Request('https://example.test/admin/api/dashboard'),env,{});
 assert.equal(denied.status,401);
 const spoof=await gateway.fetch(new Request('https://example.test/admin/api/auth',{
  method:'POST',headers:{'content-type':'application/json','origin':'https://example.test'},
  body:JSON.stringify({initData:'user=%7B%22id%22%3A111%7D'})
 }),env,{});
 assert.equal(spoof.status,403);
 const page=await gateway.fetch(new Request('https://example.test/admin'),env,{});
 assert.equal(page.status,200);
 assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await gateway.fetch(new Request('https://example.test/admin/app.js'),env,{})).status,200);
});
test('only explicit fields can be edited',()=>{
 assert.equal(admin.validSetting('support.wait_minutes','15'),true);
 assert.equal(admin.validSetting('support.wait_minutes','-1'),false);
 assert.equal(admin.validSetting('text.home.uz','<b>Salom</b>'),true);
 assert.equal(admin.validSetting('text.home.uz','<script>alert(1)</script>'),false);
 assert.equal(admin.validSetting('link.channel','https://t.me/fibernet_channel'),true);
 assert.equal(admin.validSetting('link.channel','https://fake.example'),false);
 assert.equal(admin.validSetting('asset.home','https://localhost/test.png'),false);
 assert.equal(admin.validSetting('system.admin_id','999'),false);
});
test('server issues secure session cookie to Telegram-verified admin',async()=>{
 const data=await initData(111);
 const res=await gateway.fetch(new Request('https://example.test/admin/api/auth',{
  method:'POST',headers:{'content-type':'application/json','origin':'https://example.test'},
  body:JSON.stringify({initData:data})
 }),env,{});
 assert.equal(res.status,200);
 assert.match(res.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
 const cookie=res.headers.get('set-cookie').split(';')[0];
 const me=await gateway.fetch(new Request('https://example.test/admin/api/me',{
   headers:{cookie}
 }),env,{});
 assert.equal(me.status,200);
 const body=await me.json();
 assert.equal(body.id,111);
 assert.ok(body.csrf.length>=40);
 const tamper=await gateway.fetch(new Request('https://example.test/admin/api/me',{
   headers:{cookie:cookie.replace('fn_admin_s=','fn_admin_s=X')}
 }),env,{});
 assert.equal(tamper.status,401);
});
