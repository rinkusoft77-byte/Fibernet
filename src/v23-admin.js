import { closeTicket, getTicket, setStage } from './v5-db.js';
import { syncOfficialSources } from './catalog.js';
import {
  showPremiumAbout, showPremiumConnect, showPremiumContacts, showPremiumGuides,
  showPremiumHome, showPremiumNews, showPremiumPayment, showPremiumPromo,
  showPremiumServices, showPremiumSupport, showPremiumTariffs, showPremiumTV
} from './v22-content.js';
import {
  auditAdmin, cleanupV23Store, clearAdminSession, ensureV23Store, getAdminSession,
  getBooleanSetting, getNumberSetting, getSetting, listSettings, recentAudit,
  resetSetting, restorePreviousSetting, setAdminSession, setSetting
} from './v23-store.js';
import { answerCallback, escapeHtml, inlineKeyboard, sendMessage, tg } from './telegram.js';
import { validOfficialLink, validMediaInput } from './v24-validation.js';
import { approvePanelOperator, revokePanelOperator } from './v19-group-guard.js';

const VERSION = '23.0.0';

const MEDIA_SECTIONS = [
  ['home','🏠 Home'], ['support','🛠 Yordam'], ['tariffs','📶 Tariflar'],
  ['payment','💳 To‘lov'], ['connect','🔌 Ulanish'], ['tv','📺 TV'],
  ['services','🧰 Xizmatlar'], ['contacts','☎️ Kontaktlar'],
  ['promo_uz','🎁 Promo UZ'], ['promo_ru','🎁 Promo RU'],
  ['about','ℹ️ FiberNet'], ['guides','📚 Qo‘llanmalar'], ['news','📰 Yangiliklar']
];

const TEXT_SECTIONS = [
  ['home','🏠 Home'], ['support','🛠 Yordam'], ['tariffs','📶 Tariflar'],
  ['payment','💳 To‘lov'], ['connect','🔌 Ulanish'], ['tv','📺 TV'],
  ['services','🧰 Xizmatlar'], ['contacts','☎️ Kontaktlar'],
  ['promo','🎁 Aksiyalar'], ['about','ℹ️ FiberNet'],
  ['guides','📚 Qo‘llanmalar'], ['news','📰 Yangiliklar'],
  ['maintenance','🚧 Maintenance']
];

const LINK_GROUPS = {
  core: [
    ['siteUz','🌐 Sayt UZ'], ['siteRu','🌐 Сайт RU'],
    ['channel','📣 Telegram kanal'], ['cabinet','👤 Kabinet']
  ],
  contact: [
    ['techTelegram','🛠 Tech Telegram'], ['subscriberTelegram','👥 Abonent Telegram'],
    ['contactsUz','☎️ Kontakt UZ'], ['contactsRu','☎️ Контакт RU']
  ],
  service: [
    ['tariffsUz','📶 Tarif UZ'], ['tariffsRu','📶 Тариф RU'],
    ['connectUz','🔌 Ulanish UZ'], ['connectRu','🔌 Подключение RU'],
    ['paymentUz','💳 To‘lov UZ'], ['paymentRu','💳 Оплата RU']
  ],
  tools: [
    ['settingsUz','⚙️ Sozlama UZ'], ['settingsRu','⚙️ Настройки RU'],
    ['servicesUz','🧰 Xizmat UZ'], ['servicesRu','🧰 Услуги RU'],
    ['speedUz','📈 Speed UZ'], ['speedRu','📈 Speed RU'],
    ['newsUz','📰 News UZ'], ['newsRu','📰 News RU']
  ]
};

function adminIds(env) {
  return new Set(String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String));
}
export function isBotAdmin(env, id) { return adminIds(env).has(String(id)); }
function isPrivate(chat) { return chat?.type === 'private'; }

async function safeFirst(env, sql, binds = []) {
  try { return await env.DB.prepare(sql).bind(...binds).first(); } catch { return null; }
}
async function safeAll(env, sql, binds = []) {
  try { const r = await env.DB.prepare(sql).bind(...binds).all(); return r.results || []; }
  catch { return []; }
}

function panelKeyboard() {
  return inlineKeyboard([
    [{ text:'📊 Dashboard', callback_data:'v23:dashboard' }, { text:'🎫 Ticketlar', callback_data:'v23:tickets' }],
    [{ text:'👤 Profillar', callback_data:'v23:profiles' }, { text:'👨‍💻 Operatorlar', callback_data:'v23:operators' }],
    [{ text:'🖼 Rasmlar', callback_data:'v23:media' }, { text:'✍️ Matnlar', callback_data:'v23:texts' }],
    [{ text:'🔗 Havolalar', callback_data:'v23:links' }, { text:'⏱ Support', callback_data:'v23:support' }],
    [{ text:'📢 Broadcast', callback_data:'v23:broadcast' }, { text:'👁 Preview', callback_data:'v23:preview' }],
    [{ text:'🧰 Sistema', callback_data:'v23:system' }, { text:'🛡 Xavfsizlik', callback_data:'v25:security' }],
    [{ text:'📜 Audit', callback_data:'v23:audit' }, { text:'⚙️ Override ro‘yxati', callback_data:'v23:settings' }]
  ]);
}

async function showPanel(env, chatId) {
  await ensureV23Store(env);
  const maintenance = await getBooleanSetting(env,'system.maintenance',false);
  const pending = await safeFirst(env, "SELECT COUNT(*) n FROM fn18_profiles WHERE status='pending'");
  const open = await safeFirst(env, "SELECT COUNT(*) n FROM fn5_tickets WHERE status='open'");
  return sendMessage(env, chatId, [
    '🛡 <b>FiberNet Admin Panel</b>',
    `<code>v${VERSION}</code>`,
    '',
    `🎫 Ochiq ticketlar: <b>${open?.n || 0}</b>`,
    `👤 Profil tasdig‘i: <b>${pending?.n || 0}</b>`,
    `🚧 Maintenance: <b>${maintenance ? 'ON' : 'OFF'}</b>`,
    '',
    'Bu panel faqat <b>ADMIN_IDS</b> dagi bot administratorlari uchun.',
    'Kontent o‘zgarishlari D1 da saqlanadi va kod deploy qilmasdan ishlaydi.'
  ].join('\n'), { reply_markup:panelKeyboard() });
}

