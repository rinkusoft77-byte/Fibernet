import {safeEqual} from './v24-security.js';
import {validOfficialLink,validMediaInput} from './v24-validation.js';
import {auditAdmin,listSettings,resetSetting,restorePreviousSetting,setSetting,recentAudit} from './v23-store.js';
import {approvePanelOperator,revokePanelOperator} from './v19-group-guard.js';
import {blockUser,unblockUser} from './v25-security-center.js';
import {closeTicket,getTicket,setStage} from './v5-db.js';
import {sendMessage,tg} from './telegram.js';
import {ADMIN_HTML,ADMIN_CSS,ADMIN_JS} from './v26-admin-ui.js';

const COOKIE='fn_admin_s',LIFE=7200;
const MEDIA=new Set('home support tariffs payment connect tv services contacts promo_uz promo_ru about guides news'.split(' '));
const TEXTS=new Set('home support tariffs payment connect tv services contacts promo about guides news maintenance'.split(' '));
const LINKS=new Set('siteUz siteRu channel cabinet techTelegram subscriberTelegram contactsUz contactsRu tariffsUz tariffsRu connectUz connectRu paymentUz paymentRu settingsUz settingsRu servicesUz servicesRu speedUz speedRu newsUz newsRu'.split(' '));
const DEFAULT_ART={
  home:'🏠 Bosh sahifa',support:'🛠 Yordam',tariffs:'📶 Tariflar',payment:'💳 To‘lov',
  connect:'🔌 Ulanish',tv:'📺 TV',services:'🧰 Xizmatlar',contacts:'☎️ Kontaktlar',
  promo_uz:'🎁 Promo UZ',promo_ru:'🎁 Promo RU',about:'ℹ️ FiberNet',
  guides:'📚 Qo‘llanma',news:'📰 Yangiliklar'
};
const H={'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY'};
function json(data,status=200,extra={}){return new Response(JSON.stringify(data),{status,headers:{...H,...extra}});}
function fail(message,status=400){return json({error:message},status);}
function assetHeaders(type){return {
  'content-type':type,'cache-control':'no-store','x-frame-options':'DENY','x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' blob: data: https://fibernet.uz https://*.fibernet.uz; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};}
const isAdmin=(env,id)=>String(env.ADMIN_IDS||'').split(/[\s,;]+/).includes(String(id));
const enc=new TextEncoder(),dec=new TextDecoder();
function b64(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function from64(x){if(!/^[A-Za-z0-9_-]{2,2048}$/.test(x))throw Error('token');
 return Uint8Array.from(atob(x.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(x.length/4)*4,'=')),v=>v.charCodeAt(0));}
async function hmac(key,data){return new Uint8Array(await crypto.subtle.sign('HMAC',key,typeof data==='string'?enc.encode(data):data));}
async function importKey(value){return crypto.subtle.importKey('raw',enc.encode(value),{name:'HMAC',hash:'SHA-256'},false,['sign']);}
async function sessionKey(env){if(!env.TELEGRAM_BOT_TOKEN)throw Error('token');
 return importKey('fibernet-admin-web/v26:'+env.TELEGRAM_BOT_TOKEN);}
export async function verifyInitData(raw,env,clock=Math.floor(Date.now()/1000)){
 if(typeof raw!=='string'||raw.length>8192||!env.TELEGRAM_BOT_TOKEN)return null;
 const m=Object.create(null);
 for(const [k,v] of new URLSearchParams(raw)){
   if(Object.hasOwn(m,k)||!/^[a-z_]+$/.test(k)||v.length>3000)return null;m[k]=v;
 }
 if(!/^[a-f0-9]{64}$/i.test(m.hash||'')||!/^\d{10}$/.test(m.auth_date||''))return null;
 const age=clock-Number(m.auth_date);
 if(age>600||age< -60)return null;
 const check=Object.keys(m).filter(k=>k!=='hash').sort().map(k=>k+'='+m[k]).join('\n');
 const secret=await hmac(await importKey('WebAppData'),env.TELEGRAM_BOT_TOKEN);
 const actual=await hmac(await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']),check);
 const hex=Array.from(actual,b=>b.toString(16).padStart(2,'0')).join('');
 if(!safeEqual(hex,m.hash.toLowerCase()))return null;
 let user;try{user=JSON.parse(m.user);}catch{return null;}
 if(!Number.isSafeInteger(user?.id)||user.id<=0||!isAdmin(env,user.id))return null;
 return {id:user.id,name:String(user.first_name||'Administrator').slice(0,70)};
}
async function signSession(env,id){
 const raw=b64(enc.encode(JSON.stringify({id,exp:Math.floor(Date.now()/1000)+LIFE,nonce:crypto.randomUUID()})));
 return raw+'.'+b64(await hmac(await sessionKey(env),raw));
}
async function getSession(env,request){
 const cookie=String(request.headers.get('cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='));
 if(!cookie)return null;
 const token=cookie.slice(COOKIE.length+1),p=token.split('.');
 if(p.length!==2||p[0].length>1024||p[1].length>128)return null;
 try{
   if(!safeEqual(p[1],b64(await hmac(await sessionKey(env),p[0]))))return null;
   const d=JSON.parse(dec.decode(from64(p[0])));
   if(!Number.isSafeInteger(d.id)||!Number.isSafeInteger(d.exp)||d.exp<=Date.now()/1000||
      d.exp>Date.now()/1000+LIFE+60||!isAdmin(env,d.id))return null;
   return {id:d.id,csrf:b64(await hmac(await sessionKey(env),'csrf:'+token))};
 }catch{return null;}
}
function sameOrigin(req,url){return req.headers.get('origin')===url.origin&&req.headers.get('sec-fetch-site')!=='cross-site';}
async function body(req,max=12000){
 const len=Number(req.headers.get('content-length')||0);if(len>max)return null;
 const raw=await req.text();if(raw.length>max)return null;
 try{const d=JSON.parse(raw);return d&&!Array.isArray(d)&&typeof d==='object'?d:null;}catch{return null;}
}
const many=async(env,sql,args=[])=>((await env.DB.prepare(sql).bind(...args).all()).results||[]);
const one=(env,sql,args=[])=>env.DB.prepare(sql).bind(...args).first();
function validSetting(key,value){
 if(typeof key!=='string'||typeof value!=='string')return false;
 if(key.startsWith('asset.'))return MEDIA.has(key.slice(6))&&(validMediaInput(value,true)||validMediaInput(value,false));
 if(key.startsWith('link.'))return LINKS.has(key.slice(5))&&validOfficialLink(value);
 if(key.startsWith('text.')){
  const parts=key.split('.');
  if(parts.length!==3||!TEXTS.has(parts[1])||!['uz','ru'].includes(parts[2])||!value.trim()||value.length>1000)return false;
  return !/<[^>]*>/.test(value.replace(/<\/?(?:b|i|u|s|code)>/gi,''));
 }
 return key==='support.wait_minutes'&&/^\d{1,3}$/.test(value)&&+value>=5&&+value<=120;
}
const kind=key=>key.startsWith('asset.')?'image':key.startsWith('link.')?'url':key==='support.wait_minutes'?'number':'html';
async function log(env,id,action,target){await auditAdmin(env,id,'web_'+action,target);}
async function overview(env){
 const [users,tickets,profiles,operators,live]=await Promise.all([
  one(env,'SELECT COUNT(*) n FROM fn5_users'),
  one(env,"SELECT COUNT(*) total,SUM(status='open') open,SUM(status='closed') closed,SUM(status='open' AND assigned_to IS NULL) unassigned FROM fn5_tickets"),
  one(env,"SELECT COUNT(*) total,SUM(status='pending') pending,SUM(status='approved') approved FROM fn18_profiles"),
  one(env,"SELECT COUNT(*) total,SUM(status='approved') approved FROM fn19_operator_acl"),
  one(env,"SELECT SUM(state='waiting_operator') waiting,SUM(state IN ('active','engaged')) active FROM fn21_conversations")
 ]);
 return {users:users?.n||0,tickets:tickets||{},profiles:profiles||{},operators:operators||{},live:live||{}};
}
async function listTickets(env,params){
 const q=String(params.get('q')||'').trim().slice(0,70),status=params.get('status')==='closed'?'closed':'open';
 return many(env,`SELECT t.ticket_no,t.telegram_id,t.department,t.category,t.status,
 t.stage,t.priority,t.assigned_name,t.account_login,t.created_at,t.updated_at,p.given_name,p.family_name
 FROM fn5_tickets t LEFT JOIN fn18_profiles p ON p.telegram_id=t.telegram_id
 WHERE t.status=? AND (?='' OR t.ticket_no LIKE ? OR t.account_login LIKE ?)
 ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,t.id DESC LIMIT 60`,
 [status,q,'%'+q+'%','%'+q+'%']);
}
async function review(env,id,admin,action){
 const p=await one(env,'SELECT * FROM fn18_profiles WHERE telegram_id=?',[id]);
 if(!p||p.status!=='pending'||(action==='approve'&&(!p.given_name||!p.family_name)))return false;
 const date=new Date().toISOString(),status=action==='approve'?'approved':'rejected';
 const changed=await env.DB.prepare(`UPDATE fn18_profiles SET status=?,reviewed_by=?,reviewed_by_name='Web Admin',
 reviewed_at=?,updated_at=? WHERE telegram_id=? AND status='pending' AND submitted_at=?`)
  .bind(status,admin,date,date,id,p.submitted_at).run();
 if(!changed.meta?.changes)return false;
 await env.DB.prepare('UPDATE fn5_users SET account_login=?,address=?,updated_at=? WHERE telegram_id=?')
  .bind(action==='approve'?p.login||null:null,action==='approve'?p.address||null:null,date,id).run();
 await log(env,admin,'profile_'+action,String(id));
 try{await sendMessage(env,id,action==='approve'
  ?'✅ <b>FiberNet profilingiz tasdiqlandi.</b>':'❌ <b>Profil tasdiqlanmadi.</b> Ma’lumotlaringizni qayta yuboring.');}catch{}
 return true;
}
async function ticketAction(env,no,action,priority,admin){
 const t=await getTicket(env,no);if(!t||t.status!=='open')return false;
 if(action==='priority'){
  if(!['low','normal','high','critical'].includes(priority))return false;
  const r=await env.DB.prepare("UPDATE fn5_tickets SET priority=?,updated_at=CURRENT_TIMESTAMP WHERE ticket_no=? AND status='open'")
   .bind(priority,no).run();if(!r.meta?.changes)return false;
 }else if(action==='resolve')await setStage(env,no,'resolved');
 else if(action==='close'){
  if(!await closeTicket(env,no))return false;
  const topic=await one(env,'SELECT chat_id,thread_id FROM fn15_topics WHERE ticket_no=?',[no]);
  if(topic?.thread_id){try{await tg(env,'closeForumTopic',{chat_id:topic.chat_id,message_thread_id:topic.thread_id});}catch{}}
 }else return false;
 await log(env,admin,'ticket_'+action,no);
 if(action!=='priority'){try{await sendMessage(env,t.telegram_id,
   action==='resolve'?'✅ <b>Murojaatingiz hal qilindi.</b>':'✅ <b>Murojaatingiz yopildi.</b>');}catch{}}
 return true;
}
async function upload(env,req,admin){
 if(Number(req.headers.get('content-length')||0)>7*1024*1024)return fail('Rasm juda katta',413);
 const form=await req.formData(),key=String(form.get('key')||''),file=form.get('image');
 if(!MEDIA.has(key)||!file||typeof file.arrayBuffer!=='function')return fail('Fayl yaroqsiz');
 if(file.size<100||file.size>6*1024*1024||!['image/jpeg','image/png'].includes(file.type))return fail('JPG/PNG, 6 MB gacha',413);
 const bin=new Uint8Array(await file.arrayBuffer());
 const jpg=bin[0]===255&&bin[1]===216&&bin[2]===255;
 const png=bin[0]===137&&bin[1]===80&&bin[2]===78&&bin[3]===71&&bin[4]===13&&bin[5]===10;
 if(!jpg&&!png)return fail('Noto‘g‘ri rasm formati');
 const f=new FormData();f.set('chat_id',String(admin));f.set('caption','🖼 FiberNet admin: '+key);
 f.set('photo',new Blob([bin],{type:jpg?'image/jpeg':'image/png'}),jpg?'image.jpg':'image.png');
 const res=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendPhoto',{method:'POST',body:f});
 const data=await res.json(),ph=data?.result?.photo,photo=ph?.[ph.length-1]?.file_id;
 if(!res.ok||!photo)return fail('Telegram rasmni yuklay olmadi',502);
 await setSetting(env,'asset.'+key,photo,'image',admin);
 await env.DB.prepare('DELETE FROM fn22_media_cache WHERE asset_key=?').bind(key).run();
 await log(env,admin,'image_uploaded',key);
 return json({ok:true});
}
export async function handleAdminWeb(req,env){
 const url=new URL(req.url),path=url.pathname;
 if(path==='/admin'||path==='/admin/'){
  if(req.method!=='GET')return fail('Method not allowed',405);
  return new Response(ADMIN_HTML,{headers:assetHeaders('text/html; charset=utf-8')});
 }
 if(path==='/admin/app.css'&&req.method==='GET')
  return new Response(ADMIN_CSS,{headers:assetHeaders('text/css; charset=utf-8')});
 if(path==='/admin/app.js'&&req.method==='GET')
  return new Response(ADMIN_JS,{headers:assetHeaders('text/javascript; charset=utf-8')});
 if(!path.startsWith('/admin/api/'))return fail('Not found',404);
 if(path==='/admin/api/auth'){
  if(req.method!=='POST'||!sameOrigin(req,url))return fail('Forbidden',403);
  const input=await body(req);
  const admin=await verifyInitData(input?.initData,env);
  if(!admin)return fail('Telegram admin access denied',403);
  const token=await signSession(env,admin.id);
  return json({ok:true},200,{'set-cookie':COOKIE+'='+token+'; Path=/admin; Max-Age='+LIFE+'; HttpOnly; Secure; SameSite=Strict'});
 }
 const session=await getSession(env,req);
 if(!session)return fail('Not authorized',401);
 if(req.method!=='GET'&&(!sameOrigin(req,url)||!safeEqual(req.headers.get('x-admin-csrf')||'',session.csrf)))
  return fail('CSRF denied',403);
 if(path==='/admin/api/me'&&req.method==='GET')return json({id:session.id,csrf:session.csrf});
 if(path==='/admin/api/dashboard'&&req.method==='GET')return json(await overview(env));
 if(path==='/admin/api/tickets'&&req.method==='GET')return json({items:await listTickets(env,url.searchParams)});
 if(path==='/admin/api/profiles'&&req.method==='GET'){
  const s=['pending','approved','rejected','skipped'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'pending';
  return json({items:await many(env,'SELECT telegram_id,given_name,family_name,login,address,status,submitted_at FROM fn18_profiles WHERE status=? ORDER BY COALESCE(submitted_at,updated_at) DESC LIMIT 60',[s])});
 }
 if(path==='/admin/api/operators'&&req.method==='GET')
  return json({items:await many(env,"SELECT chat_id,user_id,display_name,username,status,updated_at FROM fn19_operator_acl ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,updated_at DESC LIMIT 60")});
 if(path==='/admin/api/settings'&&req.method==='GET')
  return json({items:await many(env,'SELECT setting_key,setting_value,updated_at FROM fn23_settings ORDER BY setting_key'),assets:DEFAULT_ART,textSections:[...TEXTS],links:[...LINKS]});
 if(path==='/admin/api/audit'&&req.method==='GET')return json({items:await recentAudit(env,50)});
 if(path==='/admin/api/security'&&req.method==='GET'){
  const [blocks,events]=await Promise.all([
   many(env,"SELECT telegram_id,reason,expires_at FROM fn25_blocks WHERE active=1 AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) ORDER BY blocked_at DESC LIMIT 50"),
   many(env,'SELECT severity,event_type,telegram_id,created_at FROM fn25_events ORDER BY id DESC LIMIT 30')
  ]);
  return json({blocks,events});
 }
 const tmatch=path.match(/^\/admin\/api\/tickets\/(FN-\d{6}-[A-Z0-9]{6})$/);
 if(tmatch&&req.method==='GET'){
  const ticket=await getTicket(env,tmatch[1]);if(!ticket)return fail('Not found',404);
  const messages=await many(env,'SELECT sender_type,body,created_at FROM fn5_messages WHERE ticket_no=? ORDER BY id DESC LIMIT 12',[tmatch[1]]);
  const topic=await one(env,'SELECT chat_id,thread_id FROM fn15_topics WHERE ticket_no=?',[tmatch[1]]);
  return json({ticket,messages:messages.reverse(),topic});
 }
 if(path==='/admin/api/upload'&&req.method==='POST')return upload(env,req,session.id);
 if(req.method!=='POST'||!String(req.headers.get('content-type')||'').startsWith('application/json'))
  return fail('Method not allowed',405);
 const d=await body(req);if(!d)return fail('Noto‘g‘ri JSON');
 if(path==='/admin/api/settings'){
  const key=String(d.key||''),action=String(d.action||'save');
  if(action==='save'){
   if(!validSetting(key,d.value))return fail('Qiymat yoki havola yaroqsiz');
   await setSetting(env,key,d.value,kind(key),session.id);
  }else{
   const valid=key==='support.wait_minutes'||(key.startsWith('asset.')&&MEDIA.has(key.slice(6)))||
    (key.startsWith('link.')&&LINKS.has(key.slice(5)))||
    (key.startsWith('text.')&&key.split('.').length===3&&TEXTS.has(key.split('.')[1])&&['uz','ru'].includes(key.split('.')[2]));
   if(!valid)return fail('Ruxsat yo‘q',403);
   if(action==='reset')await resetSetting(env,key,session.id);
   else if(action==='undo')await restorePreviousSetting(env,key,session.id);
   else return fail('Unknown action');
  }
  if(key.startsWith('asset.'))await env.DB.prepare('DELETE FROM fn22_media_cache WHERE asset_key=?').bind(key.slice(6)).run();
  await log(env,session.id,'setting_'+action,key);return json({ok:true});
 }
 if(path==='/admin/api/profiles/review'){
  if(!/^\d{5,20}$/.test(String(d.id))||!['approve','reject'].includes(d.action))return fail('Invalid profile');
  return await review(env,Number(d.id),session.id,d.action)?json({ok:true}):fail('Profil avval ko‘rilgan',409);
 }
 if(path==='/admin/api/tickets/action'){
  if(!/^FN-\d{6}-[A-Z0-9]{6}$/.test(String(d.no||''))||!['priority','resolve','close'].includes(d.action))return fail('Invalid ticket');
  return await ticketAction(env,d.no,d.action,d.priority,session.id)?json({ok:true}):fail('Ticket holati o‘zgargan',409);
 }
 if(path==='/admin/api/operators/action'){
  if(!/^-?\d{8,20}$/.test(String(d.chat))||!/^\d{5,20}$/.test(String(d.user))||
   !['approve','revoke'].includes(d.action)||isAdmin(env,d.user))return fail('Operator invalid');
  if(!await one(env,'SELECT status FROM fn19_operator_acl WHERE chat_id=? AND user_id=?',[d.chat,d.user]))return fail('Operator topilmadi',404);
  if(d.action==='approve')await approvePanelOperator(env,d.chat,d.user,session.id);
  else await revokePanelOperator(env,d.chat,d.user,session.id);
  await log(env,session.id,'operator_'+d.action,String(d.user));return json({ok:true});
 }
 if(path==='/admin/api/security/block'){
  if(!/^\d{5,20}$/.test(String(d.id))||isAdmin(env,d.id))return fail('User ID yaroqsiz');
  if(d.action==='unblock')await unblockUser(env,d.id,session.id);
  else if(['1h','24h','7d','30d','permanent'].includes(d.ttl))await blockUser(env,d.id,session.id,d.ttl,'web_admin');
  else return fail('Duration invalid');
  await log(env,session.id,'security_block',String(d.id));return json({ok:true});
 }
 return fail('Not found',404);
}
export const __test={validSetting,isAdmin};