async function showDashboard(env, chatId) {
  const [users,tickets,profiles,conversations,operators,outbox,bq,changes] = await Promise.all([
    safeFirst(env, `SELECT COUNT(*) total,
      SUM(CASE WHEN datetime(updated_at)>=datetime('now','-1 day') THEN 1 ELSE 0 END) active24,
      SUM(CASE WHEN datetime(updated_at)>=datetime('now','-7 day') THEN 1 ELSE 0 END) active7
      FROM fn5_users`),
    safeFirst(env, `SELECT COUNT(*) total,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) closed,
      SUM(CASE WHEN status='open' AND assigned_to IS NULL THEN 1 ELSE 0 END) unassigned,
      SUM(CASE WHEN status='open' AND priority IN ('critical','high') THEN 1 ELSE 0 END) urgent
      FROM fn5_tickets`),
    safeFirst(env, `SELECT COUNT(*) total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved
      FROM fn18_profiles`),
    safeFirst(env, `SELECT
      SUM(CASE WHEN state='waiting_operator' THEN 1 ELSE 0 END) waiting,
      SUM(CASE WHEN state IN ('active','engaged') THEN 1 ELSE 0 END) live
      FROM fn21_conversations`),
    safeFirst(env, `SELECT
      SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending
      FROM fn19_operator_acl`),
    safeFirst(env, 'SELECT COUNT(*) n FROM fn21_outbox'),
    safeFirst(env, "SELECT COUNT(*) n FROM fn23_broadcast_queue WHERE status='pending'"),
    safeFirst(env, "SELECT COUNT(*) n FROM fn23_setting_history WHERE datetime(created_at)>=datetime('now','-1 day')")
  ]);
  return sendMessage(env, chatId, [
    '📊 <b>FiberNet Dashboard</b>', '',
    `👥 Users: <b>${users?.total || 0}</b> · 24h: <b>${users?.active24 || 0}</b> · 7d: <b>${users?.active7 || 0}</b>`,
    `🎫 Tickets: <b>${tickets?.open || 0}</b> open · ${tickets?.unassigned || 0} unassigned · ${tickets?.urgent || 0} urgent`,
    `✅ Closed: <b>${tickets?.closed || 0}</b> · total ${tickets?.total || 0}`,
    `💬 Live support: <b>${conversations?.live || 0}</b> · operator kutmoqda ${conversations?.waiting || 0}`,
    `👤 Profiles: <b>${profiles?.approved || 0}</b> approved · ${profiles?.pending || 0} pending`,
    `👨‍💻 Operators: <b>${operators?.approved || 0}</b> approved · ${operators?.pending || 0} pending`,
    `📨 Support outbox: <b>${outbox?.n || 0}</b>`,
    `📢 Broadcast queue: <b>${bq?.n || 0}</b>`,
    `⚙️ Config changes 24h: <b>${changes?.n || 0}</b>`
  ].join('\n'), {
    reply_markup:inlineKeyboard([
      [{text:'🔄 Yangilash',callback_data:'v23:dashboard'}],
      [{text:'⬅️ Admin panel',callback_data:'v23:main'}]
    ])
  });
}

async function showMediaMenu(env, chatId) {
  const rows=[];
  for(let i=0;i<MEDIA_SECTIONS.length;i+=2){
    rows.push(MEDIA_SECTIONS.slice(i,i+2).map(([key,label])=>({
      text:label,callback_data:`v23:media:${key}`
    })));
  }
  rows.push([{text:'⬅️ Admin panel',callback_data:'v23:main'}]);
  return sendMessage(env,chatId,
    '🖼 <b>Rasmlar boshqaruvi</b>\n\nBo‘limni tanlang. Yangi rasmni Telegramga <b>Photo</b> qilib yuboring yoki HTTPS URL yuboring. <code>/reset</code> — standart rasm.',
    {reply_markup:inlineKeyboard(rows)});
}

async function beginMediaEdit(env,q,key){
  if(!MEDIA_SECTIONS.some(x=>x[0]===key)){ await answerCallback(env,q.id,'Noto‘g‘ri bo‘lim'); return true; }
  await setAdminSession(env,q.from.id,'edit_image',{key},20);
  const current=await getSetting(env,`asset.${key}`,null);
  await answerCallback(env,q.id);
  await sendMessage(env,q.message.chat.id,[
    `🖼 <b>${escapeHtml(key)}</b> rasmi`, '',
    current ? '✅ Custom rasm o‘rnatilgan.' : 'ℹ️ Standart FiberNet rasmi ishlatilmoqda.', '',
    'Yangi rasmni <b>Photo</b> qilib yuboring yoki <code>https://...</code> URL yuboring.',
    '<code>/reset</code> — standart rasm · <code>/undo</code> — oldingi rasm · <code>/cancel</code> — bekor'
  ].join('\n'));
  return true;
}

async function showTextMenu(env,chatId){
  const rows=TEXT_SECTIONS.map(([key,label])=>[
    {text:`${label} · UZ`,callback_data:`v23:text:${key}:uz`},
    {text:`${label} · RU`,callback_data:`v23:text:${key}:ru`}
  ]);
  rows.push([{text:'⬅️ Admin panel',callback_data:'v23:main'}]);
  return sendMessage(env,chatId,
    '✍️ <b>Matnlar boshqaruvi</b>\n\nBo‘lim va tilni tanlang. HTML format ishlaydi. Rasmli card matni 1000 belgidan oshmasin.',
    {reply_markup:inlineKeyboard(rows)});
}

async function beginTextEdit(env,q,section,lang){
  if(!TEXT_SECTIONS.some(x=>x[0]===section)||!['uz','ru'].includes(lang)){
    await answerCallback(env,q.id,'Noto‘g‘ri bo‘lim');return true;
  }
  await setAdminSession(env,q.from.id,'edit_text',{section,lang},20);
  const current=await getSetting(env,`text.${section}.${lang}`,null);
  await answerCallback(env,q.id);
  await sendMessage(env,q.message.chat.id,[
    `✍️ <b>${escapeHtml(section)} · ${lang.toUpperCase()}</b>`, '',
    current ? `Hozirgi custom matn:\n\n${current}` : 'ℹ️ Standart matn ishlatilmoqda.', '',
    'Yangi matnni yuboring.',
    '<code>/reset</code> — standart · <code>/undo</code> — oldingi · <code>/cancel</code> — bekor'
  ].join('\n'));
  return true;
}

async function showLinkGroups(env,chatId){
  return sendMessage(env,chatId,'🔗 <b>Havolalar boshqaruvi</b>\n\nGuruhni tanlang:',{
    reply_markup:inlineKeyboard([
      [{text:'🌐 Asosiy',callback_data:'v23:links:core'},{text:'☎️ Kontakt',callback_data:'v23:links:contact'}],
      [{text:'📶 Xizmatlar',callback_data:'v23:links:service'},{text:'🧰 Tools',callback_data:'v23:links:tools'}],
      [{text:'⬅️ Admin panel',callback_data:'v23:main'}]
    ])
  });
}

async function showLinkMenu(env,chatId,group){
  const items=LINK_GROUPS[group]||[];
  const rows=items.map(([key,label])=>[{text:label,callback_data:`v23:link:${key}`}]);
  rows.push([{text:'⬅️ Havolalar',callback_data:'v23:links'}]);
  return sendMessage(env,chatId,'🔗 <b>Havolani tanlang</b>',{reply_markup:inlineKeyboard(rows)});
}

async function beginLinkEdit(env,q,key){
  const valid=Object.values(LINK_GROUPS).flat().some(x=>x[0]===key);
  if(!valid){await answerCallback(env,q.id,'Noto‘g‘ri key');return true;}
  await setAdminSession(env,q.from.id,'edit_link',{key},20);
  const current=await getSetting(env,`link.${key}`,null);
  await answerCallback(env,q.id);
  await sendMessage(env,q.message.chat.id,[
    `🔗 <b>${escapeHtml(key)}</b>`, '',
    current ? `Custom: <code>${escapeHtml(current)}</code>` : 'ℹ️ Standart rasmiy URL ishlatilmoqda.', '',
    'Yangi HTTPS havolani yuboring.',
    'Faqat fibernet.uz va @fibernet_* rasmiy havolalari qabul qilinadi.',
    '<code>/reset</code> — standart · <code>/undo</code> — oldingi · <code>/cancel</code> — bekor'
  ].join('\n'));
  return true;
}

async function showSupportSettings(env,chatId){
  const wait=await getNumberSetting(env,'support.wait_minutes',15);
  return sendMessage(env,chatId,[
    '⏱ <b>Support sozlamalari</b>', '',
    `Operator javob vaqti: <b>5–${wait} daqiqa</b>`,
    'Bu qiymat userga ko‘rsatiladigan taxminiy vaqt uchun ishlatiladi.'
  ].join('\n'),{
    reply_markup:inlineKeyboard([
      [{text:'⏱ Vaqtni o‘zgartirish',callback_data:'v23:support:wait'}],
      [{text:'⬅️ Admin panel',callback_data:'v23:main'}]
    ])
  });
}

async function beginWaitEdit(env,q){
  await setAdminSession(env,q.from.id,'edit_wait',{},15);
  await answerCallback(env,q.id);
  await sendMessage(env,q.message.chat.id,
    '⏱ Yangi maksimal kutish vaqtini <b>daqiqada</b> yuboring. Masalan: <code>15</code>. Ruxsat: 5–120.\n\n/cancel — bekor');
  return true;
}

async function showProfiles(env,chatId){
  const rows=await safeAll(env,`SELECT p.telegram_id,p.given_name,p.family_name,u.username
    FROM fn18_profiles p LEFT JOIN fn5_users u ON u.telegram_id=p.telegram_id
    WHERE p.status='pending' ORDER BY p.submitted_at ASC LIMIT 12`);
  const buttons=rows.map(x=>[{
    text:`⏳ ${[x.given_name,x.family_name].filter(Boolean).join(' ')||x.telegram_id}`,
    callback_data:`v18admin:view:${x.telegram_id}`
  }]);
  buttons.push([{text:'⬅️ Admin panel',callback_data:'v23:main'}]);
  return sendMessage(env,chatId,[
    '👤 <b>Tasdiq kutayotgan profillar</b>', '',
    rows.length ? `Navbatda: <b>${rows.length}</b>` : '✅ Navbat bo‘sh',
    rows.length ? 'Profilni ko‘rish uchun mijozni bosing.' : ''
  ].join('\n'),{reply_markup:inlineKeyboard(buttons)});
}

async function showOperators(env,chatId){
  const rows=await safeAll(env,`SELECT chat_id,user_id,display_name,username,status
    FROM fn19_operator_acl
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
      updated_at DESC LIMIT 12`);
  const buttons=rows.map(x=>[{
    text:`${x.status==='approved'?'✅':x.status==='pending'?'⏳':'🚫'} ${String(x.display_name||x.user_id).slice(0,30)}`,
    callback_data:`v23:operator:detail:${x.chat_id}:${x.user_id}`
  }]);
  buttons.push([{text:'⬅️ Admin panel',callback_data:'v23:main'}]);
  return sendMessage(env,chatId,[
    '👨‍💻 <b>Operator boshqaruvi</b>','',
    'Operatorni tanlang: guruhdagi a’zoligini tekshirib tasdiqlash, ruxsatini bekor qilish va bog‘langan ticketlarni navbatga qaytarish mumkin.',
    `Ko‘rsatilmoqda: ${rows.length}`
  ].join('\n'),{reply_markup:inlineKeyboard(buttons)});
}

async function showOperatorDetail(env,chatId,chatRaw,userRaw){
  if(!/^-?\d+$/.test(String(chatRaw))||!/^\d+$/.test(String(userRaw)))
    return sendMessage(env,chatId,'⚠️ ID noto‘g‘ri.');
  const op=await safeFirst(env,`SELECT * FROM fn19_operator_acl WHERE chat_id=? AND user_id=?`,[chatRaw,userRaw]);
  if(!op)return sendMessage(env,chatId,'⚠️ Operator topilmadi.');
  const group=await safeFirst(env,'SELECT department FROM fn7_department_chats WHERE chat_id=?',[chatRaw]);
  const buttons=[];
  if(op.status!=='approved') buttons.push([{
    text:'✅ Operator sifatida tasdiqlash',callback_data:`v23:operator:approve:${chatRaw}:${userRaw}`
  }]);
  if(op.status==='approved'&&!isBotAdmin(env,userRaw)) buttons.push([{
    text:'🚫 Ruxsatni bekor qilish',callback_data:`v23:operator:askrevoke:${chatRaw}:${userRaw}`
  }]);
  buttons.push([{text:'⬅️ Operatorlar',callback_data:'v23:operators'}]);
  return sendMessage(env,chatId,[
    '👨‍💻 <b>Operator profili</b>','',
    `👤 ${escapeHtml(op.display_name||'—')} · <code>${op.user_id}</code>`,
    `🏢 ${escapeHtml(group?.department||'Ulanmagan')} · <code>${op.chat_id}</code>`,
    `🔐 ${escapeHtml(op.status)}`
  ].join('\n'),{reply_markup:inlineKeyboard(buttons)});
}

async function operatorAction(env,q,action,chatId,userId){
  if(!/^-?\d+$/.test(String(chatId))||!/^\d+$/.test(String(userId))){
    await answerCallback(env,q.id,'Noto‘g‘ri ID');return true;
  }
  if(action==='askrevoke'){
    await answerCallback(env,q.id);
    return sendMessage(env,q.message.chat.id,'⚠️ Operatorni guruhning support tizimidan chiqarishni tasdiqlang. Ochiq ticketlari navbatga qaytarilishi mumkin.',{
      reply_markup:inlineKeyboard([
        [{text:'🚫 Ha, ruxsat bekor',callback_data:`v23:operator:revoke:${chatId}:${userId}`}],
        [{text:'⬅️ Bekor',callback_data:`v23:operator:detail:${chatId}:${userId}`}]
      ])
    });
  }
  if(action==='revoke'&&isBotAdmin(env,userId)){
    await answerCallback(env,q.id,'Bot administratorini bu yerdan bekor qilib bo‘lmaydi');return true;
  }
  try{
    if(action==='approve') await approvePanelOperator(env,chatId,userId,q.from.id);
    else if(action==='revoke') await revokePanelOperator(env,chatId,userId,q.from.id);
    else {await answerCallback(env,q.id,'Noma’lum amal');return true;}
    await auditAdmin(env,q.from.id,`operator_${action}`,`${chatId}:${userId}`);
    await answerCallback(env,q.id,'Operator huquqi yangilandi');
    return showOperatorDetail(env,q.message.chat.id,chatId,userId);
  }catch(e){
    await answerCallback(env,q.id,'Amal bajarilmadi');
    return sendMessage(env,q.message.chat.id,`⚠️ ${escapeHtml(String(e.message||e).slice(0,160))}`);
  }
}
async function showTickets(env,chatId){
  const rows=await safeAll(env,`SELECT ticket_no,department,category,priority,stage,assigned_name,created_at
    FROM fn5_tickets WHERE status='open'
    ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,id ASC LIMIT 12`);
  const buttons=rows.map(x=>[{
    text:`${x.priority==='critical'?'🚨':x.priority==='high'?'🔴':'🟡'} ${x.ticket_no} · ${x.department}`,
    callback_data:`v23:ticket:${x.ticket_no}`
  }]);
  buttons.push([{text:'🔎 Ticket qidirish',callback_data:'v23:ticketfind'}]);
  buttons.push([{text:'⬅️ Admin panel',callback_data:'v23:main'}]);
  return sendMessage(env,chatId,[
    '🎫 <b>Ochiq ticketlar</b>', '',
    rows.length?`Ko‘rsatilmoqda: <b>${rows.length}</b>`:'✅ Ochiq ticket yo‘q'
  ].join('\n'),{reply_markup:inlineKeyboard(buttons)});
}

async function showTicketDetail(env,chatId,no){
  const t=await getTicket(env,no);
  if(!t) return sendMessage(env,chatId,'⚠️ Ticket topilmadi.');
  let topic=null;
  try{topic=await env.DB.prepare('SELECT chat_id,thread_id,state FROM fn15_topics WHERE ticket_no=?').bind(no).first();}catch{}
  return sendMessage(env,chatId,[
    `🎫 <b>${escapeHtml(t.ticket_no)}</b>`,
    `🏢 ${escapeHtml(t.department)} · ${escapeHtml(t.category)}`,
    `🚦 ${escapeHtml(t.priority)} · 📌 ${escapeHtml(t.stage)} · ${escapeHtml(t.status)}`,
    `👤 <code>${t.telegram_id}</code>`,
    t.assigned_name?`👨‍💻 ${escapeHtml(t.assigned_name)}`:'👨‍💻 Biriktirilmagan',
    `🔐 ${escapeHtml(t.account_login||'—')}`,
    `📍 ${escapeHtml(t.address||'—')}`,
    `📞 ${escapeHtml(t.phone||'—')}`,
    topic?.thread_id?`🧵 Topic: <code>${topic.thread_id}</code> · ${escapeHtml(topic.state||'—')}`:'🧵 Topic yo‘q',
    '', `📝 ${escapeHtml(t.description||'—')}`
  ].join('\n'),{
    reply_markup:inlineKeyboard([
      [{text:'🔴 High',callback_data:`v23:ticketprio:${no}:high`},{text:'🟡 Normal',callback_data:`v23:ticketprio:${no}:normal`}],
      [{text:'✅ Hal qilindi',callback_data:`v23:ticketresolve:${no}`},{text:'❌ Yopish',callback_data:`v23:ticketclose:ask:${no}`}],
      [{text:'⬅️ Ticketlar',callback_data:'v23:tickets'}]
    ])
  });
}

async function beginTicketFind(env,q){
  await setAdminSession(env,q.from.id,'ticket_find',{},10);
  await answerCallback(env,q.id);
  await sendMessage(env,q.message.chat.id,'🔎 Ticket raqamini yuboring. Masalan: <code>FN-260928-ABC123</code>\n/cancel — bekor');
  return true;
}

async function resolveTicketAdmin(env,q,no){
  const t=await getTicket(env,no);
  if(!t||t.status!=='open'){await answerCallback(env,q.id,'Ticket ochiq emas');return true;}
  await setStage(env,no,'resolved');
  await auditAdmin(env,q.from.id,'ticket_resolved',no);
  await answerCallback(env,q.id,'Hal qilindi');
  try{
    await sendMessage(env,t.telegram_id,
      `✅ <b>Murojaat hal qilindi deb belgilandi</b>\n🎫 <code>${escapeHtml(no)}</code>\n\nMuammo davom etsa, shu ticket orqali operatorga qayta yozishingiz mumkin.`,
      {reply_markup:inlineKeyboard([[{text:'💬 Operatorga javob',callback_data:`ticket:reply:${no}`}]])});
  }catch{}
  return showTicketDetail(env,q.message.chat.id,no);
}

async function askCloseTicket(env,q,no){
  const t=await getTicket(env,no);
  await answerCallback(env,q.id);
  if(!t || t.status!=='open') return sendMessage(env,q.message.chat.id,'⚠️ Ticket hozir ochiq emas.');
  return sendMessage(env,q.message.chat.id,[
    '⚠️ <b>Ticketni yopishni tasdiqlang</b>','',
    `🎫 <code>${escapeHtml(no)}</code>`,
    'Bu amal operator Topic’ini yopadi va abonentga xabar yuboradi.'
  ].join('\n'),{
    reply_markup:inlineKeyboard([
      [{text:'✅ Ha, yopilsin',callback_data:`v23:ticketclose:confirm:${no}`}],
      [{text:'⬅️ Bekor',callback_data:`v23:ticket:${no}`}]
    ])
  });
}

async function closeTicketAdmin(env,q,no){
  const t=await getTicket(env,no);
  if(!t||t.status!=='open'){await answerCallback(env,q.id,'Ticket ochiq emas');return true;}
  await closeTicket(env,no);
  await auditAdmin(env,q.from.id,'ticket_closed',no);
  try{
    const topic=await env.DB.prepare('SELECT chat_id,thread_id FROM fn15_topics WHERE ticket_no=?').bind(no).first();
    if(topic?.thread_id){
      try{await tg(env,'closeForumTopic',{chat_id:topic.chat_id,message_thread_id:topic.thread_id});}catch{}
      try{await env.DB.prepare("UPDATE fn15_topics SET state='closed',updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?").bind(no).run();}catch{}
    }
  }catch{}
  await answerCallback(env,q.id,'Ticket yopildi');
  try{await sendMessage(env,t.telegram_id,`❌ <b>Murojaat yopildi</b>\n🎫 <code>${escapeHtml(no)}</code>`);}catch{}
  return showTicketDetail(env,q.message.chat.id,no);
}

async function priorityTicketAdmin(env,q,no,priority){
  if(!['critical','high','normal','low'].includes(priority)){await answerCallback(env,q.id,'Noto‘g‘ri priority');return true;}
  const t=await getTicket(env,no);
  if(!t||t.status!=='open'){await answerCallback(env,q.id,'Ticket ochiq emas');return true;}
  await env.DB.prepare('UPDATE fn5_tickets SET priority=?,updated_at=CURRENT_TIMESTAMP WHERE ticket_no=?').bind(priority,no).run();
  await auditAdmin(env,q.from.id,'ticket_priority',no,priority);
  await answerCallback(env,q.id,`Priority: ${priority}`);
  return showTicketDetail(env,q.message.chat.id,no);
}

async function showPreviewMenu(env,chatId){
  const items=[
    ['home','🏠 Home'],['support','🛠 Yordam'],['tariffs','📶 Tarif'],['payment','💳 To‘lov'],
    ['connect','🔌 Ulanish'],['tv','📺 TV'],['services','🧰 Xizmat'],['contacts','☎️ Kontakt'],
    ['promo','🎁 Promo'],['about','ℹ️ About'],['guides','📚 Guide'],['news','📰 News']
  ];
  const rows=[];
  for(let i=0;i<items.length;i+=2) rows.push(items.slice(i,i+2).map(([k,l])=>({text:l,callback_data:`v23:preview:${k}`})));
  rows.push([{text:'⬅️ Admin panel',callback_data:'v23:main'}]);
  return sendMessage(env,chatId,'👁 <b>Kontent preview</b>\n\nAdmin tilingiz bo‘yicha real user card yuboriladi.',{reply_markup:inlineKeyboard(rows)});
}

async function previewSection(env,q,section){
  const u=await safeFirst(env,'SELECT language FROM fn5_users WHERE telegram_id=?',[q.from.id]);
  const lang=u?.language==='ru'?'ru':'uz';
  const map={
    home:showPremiumHome,support:showPremiumSupport,tariffs:showPremiumTariffs,payment:showPremiumPayment,
    connect:showPremiumConnect,tv:showPremiumTV,services:showPremiumServices,contacts:showPremiumContacts,
    promo:showPremiumPromo,about:showPremiumAbout,guides:showPremiumGuides,news:showPremiumNews
  };
  const fn=map[section];
  if(!fn){await answerCallback(env,q.id,'Topilmadi');return true;}
  await answerCallback(env,q.id);
  await fn(env,q.message.chat.id,lang);
  return true;
}

async function showBroadcast(env,chatId){
  const recent=await safeAll(env,`SELECT id,admin_id,status,target_count,delivered,failed,created_at
    FROM fn23_broadcasts ORDER BY id DESC LIMIT 5`);
  const controls=recent.filter(x=>['queued','sending'].includes(x.status)).map(x=>[{
    text:`⏹ To‘xtatish #${x.id}`,callback_data:`v23:broadcast:stop:${x.id}`
  }]);
  return sendMessage(env,chatId,[
    '📢 <b>Broadcast Center</b>', '',
    'Avval preview va alohida tasdiq bo‘ladi. Qayta bosilgan tugmalar takroriy yuborishni boshlamaydi.', '',
    ...recent.map(x=>`#${x.id} · ${escapeHtml(x.status)} · ${x.delivered}/${x.target_count} ✅ · ${x.failed} ❌`)
  ].join('\n'),{
    reply_markup:inlineKeyboard([
      [{text:'➕ Yangi broadcast',callback_data:'v23:broadcast:new'}],
      [{text:'🔄 Status',callback_data:'v23:broadcast'}],
      ...controls,
      [{text:'⬅️ Admin panel',callback_data:'v23:main'}]
    ])
  });
}

async function beginBroadcast(env,q){
  await setAdminSession(env,q.from.id,'broadcast_message',{},20);
  await answerCallback(env,q.id);
  await sendMessage(env,q.message.chat.id,
    '📢 <b>Broadcast xabarini yuboring</b>\n\nText, photo, video, document, voice, sticker — bitta Telegram xabar yuboring. Keyin preview va Confirm chiqadi.\n\n/cancel — bekor');
  return true;
}

async function draftBroadcast(env,msg){
  const r=await env.DB.prepare(`INSERT INTO fn23_broadcasts(admin_id,source_chat_id,source_message_id,status)
    VALUES(?,?,?,'draft')`).bind(msg.from.id,msg.chat.id,msg.message_id).run();
  const id=Number(r.meta?.last_row_id || 0);
  await clearAdminSession(env,msg.from.id);
  await sendMessage(env,msg.chat.id,'👁 <b>Broadcast preview</b>');
  try{await tg(env,'copyMessage',{chat_id:msg.chat.id,from_chat_id:msg.chat.id,message_id:msg.message_id});}catch{}
  await sendMessage(env,msg.chat.id,[
    `📢 Broadcast <b>#${id}</b>`,
    'Tasdiqlasangiz barcha ro‘yxatdan o‘tgan foydalanuvchilarga queue orqali yuboriladi.'
  ].join('\n'),{
    reply_markup:inlineKeyboard([
      [{text:'✅ TASDIQLASH',callback_data:`v23:broadcast:confirm:${id}`}],
      [{text:'❌ Bekor qilish',callback_data:`v23:broadcast:cancel:${id}`}]
    ])
  });
  return true;
}

async function prepareBroadcastQueue(env,id){
  await env.DB.prepare(`INSERT OR IGNORE INTO fn23_broadcast_queue(broadcast_id,telegram_id)
    SELECT ?,telegram_id FROM fn5_users`).bind(id).run();
  const count=await safeFirst(env,'SELECT COUNT(*) n FROM fn23_broadcast_queue WHERE broadcast_id=?',[id]);
  await env.DB.prepare(`UPDATE fn23_broadcasts SET status='queued',target_count=?
    WHERE id=? AND status='preparing'`).bind(count?.n||0,id).run();
  return Number(count?.n||0);
}

async function confirmBroadcast(env,q,id){
  if(!Number.isSafeInteger(id)||id<=0){await answerCallback(env,q.id,'Noto‘g‘ri broadcast');return true;}
  // Atomic compare-and-set: old Confirm buttons cannot queue a broadcast twice.
  const reserved=await env.DB.prepare(`UPDATE fn23_broadcasts SET status='preparing',started_at=CURRENT_TIMESTAMP
    WHERE id=? AND admin_id=? AND status='draft'`).bind(id,q.from.id).run();
  if(Number(reserved.meta?.changes||0)!==1){
    await answerCallback(env,q.id,'Bu broadcast allaqachon tasdiqlangan yoki bekor qilingan');
    return true;
  }
  const count=await prepareBroadcastQueue(env,id);
  await auditAdmin(env,q.from.id,'broadcast_confirmed',String(id),`targets=${count}`);
  await answerCallback(env,q.id,'Broadcast navbatga qo‘yildi');
  await sendMessage(env,q.message.chat.id,`✅ Broadcast <b>#${id}</b> navbatga qo‘yildi. Qabul qiluvchilar: <b>${count}</b>.`);
  return true;
}

async function cancelBroadcast(env,q,id){
  const result=await env.DB.prepare(`UPDATE fn23_broadcasts
    SET status='cancelled',finished_at=CURRENT_TIMESTAMP
    WHERE id=? AND admin_id=? AND status='draft'`).bind(id,q.from.id).run();
  if(result.meta?.changes) await auditAdmin(env,q.from.id,'broadcast_cancelled',String(id));
  await answerCallback(env,q.id,result.meta?.changes?'Bekor qilindi':'Bu draft allaqachon o‘zgargan');
  return showBroadcast(env,q.message.chat.id);
}

async function stopBroadcast(env,q,id){
  const result=await env.DB.prepare(`UPDATE fn23_broadcasts
    SET status='cancelled',finished_at=CURRENT_TIMESTAMP
    WHERE id=? AND status IN ('queued','sending')`).bind(id).run();
  if(!result.meta?.changes){
    await answerCallback(env,q.id,'Broadcast yakunlangan yoki to‘xtatilgan');return true;
  }
  await env.DB.prepare(`UPDATE fn23_broadcast_queue SET status='cancelled',updated_at=CURRENT_TIMESTAMP
    WHERE broadcast_id=? AND status='pending'`).bind(id).run();
  await auditAdmin(env,q.from.id,'broadcast_stopped',String(id));
  await answerCallback(env,q.id,'Yangi yuborishlar to‘xtatildi');
  await sendMessage(env,q.message.chat.id,
    `⏹ Broadcast <b>#${id}</b> to‘xtatildi. Hozir yuborilayotgan alohida xabarni ortga qaytarib bo‘lmaydi.`);
  return true;
}

async function processBroadcasts(env){
  await ensureV23Store(env);
  // Recover drafts whose preparation was interrupted by a worker restart.
  const preparing=await safeAll(env,`SELECT id FROM fn23_broadcasts
    WHERE status='preparing' AND datetime(started_at)<=datetime('now','-1 minute') LIMIT 3`);
  for(const b of preparing) await prepareBroadcastQueue(env,b.id);

  // A worker can die between claim and Telegram response; return timed-out
  // work to the queue rather than silently losing it.
  await env.DB.prepare(`UPDATE fn23_broadcast_queue SET status='pending',updated_at=CURRENT_TIMESTAMP
    WHERE status='sending' AND datetime(updated_at)<=datetime('now','-10 minutes')
      AND broadcast_id IN (SELECT id FROM fn23_broadcasts WHERE status IN ('queued','sending'))`).run();

  const jobs=await safeAll(env,`SELECT q.broadcast_id,q.telegram_id,b.source_chat_id,b.source_message_id
    FROM fn23_broadcast_queue q JOIN fn23_broadcasts b ON b.id=q.broadcast_id
    WHERE q.status='pending' AND b.status IN ('queued','sending')
      AND datetime(q.next_try_at)<=datetime('now')
    ORDER BY q.broadcast_id,q.telegram_id LIMIT 25`);
  for(const x of jobs){
    // Atomic lease: two overlapping cron jobs cannot both claim this row.
    const claim=await env.DB.prepare(`UPDATE fn23_broadcast_queue
      SET status='sending',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP
      WHERE broadcast_id=? AND telegram_id=? AND status='pending'
        AND EXISTS(SELECT 1 FROM fn23_broadcasts WHERE id=? AND status IN ('queued','sending'))`)
      .bind(x.broadcast_id,x.telegram_id,x.broadcast_id).run();
    if(Number(claim.meta?.changes||0)!==1) continue;
    try{
      await tg(env,'copyMessage',{
        chat_id:x.telegram_id,from_chat_id:x.source_chat_id,message_id:x.source_message_id
      });
      const done=await env.DB.prepare(`UPDATE fn23_broadcast_queue SET status='delivered',updated_at=CURRENT_TIMESTAMP
        WHERE broadcast_id=? AND telegram_id=? AND status='sending'`)
        .bind(x.broadcast_id,x.telegram_id).run();
      if(done.meta?.changes){
        await env.DB.prepare(`UPDATE fn23_broadcasts SET delivered=delivered+1,
          status=CASE WHEN status='queued' THEN 'sending' ELSE status END WHERE id=?`)
          .bind(x.broadcast_id).run();
      }
    }catch(e){
      const error=String(e).slice(0,500);
      const row=await safeFirst(env,`SELECT attempts FROM fn23_broadcast_queue
        WHERE broadcast_id=? AND telegram_id=?`,[x.broadcast_id,x.telegram_id]);
      const permanent=/bot was blocked|user is deactivated|chat not found|forbidden/i.test(error);
      const failed=permanent||Number(row?.attempts||0)>=6;
      const step=Number(row?.attempts||0)<3?'+5 minutes':'+30 minutes';
      const updated=await env.DB.prepare(`UPDATE fn23_broadcast_queue SET
        status=?,last_error=?,next_try_at=datetime('now',?),updated_at=CURRENT_TIMESTAMP
        WHERE broadcast_id=? AND telegram_id=? AND status='sending'`)
        .bind(failed?'failed':'pending',error,step,x.broadcast_id,x.telegram_id).run();
      if(failed&&updated.meta?.changes)
        await env.DB.prepare('UPDATE fn23_broadcasts SET failed=failed+1 WHERE id=?')
          .bind(x.broadcast_id).run();
    }
  }
  const active=await safeAll(env,`SELECT id FROM fn23_broadcasts WHERE status IN ('queued','sending')`);
  for(const b of active){
    const remaining=await safeFirst(env,`SELECT COUNT(*) n FROM fn23_broadcast_queue
      WHERE broadcast_id=? AND status IN ('pending','sending')`,[b.id]);
    if(!remaining?.n) await env.DB.prepare(`UPDATE fn23_broadcasts
      SET status='completed',finished_at=CURRENT_TIMESTAMP WHERE id=?
      AND status IN ('queued','sending')`).bind(b.id).run();
  }
}

async function showSystem(env,chatId){
  const maintenance=await getBooleanSetting(env,'system.maintenance',false);
  const cache=await safeFirst(env,'SELECT COUNT(*) n FROM fn22_media_cache WHERE telegram_file_id IS NOT NULL');
  return sendMessage(env,chatId,[
    '🧰 <b>Sistema</b>', '',
    `🚧 Maintenance: <b>${maintenance?'ON':'OFF'}</b>`,
    `🖼 Telegram media cache: <b>${cache?.n||0}</b>`
  ].join('\n'),{
    reply_markup:inlineKeyboard([
      [{text:maintenance?'🟢 Maintenance OFF':'🚧 Maintenance ON',callback_data:'v23:system:maintenance'}],
      [{text:'🔄 FiberNet manbalarini sync',callback_data:'v23:system:sync'}],
      [{text:'🧹 Media cache tozalash',callback_data:'v23:system:cache'}],
      [{text:'⬅️ Admin panel',callback_data:'v23:main'}]
    ])
  });
}

async function toggleMaintenance(env,q){
  const current=await getBooleanSetting(env,'system.maintenance',false);
  const mode=current?'off':'on';
  await answerCallback(env,q.id);
  return sendMessage(env,q.message.chat.id,'⚠️ <b>Maintenance o‘zgarishini tasdiqlang</b>',{
    reply_markup:inlineKeyboard([
      [{text:mode==='on'?'🚧 Ha, yoqilsin':'✅ Ha, o‘chirilsin',callback_data:`v23:system:maintenance:apply:${mode}`}],
      [{text:'⬅️ Bekor',callback_data:'v23:system'}]
    ])
  });
}

async function applyMaintenance(env,q,mode){
  if(!['on','off'].includes(mode)){await answerCallback(env,q.id,'Noto‘g‘ri qiymat');return true;}
  const current=await getBooleanSetting(env,'system.maintenance',false);
  if(current!==(mode==='on')){
    await setSetting(env,'system.maintenance',mode==='on'?'1':'0','boolean',q.from.id);
    await auditAdmin(env,q.from.id,'maintenance_changed',null,mode);
  }
  await answerCallback(env,q.id,'Holat tekshirildi');
  return showSystem(env,q.message.chat.id);
}

async function syncSources(env,q){
  await answerCallback(env,q.id,'Sync boshlandi');
  await sendMessage(env,q.message.chat.id,'🔄 FiberNet rasmiy manbalari yangilanmoqda...');
  const report=await syncOfficialSources(env);
  await auditAdmin(env,q.from.id,'official_sources_sync',null,JSON.stringify(report));
  await sendMessage(env,q.message.chat.id,[
    '✅ <b>Source sync tugadi</b>','',
    ...report.map(x=>`• ${escapeHtml(x.key)} — HTTP ${x.status}${x.parsed!=null?` · parsed ${x.parsed}`:''}${x.error?` · ${escapeHtml(x.error)}`:''}`)
  ].join('\n'));
  return true;
}

async function clearMediaCache(env,q){
  try{await env.DB.prepare('DELETE FROM fn22_media_cache').run();}catch{}
  await auditAdmin(env,q.from.id,'media_cache_cleared');
  await answerCallback(env,q.id,'Cache tozalandi');
  return showSystem(env,q.message.chat.id);
}

async function showAudit(env,chatId){
  const rows=await recentAudit(env,20);
  return sendMessage(env,chatId,[
    '📜 <b>Admin audit log</b>','',
    ...(rows.length?rows.map(x=>`• <code>${escapeHtml(x.created_at)}</code> · <b>${escapeHtml(x.action)}</b>${x.target?` · ${escapeHtml(x.target)}`:''}\n  admin <code>${x.admin_id||'—'}</code>`):['—'])
  ].join('\n'),{reply_markup:inlineKeyboard([[{text:'⬅️ Admin panel',callback_data:'v23:main'}]])});
}

async function showSettings(env,chatId){
  const rows=await listSettings(env);
  return sendMessage(env,chatId,[
    '⚙️ <b>Custom override’lar</b>','',
    ...(rows.length?rows.slice(0,40).map(x=>`• <code>${escapeHtml(x.setting_key)}</code> · ${escapeHtml(x.setting_kind)}`):['Standart sozlamalar ishlatilmoqda.']),
    rows.length>40?`\n… yana ${rows.length-40} ta`:null
  ].filter(Boolean).join('\n'),{reply_markup:inlineKeyboard([[{text:'⬅️ Admin panel',callback_data:'v23:main'}]])});
}

async function resetOrUndoSession(env,msg,session,undo=false){
  const p=session.payload||{};
  let key=null;
  if(session.action==='edit_image') key=`asset.${p.key}`;
  if(session.action==='edit_text') key=`text.${p.section}.${p.lang}`;
  if(session.action==='edit_link') key=`link.${p.key}`;
  if(session.action==='edit_wait') key='support.wait_minutes';
  if(!key) return false;
  const ok=undo?await restorePreviousSetting(env,key,msg.from.id):await resetSetting(env,key,msg.from.id);
  if(key.startsWith('asset.')){
    const asset=key.slice('asset.'.length);
    try{await env.DB.prepare('DELETE FROM fn22_media_cache WHERE asset_key=?').bind(asset).run();}catch{}
  }
  await clearAdminSession(env,msg.from.id);
  await auditAdmin(env,msg.from.id,undo?'setting_undo':'setting_reset',key);
  await sendMessage(env,msg.chat.id,ok
    ? `✅ <code>${escapeHtml(key)}</code> ${undo?'oldingi versiyaga qaytdi':'standart qiymatga qaytdi'}.`
    : 'ℹ️ Custom qiymat topilmadi.');
  return showPanel(env,msg.chat.id);
}

async function handleSessionMessage(env,msg,session){
  const text=String(msg.text||'').trim();
  if(/^\/cancel(?:@\w+)?$/i.test(text)){
    await clearAdminSession(env,msg.from.id);
    await sendMessage(env,msg.chat.id,'❎ Admin amali bekor qilindi.');
    await showPanel(env,msg.chat.id);
    return true;
  }
  if(/^\/reset(?:@\w+)?$/i.test(text)) return resetOrUndoSession(env,msg,session,false);
  if(/^\/undo(?:@\w+)?$/i.test(text)) return resetOrUndoSession(env,msg,session,true);

  if(session.action==='edit_image'){
    const key=session.payload.key;
    let value=null;
    if(Array.isArray(msg.photo)&&msg.photo.length) value=msg.photo[msg.photo.length-1].file_id;
    else if(/^https:\/\/\S+$/i.test(text)) value=text.slice(0,1000);
    if(!value || !validMediaInput(value,!value.startsWith('https://'))){
      await sendMessage(env,msg.chat.id,'⚠️ Yaroqli Telegram Photo yuboring yoki xavfsiz ochiq HTTPS rasm URL kiriting (private IP/localhost emas).');
      return true;
    }
    await setSetting(env,`asset.${key}`,value,'image',msg.from.id);
    try{await env.DB.prepare('DELETE FROM fn22_media_cache WHERE asset_key=?').bind(key).run();}catch{}
    await clearAdminSession(env,msg.from.id);
    await auditAdmin(env,msg.from.id,'image_updated',key);
    await sendMessage(env,msg.chat.id,`✅ <b>${escapeHtml(key)}</b> rasmi yangilandi. Preview orqali tekshiring.`);
    return showPanel(env,msg.chat.id);
  }

  if(session.action==='edit_text'){
    if(!text){await sendMessage(env,msg.chat.id,'⚠️ Matn yuboring.');return true;}
    if(text.length>1000){await sendMessage(env,msg.chat.id,`⚠️ Matn juda uzun: ${text.length}/1000.`);return true;}
    try{await sendMessage(env,msg.chat.id,`👁 <b>Preview:</b>\n\n${text}`);}
    catch{await sendMessage(env,msg.chat.id,'⚠️ HTML xato. Teglarni tekshiring.');return true;}
    const key=`text.${session.payload.section}.${session.payload.lang}`;
    await setSetting(env,key,text,'html',msg.from.id);
    await clearAdminSession(env,msg.from.id);
    await auditAdmin(env,msg.from.id,'text_updated',key);
    await sendMessage(env,msg.chat.id,`✅ <code>${escapeHtml(key)}</code> saqlandi.`);
    return showPanel(env,msg.chat.id);
  }

  if(session.action==='edit_link'){
    if(!validOfficialLink(text)){
      await sendMessage(env,msg.chat.id,'⚠️ Faqat rasmiy <code>https://fibernet.uz</code> (subdomenlari bilan) yoki <code>https://t.me/fibernet_...</code> havolasi qabul qilinadi.');
      return true;
    }
    const key=`link.${session.payload.key}`;
    await setSetting(env,key,text,'url',msg.from.id);
    await clearAdminSession(env,msg.from.id);
    await auditAdmin(env,msg.from.id,'link_updated',key);
    await sendMessage(env,msg.chat.id,`✅ <code>${escapeHtml(key)}</code> yangilandi.`);
    return showPanel(env,msg.chat.id);
  }

  if(session.action==='edit_wait'){
    const n=Number(text);
    if(!Number.isInteger(n)||n<5||n>120){
      await sendMessage(env,msg.chat.id,'⚠️ 5 dan 120 gacha butun son yuboring.');
      return true;
    }
    await setSetting(env,'support.wait_minutes',String(n),'number',msg.from.id);
    await clearAdminSession(env,msg.from.id);
    await auditAdmin(env,msg.from.id,'support_wait_updated','support.wait_minutes',String(n));
    await sendMessage(env,msg.chat.id,`✅ Operator taxminiy maksimal kutish vaqti: <b>${n} daqiqa</b>.`);
    return showPanel(env,msg.chat.id);
  }

  if(session.action==='ticket_find'){
    const no=(text.toUpperCase().match(/FN-\d{6}-[A-Z0-9]{6}/)||[])[0];
    if(!no){await sendMessage(env,msg.chat.id,'⚠️ Ticket formati noto‘g‘ri.');return true;}
    await clearAdminSession(env,msg.from.id);
    return showTicketDetail(env,msg.chat.id,no);
  }

  if(session.action==='broadcast_message') return draftBroadcast(env,msg);
  return false;
}

async function handleAdminCallback(env,q){
  const data=String(q.data||'');
  if(!data.startsWith('v23:')) return false;
  if(!isBotAdmin(env,q.from.id)){await answerCallback(env,q.id,'Ruxsat yo‘q');return true;}
  const chatId=q.message?.chat?.id;
  if(!chatId||!isPrivate(q.message.chat)){await answerCallback(env,q.id,'Admin panel faqat private chatda');return true;}

  if(data==='v23:main'){await answerCallback(env,q.id);return showPanel(env,chatId);}
  if(data==='v23:dashboard'){await answerCallback(env,q.id);return showDashboard(env,chatId);}
  if(data==='v23:media'){await answerCallback(env,q.id);return showMediaMenu(env,chatId);}
  if(data.startsWith('v23:media:')) return beginMediaEdit(env,q,data.slice('v23:media:'.length));
  if(data==='v23:texts'){await answerCallback(env,q.id);return showTextMenu(env,chatId);}
  if(data.startsWith('v23:text:')){
    const [, , section, lang]=data.split(':'); return beginTextEdit(env,q,section,lang);
  }
  if(data==='v23:links'){await answerCallback(env,q.id);return showLinkGroups(env,chatId);}
  if(data.startsWith('v23:links:')){await answerCallback(env,q.id);return showLinkMenu(env,chatId,data.split(':')[2]);}
  if(data.startsWith('v23:link:')) return beginLinkEdit(env,q,data.slice('v23:link:'.length));
  if(data==='v23:support'){await answerCallback(env,q.id);return showSupportSettings(env,chatId);}
  if(data==='v23:support:wait') return beginWaitEdit(env,q);
  if(data==='v23:profiles'){await answerCallback(env,q.id);return showProfiles(env,chatId);}
  if(data==='v23:operators'){await answerCallback(env,q.id);return showOperators(env,chatId);}
  if(data.startsWith('v23:operator:')){
    const p=data.split(':');
    if(p[2]==='detail'){await answerCallback(env,q.id);return showOperatorDetail(env,chatId,p[3],p[4]);}
    return operatorAction(env,q,p[2],p[3],p[4]);
  }
  if(data==='v23:tickets'){await answerCallback(env,q.id);return showTickets(env,chatId);}
  if(data==='v23:ticketfind') return beginTicketFind(env,q);
  if(data.startsWith('v23:ticket:')){await answerCallback(env,q.id);return showTicketDetail(env,chatId,data.slice('v23:ticket:'.length));}
  if(data.startsWith('v23:ticketresolve:')) return resolveTicketAdmin(env,q,data.slice('v23:ticketresolve:'.length));
  if(data.startsWith('v23:ticketclose:ask:')) return askCloseTicket(env,q,data.slice('v23:ticketclose:ask:'.length));
  if(data.startsWith('v23:ticketclose:confirm:')) return closeTicketAdmin(env,q,data.slice('v23:ticketclose:confirm:'.length));
  if(data.startsWith('v23:ticketprio:')){const p=data.split(':');return priorityTicketAdmin(env,q,p[2],p[3]);}
  if(data==='v23:preview'){await answerCallback(env,q.id);return showPreviewMenu(env,chatId);}
  if(data.startsWith('v23:preview:')) return previewSection(env,q,data.slice('v23:preview:'.length));
  if(data==='v23:broadcast'){await answerCallback(env,q.id);return showBroadcast(env,chatId);}
  if(data==='v23:broadcast:new') return beginBroadcast(env,q);
  if(data.startsWith('v23:broadcast:confirm:')) return confirmBroadcast(env,q,Number(data.split(':')[3]));
  if(data.startsWith('v23:broadcast:cancel:')) return cancelBroadcast(env,q,Number(data.split(':')[3]));
  if(data.startsWith('v23:broadcast:stop:')) return stopBroadcast(env,q,Number(data.split(':')[3]));
  if(data==='v23:system'){await answerCallback(env,q.id);return showSystem(env,chatId);}
  if(data==='v23:system:maintenance') return toggleMaintenance(env,q);
  if(data.startsWith('v23:system:maintenance:apply:')) return applyMaintenance(env,q,data.split(':')[4]);
  if(data==='v23:system:sync') return syncSources(env,q);
  if(data==='v23:system:cache') return clearMediaCache(env,q);
  if(data==='v23:audit'){await answerCallback(env,q.id);return showAudit(env,chatId);}
  if(data==='v23:settings'){await answerCallback(env,q.id);return showSettings(env,chatId);}
  return true;
}

async function handleAdminMessage(env,msg){
  if(!isPrivate(msg.chat)||msg.from?.is_bot) return false;
  const text=String(msg.text||'').trim();

  if(/^\/admin(?:@\w+)?(?:\s|$)/i.test(text)){
    if(!isBotAdmin(env,msg.from.id)){await sendMessage(env,msg.chat.id,'⛔ Bu buyruq mavjud emas.');return true;}
    await clearAdminSession(env,msg.from.id);
    await auditAdmin(env,msg.from.id,'admin_panel_open');
    return showPanel(env,msg.chat.id);
  }

  if(!isBotAdmin(env,msg.from.id)) return false;
  const session=await getAdminSession(env,msg.from.id);
  if(!session) return false;
  if(text.startsWith('/') &&
      !/^\/(cancel|reset|undo)(?:@\w+)?$/i.test(text)){
    await clearAdminSession(env,msg.from.id);
    return false;
  }
  return handleSessionMessage(env,msg,session);
}

export async function handleV23AdminUpdate(env,update){
  await ensureV23Store(env);
  if(update?.callback_query && await handleAdminCallback(env,update.callback_query)) return true;
  if(update?.message && await handleAdminMessage(env,update.message)) return true;
  return false;
}

export async function maintenanceGate(env,update){
  if(!await getBooleanSetting(env,'system.maintenance',false)) return false;
  const msg=update?.message;
  const q=update?.callback_query;
  const from=msg?.from||q?.from;
  const chat=msg?.chat||q?.message?.chat;
  if(!from||!isPrivate(chat)||isBotAdmin(env,from.id)) return false;

  // Keep established support channels open during maintenance.
  if(String(q?.data||'').startsWith('ticket:reply:')) return false;
  if(msg && !String(msg.text||'').trim().startsWith('/')){
    const active=await safeFirst(env,`SELECT c.ticket_no FROM fn21_conversations c
      JOIN fn5_tickets t ON t.ticket_no=c.ticket_no
      WHERE c.telegram_id=? AND c.state IN ('waiting_operator','active','engaged')
        AND t.status='open' ORDER BY c.updated_at DESC LIMIT 1`,[from.id]);
    if(active) return false;
  }

  if(q?.id) await answerCallback(env,q.id,'Texnik ishlar');
  const shown=await env.DB.prepare(`INSERT INTO fn23_maintenance_notices(telegram_id,shown_at)
    VALUES(?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET shown_at=CURRENT_TIMESTAMP
    WHERE datetime(fn23_maintenance_notices.shown_at)<=datetime('now','-10 minutes')`)
    .bind(from.id).run();
  if(!shown.meta?.changes) return true;

  const user=await safeFirst(env,'SELECT language FROM fn5_users WHERE telegram_id=?',[from.id]);
  const lang=user?.language==='ru'?'ru':'uz';
  const fallback=lang==='ru'
    ? '🚧 <b>Технические работы</b>\n\nНовые обращения временно приостановлены. Существующие диалоги продолжают работать.\n\n🛠 Техподдержка: +998 71 200-47-47 · доб. 3'
    : '🚧 <b>Texnik ishlar</b>\n\nYangi murojaatlar vaqtincha to‘xtatilgan. Ochiq ticketdagi operator suhbatlari ishlashda davom etadi.\n\n🛠 Texnik yordam: +998 71 200-47-47 · ichki 3';
  const message=await getSetting(env,`text.maintenance.${lang}`,fallback);
  await sendMessage(env,chat.id,message);
  return true;
}
export async function runV23Maintenance(env){
  await cleanupV23Store(env);
  await processBroadcasts(env);
}

export async function v23Health(env){
  await ensureV23Store(env);
  const [settings,broadcasts,audit]=await Promise.all([
    safeFirst(env,'SELECT COUNT(*) n FROM fn23_settings'),
    safeFirst(env,"SELECT COUNT(*) n FROM fn23_broadcasts WHERE status IN ('queued','sending')"),
    safeFirst(env,"SELECT COUNT(*) n FROM fn23_audit WHERE datetime(created_at)>=datetime('now','-1 day')")
  ]);
  return {
    mode:'private-admin-control-plane-content-media-links-broadcast-audit',
    admins:adminIds(env).size,
    custom_settings:Number(settings?.n||0),
    active_broadcasts:Number(broadcasts?.n||0),
    admin_actions_24h:Number(audit?.n||0),
    maintenance:await getBooleanSetting(env,'system.maintenance',false)
  };
}

export const __test={ version:VERSION, isBotAdmin };
