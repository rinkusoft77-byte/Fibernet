import { CONTACTS, MEDIA, POPULAR_SERVICES, URLS } from './config.js';
import { getTariffs, syncOfficialSources } from './catalog.js';
import {
  addMessage, assignTicket, claimUpdate, cleanupUpdates, clearSession, closeTicket,
  createTicket, deliveryDone, deliveryFailed, enqueueDelivery, ensureV5Schema,
  getSession, getTicket, getTicketBySupportMessage, getUser, listQueue, listUserTickets,
  pendingDeliveries, releaseUpdate, saveProfile, sessionData, setLanguage, setRating,
  setSession, setStage, setSupportMessage, stats, upsertUser, updateTicketPhone
} from './v5-db.js';
import {
  accountingKeyboard, categoryMeta, classifyText, connectionKeyboard, departmentsKeyboard,
  departmentMeta, diagnosticText, homeKeyboard, infoBackKeyboard, L, languageKeyboard,
  normalizePhone, operatorKeyboard, operatorName, priorityFor, subscriberKeyboard, techKeyboard
} from './v6-ui.js';
import {
  answerCallback, contactKeyboard, copyMessage, editReplyMarkup, escapeHtml,
  inlineKeyboard, removeKeyboard, sendChatAction, sendMessage, sendPhoto
} from './telegram.js';

const VERSION='6.0.0';
const BOT_NAME='FiberNet Assistant';
const SECTION_MEDIA={
  connection:'https://www.fibernet.uz/wp-content/uploads/girls-connect.png',
  payment:'https://www.fibernet.uz/wp-content/uploads/girl-payment.png'
};

function supportChat(env,dept='general'){
  const specific={tech:env.TECH_CHAT_ID,accounting:env.ACCOUNTING_CHAT_ID,subscriber:env.SUBSCRIBER_CHAT_ID,connection:env.CONNECTION_CHAT_ID}[dept];
  return specific||env.SUPPORT_CHAT_ID||null;
}
function operatorChats(env){return [env.SUPPORT_CHAT_ID,env.TECH_CHAT_ID,env.ACCOUNTING_CHAT_ID,env.SUBSCRIBER_CHAT_ID,env.CONNECTION_CHAT_ID].filter(Boolean).map(String)}
function isOperatorChat(env,id){return operatorChats(env).includes(String(id))}
function nameOf(u){return [u?.first_name,u?.last_name].filter(Boolean).join(' ')||(u?.username?`@${u.username}`:String(u?.telegram_id||'—'))}
function fmt(v,lang='uz'){try{return new Intl.DateTimeFormat(lang==='ru'?'ru-RU':'uz-UZ',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(v))}catch{return String(v||'—')}}
function stageText(stage,lang){return ({new:L(lang,'Yangi','Новая'),in_progress:L(lang,'Jarayonda','В работе'),waiting_customer:L(lang,'Mijoz javobi kutilmoqda','Ожидается ответ клиента'),resolved:L(lang,'Hal qilindi','Решено'),closed:L(lang,'Yopilgan','Закрыто')})[stage]||stage||'—'}

async function card(env,chatId,photo,caption,replyMarkup){
  if(photo){try{await sendChatAction(env,chatId,'upload_photo');return await sendPhoto(env,chatId,photo,caption,{reply_markup:replyMarkup})}catch(e){console.warn('card photo fallback',String(e))}}
  return sendMessage(env,chatId,caption,{reply_markup:replyMarkup});
}

async function showHome(env,chatId,lang){
  const caption=L(lang,
    `⚡️ <b>${BOT_NAME}</b>\n\nFiberNet bo‘yicha kerakli ishlarning asosiy qismi <b>shu bot ichida</b>: texnik yordam, to‘lov savollari, abonent bo‘limi, ulanish, tariflar, TV va murojaatlar.\n\n✍️ Muammoni oddiy matn bilan ham yozishingiz mumkin — bot kerakli bo‘limga yo‘naltiradi.\n\n👇 Kerakli xizmatni tanlang:`,
    `⚡️ <b>${BOT_NAME}</b>\n\nОсновные вопросы FiberNet решаются <b>прямо в этом боте</b>: техподдержка, платежи, абонентский отдел, подключение, тарифы, ТВ и обращения.\n\n✍️ Можно просто написать проблему текстом — бот направит её в нужный отдел.\n\n👇 Выберите услугу:`);
  return card(env,chatId,MEDIA.homeBanner,caption,homeKeyboard(lang));
}

async function showAbout(env,chatId,lang){
  const text=L(lang,
    `ℹ️ <b>FiberNet haqida</b>\n\n🌐 FiberNet — NET TELEVISION internet provayderi.\n🔌 Ulanish uchun alohida ulanish haqi talab qilinmasligi rasmiy saytda ko‘rsatilgan.\n⚡ Optik tarmoq yuqori tezlik va barqaror aloqa uchun ishlatiladi.\n📡 Turli Wi‑Fi routerlar bilan ishlaydi.\n📺 FiberNet IPTV va interaktiv TV xizmatlarini taklif qiladi. TEZKOR tariflarida 170 ta TV kanal ko‘rsatilgan.\n🌐 Statik IP va boshqa qo‘shimcha xizmatlar mavjud.\n🛠 Texnik yordam — 24/7.\n\n🔐 Bot hech qachon shaxsiy kabinet parolingizni so‘ramaydi.`,
    `ℹ️ <b>О FiberNet</b>\n\n🌐 FiberNet — интернет-провайдер NET TELEVISION.\n🔌 На официальном сайте указано бесплатное подключение к сети FiberNet.\n⚡ Оптическая сеть используется для высокой скорости и стабильной связи.\n📡 Поддерживается широкий выбор Wi‑Fi роутеров.\n📺 FiberNet предлагает IPTV и интерактивное ТВ. В тарифах TEZKOR указано 170 телеканалов.\n🌐 Доступны статический IP и дополнительные услуги.\n🛠 Техподдержка работает 24/7.\n\n🔐 Бот никогда не запрашивает пароль от личного кабинета.`);
  return sendMessage(env,chatId,text,{reply_markup:infoBackKeyboard(lang)});
}

async function showTech(env,chatId,lang){
  const cap=L(lang,
    `🛠 <b>Texnik yordam</b>\n\nInternet, Wi‑Fi, ONU/router va IPTV muammolari. Muammo turini tanlang — bot tez tekshiruv beradi. Yoki <b>Operatorga yozish</b> tugmasini bosing va xabaringizni bir martada yuboring.`,
    `🛠 <b>Техподдержка</b>\n\nПроблемы с интернетом, Wi‑Fi, ONU/роутером и IPTV. Выберите проблему для быстрой диагностики или нажмите <b>Написать оператору</b>.`);
  return card(env,chatId,MEDIA.homeBanner,cap,techKeyboard(lang));
}

async function showAccounting(env,chatId,lang){
  const cap=L(lang,
    `💳 <b>Buxgalteriya</b>\n\nTo‘lov tushmagan, balans/qarzdorlik, hisob va hujjatlar bo‘yicha murojaatlar.\n\n📧 Moliyaviy savollar: <b>${CONTACTS.financeEmail}</b>\n✍️ Botdan yozsangiz, murojaat operator navbatiga tushadi.`,
    `💳 <b>Бухгалтерия</b>\n\nПлатёж не зачислен, баланс/задолженность, счета и документы.\n\n📧 Финансовые вопросы: <b>${CONTACTS.financeEmail}</b>\n✍️ Обращение из бота попадёт в очередь операторов.`);
  return card(env,chatId,SECTION_MEDIA.payment,cap,accountingKeyboard(lang));
}

async function showSubscriber(env,chatId,lang){
  const text=L(lang,
    `👥 <b>Abonent bo‘limi</b>\n\nTarifni o‘zgartirish, login/shartnoma, xizmatni vaqtincha to‘xtatish/faollashtirish, statik IP va boshqa abonent masalalari.\n\n✍️ Kerakli mavzuni tanlang yoki bo‘limga to‘g‘ridan-to‘g‘ri yozing.`,
    `👥 <b>Абонентский отдел</b>\n\nСмена тарифа, логин/договор, приостановка/активация услуги, статический IP и другие вопросы абонента.\n\n✍️ Выберите тему или напишите в отдел напрямую.`);
  return sendMessage(env,chatId,text,{reply_markup:subscriberKeyboard(lang)});
}

async function showConnection(env,chatId,lang){
  const cap=L(lang,
    `🔌 <b>Yangi ulanish</b>\n\nRasmiy FiberNet saytida ulanish bepul ekani ko‘rsatilgan. Yakuniy ulanish imkoniyati manzil va texnik sharoitga bog‘liq.\n\n✍️ <b>Ulanish uchun ariza</b> tugmasini bosing va manzil + telefon + savolingizni bitta xabarda yozing.`,
    `🔌 <b>Новое подключение</b>\n\nНа официальном сайте FiberNet указано бесплатное подключение. Финальная возможность зависит от адреса и технических условий.\n\n✍️ Нажмите <b>Заявка на подключение</b> и одним сообщением отправьте адрес + телефон + вопрос.`);
  return card(env,chatId,SECTION_MEDIA.connection,cap,connectionKeyboard(lang));
}

async function showTV(env,chatId,lang){
  const text=L(lang,
    `📺 <b>FiberNet TV / HopHop</b>\n\n• TEZKOR tariflarida <b>170 ta telekanal</b> ko‘rsatilgan.\n• HopHop web va mobil/Smart TV ilovalarida ishlaydi.\n• Kirish uchun shaxsiy kabinet logini va SMS orqali berilgan parol ishlatiladi.\n• Botda parol yubormang.\n\nAgar TV ishlamayotgan bo‘lsa, texnik yordamga xabar yuboring.`,
    `📺 <b>FiberNet TV / HopHop</b>\n\n• В тарифах TEZKOR указано <b>170 телеканалов</b>.\n• HopHop работает в web-версии и на мобильных/Smart TV устройствах.\n• Для входа используется логин личного кабинета и пароль, полученный по SMS.\n• Не отправляйте пароль в бот.\n\nЕсли ТВ не работает — отправьте обращение в техподдержку.`);
  return sendMessage(env,chatId,text,{reply_markup:inlineKeyboard([
    [{text:L(lang,'🛠 TV muammosi bo‘yicha yozish','🛠 Написать по проблеме ТВ'),callback_data:'quick:tech:iptv'}],
    [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
  ])});
}

async function showPaymentInfo(env,chatId,lang){
  return sendMessage(env,chatId,L(lang,
    `💳 <b>To‘lov bo‘yicha ma’lumot</b>\n\n• To‘lov tushmagan bo‘lsa, kvitansiya/chek va vaqtni saqlab qo‘ying.\n• Balans va tarif holati shaxsiy kabinetda ko‘rinadi.\n• Moliyaviy savollar: <b>${CONTACTS.financeEmail}</b>\n• Bot sizdan karta paroli yoki kabinet parolini so‘ramaydi.`,
    `💳 <b>Информация об оплате</b>\n\n• Если платёж не зачислен, сохраните чек и время оплаты.\n• Баланс и тариф отображаются в личном кабинете.\n• Финансовые вопросы: <b>${CONTACTS.financeEmail}</b>\n• Бот не запрашивает пароль карты или личного кабинета.`),{reply_markup:inlineKeyboard([
      [{text:L(lang,'💸 To‘lov tushmagan','💸 Платёж не зачислен'),callback_data:'quick:accounting:payment_missing'}],
      [{text:L(lang,'⬅️ Buxgalteriya','⬅️ Бухгалтерия'),callback_data:'home:accounting'}]
    ])});
}

async function showDepartments(env,chatId,lang){
  return sendMessage(env,chatId,L(lang,'🎫 <b>Murojaat yuborish</b>\n\nBo‘limni tanlang. Keyingi xabaringiz to‘g‘ridan-to‘g‘ri shu bo‘limga ticket bo‘lib ketadi.','🎫 <b>Отправить обращение</b>\n\nВыберите отдел. Следующее сообщение будет отправлено туда как заявка.'),{reply_markup:departmentsKeyboard(lang)});
}

async function startCompose(env,user,chatId,department,category='other'){
  const lang=user.language||'uz',d=departmentMeta(department,lang),c=categoryMeta(category,lang);
  await setSession(env,user.telegram_id,'compose',{department,category});
  return sendMessage(env,chatId,[`${d.icon} <b>${escapeHtml(d.title)}</b>`,` ${c.icon} ${escapeHtml(c.title)}`,'',L(lang,'✍️ Endi xabaringizni yuboring. Qisqa matn ham qabul qilinadi. Rasm/fayl/voice ham yuborishingiz mumkin.','✍️ Теперь отправьте сообщение. Можно коротко. Поддерживаются фото/файл/voice.'),'',user.phone?`📞 ${escapeHtml(user.phone)}`:L(lang,'ℹ️ Telefon majburiy emas. Ticket yuborilgandan keyin xohlasangiz raqam qo‘shishingiz mumkin.','ℹ️ Телефон не обязателен. Его можно добавить после отправки заявки.'),L(lang,'❌ Bekor qilish: /cancel','❌ Отмена: /cancel')].join('\n'),{reply_markup:removeKeyboard});
}

async function showProfile(env,chatId,user){
  const lang=user.language||'uz';
  return sendMessage(env,chatId,[`👤 <b>${L(lang,'Profilim','Мой профиль')}</b>`,'',`🙍 ${escapeHtml(nameOf(user))}`,`🔐 ${L(lang,'Login/shartnoma','Логин/договор')}: <code>${escapeHtml(user.account_login||'—')}</code>`,`📍 ${L(lang,'Manzil','Адрес')}: ${escapeHtml(user.address||'—')}`,`📞 ${L(lang,'Telefon','Телефон')}: <b>${escapeHtml(user.phone||'—')}</b>`,'',L(lang,'Profil majburiy emas. To‘ldirsangiz yangi ticketlarda ma’lumotlar avtomatik qo‘shiladi.','Профиль не обязателен. Если заполнить, данные автоматически попадут в новые заявки.')].join('\n'),{reply_markup:inlineKeyboard([
    [{text:L(lang,'✏️ Profilni tahrirlash','✏️ Изменить профиль'),callback_data:'profile:edit'}],
    [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
  ])});
}
async function startProfile(env,user,chatId){
  await setSession(env,user.telegram_id,'profile_account',{});
  return sendMessage(env,chatId,L(user.language||'uz','🔐 Login yoki shartnoma raqamini yuboring. Bilmasangiz <code>-</code>. Parol yubormang.','🔐 Отправьте логин или номер договора. Если не знаете — <code>-</code>. Пароль не отправляйте.'));
}

async function deliverTicket(env,no){
  const t=await getTicket(env,no);if(!t)return null;
  const u=await getUser(env,t.telegram_id),lang=u?.language||'uz',d=departmentMeta(t.department,lang),c=categoryMeta(t.category,lang);
  const preferred=supportChat(env,t.department);if(!preferred)throw new Error('No support chat configured');
  const p=t.priority==='critical'?'🚨':t.priority==='high'?'🔴':t.priority==='low'?'🟢':'🟡';
  const text=[`${p} <b>${escapeHtml(t.priority.toUpperCase())} · ${escapeHtml(no)}</b>`,'━━━━━━━━━━━━━━',`${d.icon} <b>${escapeHtml(d.title)}</b>`,`${c.icon} ${escapeHtml(c.title)}`,`👤 ${escapeHtml(nameOf(u))} · <code>${t.telegram_id}</code>`,u?.username?`🔗 @${escapeHtml(u.username)}`:null,t.account_login?`🔐 ${escapeHtml(t.account_login)}`:null,t.address?`📍 ${escapeHtml(t.address)}`:null,t.phone?`📞 ${escapeHtml(t.phone)}`:null,'',`📝 <b>${L(lang,'Murojaat','Обращение')}:</b>`,escapeHtml(t.description),'',`💬 <b>Reply</b> → ${L(lang,'mijozga bot orqali javob','ответ клиенту через бот')}`].filter(Boolean).join('\n');
  const candidates=[preferred];if(env.SUPPORT_CHAT_ID&&String(env.SUPPORT_CHAT_ID)!==String(preferred))candidates.push(env.SUPPORT_CHAT_ID);
  let lastErr=null;
  for(const chatId of candidates){
    try{const m=await sendMessage(env,chatId,text,{reply_markup:operatorKeyboard(no)});await setSupportMessage(env,no,chatId,m.message_id);await deliveryDone(env,no);return{chatId,messageId:m.message_id}}
    catch(e){lastErr=e}
  }
  throw lastErr||new Error('Delivery failed');
}
async function safeDeliver(env,no,msg=null){
  try{const x=await deliverTicket(env,no);if(x&&msg&&!msg.text&&(msg.photo||msg.document||msg.video||msg.voice||msg.audio)){try{await copyMessage(env,x.chatId,msg.chat.id,msg.message_id)}catch{}}return true}
  catch(e){await enqueueDelivery(env,no,e);console.error('ticket delivery queued',{no,error:String(e)});return false}
}
async function createFromMessage(env,user,data,msg,forcedText=null){
  const lang=user.language||'uz',body=String(forcedText??msg?.text??msg?.caption??'').trim(),media=Boolean(msg?.photo||msg?.document||msg?.video||msg?.voice||msg?.audio);
  if(!body&&!media)return null;
  const description=(body||L(lang,'Rasm/fayl yuborildi','Отправлено фото/файл')).slice(0,2500);
  const no=await createTicket(env,{telegramId:user.telegram_id,department:data.department||'general',category:data.category||'other',description,accountLogin:user.account_login,address:user.address,phone:user.phone,priority:priorityFor(data.category,description),telegramMessageId:msg?.message_id||null});
  await clearSession(env,user.telegram_id);
  const delivered=await safeDeliver(env,no,msg);
  return{no,delivered};
}
async function ticketSuccess(env,chatId,user,result){
  const lang=user.language||'uz',rows=[[{text:L(lang,'📂 Murojaatni ko‘rish','📂 Открыть обращение'),callback_data:`ticket:view:${result.no}`}]];
  if(!user.phone)rows.push([{text:L(lang,'📱 Telefon raqam qo‘shish','📱 Добавить телефон'),callback_data:`ticket:addphone:${result.no}`}]);
  rows.push([{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]);
  const status=result.delivered?L(lang,'✅ Operator navbatiga yuborildi.','✅ Отправлено в очередь операторов.'):L(lang,'🕓 Ticket saqlandi. Operatorga yetkazish navbatda — bot avtomatik qayta urinadi.','🕓 Заявка сохранена. Доставка оператору поставлена в очередь и будет повторена автоматически.');
  return sendMessage(env,chatId,L(lang,`✅ <b>Murojaat qabul qilindi</b>\n\n🎫 <code>${result.no}</code>\n${status}\n\nJavob shu botga keladi.`,`✅ <b>Обращение принято</b>\n\n🎫 <code>${result.no}</code>\n${status}\n\nОтвет придёт в этот бот.`),{reply_markup:inlineKeyboard(rows)});
}

async function showTariffMenu(env,chatId,lang){
  return sendMessage(env,chatId,L(lang,'📶 <b>Uy uchun tariflar</b>\n\nBot TEZKOR va OnLine tariflarini rasmiy FiberNet manbalaridan yangilab turadi. Seriyani tanlang:','📶 <b>Домашние тарифы</b>\n\nБот обновляет TEZKOR и OnLine из официальных источников FiberNet. Выберите серию:'),{reply_markup:inlineKeyboard([
    [{text:'⚡ TEZKOR',callback_data:'tariff:tezkor:0'},{text:'🌐 OnLine',callback_data:'tariff:online:0'}],
    [{text:L(lang,'✍️ Tarif bo‘yicha savol','✍️ Вопрос по тарифу'),callback_data:'quick:subscriber:tariff_change'}],
    [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
  ])});
}
async function showTariffs(env,chatId,lang,series,page=0){
  const items=await getTariffs(env,series),pp=4,pages=Math.max(1,Math.ceil(items.length/pp));page=Math.max(0,Math.min(Number(page)||0,pages-1));
  const body=items.slice(page*pp,page*pp+pp).map(x=>[
    `⚡ <b>${escapeHtml(x.name)}</b>`,`💳 ${Number(x.price||0).toLocaleString('ru-RU')} ${L(lang,'so‘m/oy','сум/мес')}`,
    `🌙 18:00–00:00 · <b>${escapeHtml(x.evening||'—')} Mbit/s</b>`,`☀️ 00:00–18:00 · <b>${escapeHtml(x.daytime||'—')} Mbit/s</b>`,
    x.tasix?`🇺🇿 TAS-IX · ${escapeHtml(x.tasix)} Mbit/s`:null,x.router?`📡 ${L(lang,'Router','Роутер')}: ${escapeHtml(x.router)}`:null,x.tv?`📺 TV · ${escapeHtml(x.tv)} ${L(lang,'kanal','каналов')}`:null
  ].filter(Boolean).join('\n')).join('\n\n');
  const nav=[];if(page>0)nav.push({text:'⬅️',callback_data:`tariff:${series}:${page-1}`});nav.push({text:`${page+1}/${pages}`,callback_data:'noop'});if(page<pages-1)nav.push({text:'➡️',callback_data:`tariff:${series}:${page+1}`});
  return sendMessage(env,chatId,`📶 <b>${series==='tezkor'?'TEZKOR':'OnLine'}</b>\n\n${body||'—'}`,{reply_markup:inlineKeyboard([
    nav,[{text:L(lang,'✍️ Shu tariflar bo‘yicha yozish','✍️ Написать по этим тарифам'),callback_data:'quick:subscriber:tariff_change'}],[{text:L(lang,'⬅️ Tariflar','⬅️ Тарифы'),callback_data:'home:tariffs'}]
  ])});
}

async function showServices(env,chatId,lang){
  const ru={'Wi‑Fi sozlash':'Настройка Wi‑Fi','Kompyuterda tarmoqni sozlash':'Настройка сети на компьютере','LAN sozlash':'Настройка LAN','Tarmoq uskunasi diagnostikasi':'Диагностика сетевого оборудования','IPTV sozlash':'Настройка IPTV','TV/pristavka sozlash':'Настройка ТВ/приставки','Router yetkazib berish':'Доставка роутера','Ustani chaqirish':'Вызов мастера'};
  const lines=POPULAR_SERVICES.map(([n,p])=>`• ${escapeHtml(lang==='ru'?(ru[n]||n):n)} — <b>${escapeHtml(p)}</b>`).join('\n');
  const text=`${L(lang,'🧰 <b>FiberNet xizmatlari</b>','🧰 <b>Услуги FiberNet</b>')}\n\n${L(lang,'Rasmiy sayt xizmatlari:','Услуги на официальном сайте:')}\n• 📺 IPTV / interaktiv TV\n• 🌐 ${L(lang,'Statik IP manzil','Статический IP-адрес')}\n• 🔒 ${L(lang,'Port blokirovkasi','Блокировка порта')}\n• 🔄 ${L(lang,'Tarif rejasini o‘zgartirish','Смена тарифного плана')}\n\n${L(lang,'Mashhur servislar:','Популярные сервисы:')}\n${lines}`;
  return sendMessage(env,chatId,text,{reply_markup:inlineKeyboard([
    [{text:L(lang,'✍️ Xizmat bo‘yicha yozish','✍️ Написать по услуге'),callback_data:'quick:subscriber:other'}],
    [{text:L(lang,'🌐 Statik IP bo‘yicha yozish','🌐 Написать по статическому IP'),callback_data:'quick:subscriber:static_ip'}],
    [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
  ])});
}
async function showPromo(env,chatId,lang){
  const cap=L(lang,'🎁 <b>FiberNet aksiyalari</b>\n\nAmaldagi aksiyalar bo‘yicha savolni botdan Abonent bo‘limiga yuborishingiz mumkin.','🎁 <b>Акции FiberNet</b>\n\nВопрос по действующим акциям можно отправить в абонентский отдел прямо из бота.');
  const kb=inlineKeyboard([[{text:L(lang,'✍️ Aksiya bo‘yicha yozish','✍️ Написать по акции'),callback_data:'quick:subscriber:other'}],[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]]);
  return card(env,chatId,lang==='ru'?MEDIA.promoRu:MEDIA.promoUz,cap,kb);
}
async function showContacts(env,chatId,lang){
  const text=[`☎️ <b>${L(lang,'FiberNet aloqa','Контакты FiberNet')}</b>`,'',`📞 <b>${CONTACTS.phone}</b>`,L(lang,'🛠 Texnik yordam: ichki 3 · 24/7','🛠 Техподдержка: доб. 3 · круглосуточно'),L(lang,'👥 Abonent bo‘limi: ichki 4 · Dush–Juma 09:00–18:00, Shanba 09:00–13:00','👥 Абонентский отдел: доб. 4 · Пн–Пт 09:00–18:00, Сб 09:00–13:00'),'',`🧑‍💻 ${CONTACTS.supportEmail}`,`📧 ${CONTACTS.infoEmail}`,`💳 ${CONTACTS.financeEmail}`,'',`📍 ${escapeHtml(lang==='ru'?CONTACTS.addressRu:CONTACTS.addressUz)}`].join('\n');
  return sendMessage(env,chatId,text,{reply_markup:inlineKeyboard([
    [{text:L(lang,'✍️ Bot orqali yozish','✍️ Написать через бот'),callback_data:'home:departments'}],
    [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
  ])});
}

async function showTickets(env,chatId,user){
  const lang=user.language||'uz',rows=await listUserTickets(env,user.telegram_id,12);
  if(!rows.length)return sendMessage(env,chatId,L(lang,'📭 Hali murojaatlaringiz yo‘q.','📭 У вас пока нет обращений.'),{reply_markup:homeKeyboard(lang)});
  const buttons=rows.map(x=>[{text:`${x.status==='closed'?'✅':x.stage==='waiting_customer'?'⏳':x.stage==='resolved'?'☑️':'🟡'} ${x.ticket_no} · ${stageText(x.stage,lang)}`,callback_data:`ticket:view:${x.ticket_no}`}]);
  buttons.push([{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]);
  return sendMessage(env,chatId,L(lang,'📂 <b>Murojaatlarim</b>\n\nHolatini ko‘rish uchun ticketni tanlang:','📂 <b>Мои обращения</b>\n\nВыберите заявку, чтобы посмотреть статус:'),{reply_markup:inlineKeyboard(buttons)});
}
async function showTicket(env,chatId,user,no){
  const t=await getTicket(env,no);if(!t||String(t.telegram_id)!==String(user.telegram_id))return;
  const lang=user.language||'uz',d=departmentMeta(t.department,lang),c=categoryMeta(t.category,lang),b=[];
  if(t.status==='open')b.push([{text:L(lang,'💬 Javob yozish','💬 Ответить'),callback_data:`ticket:reply:${no}`}]);
  if(!t.phone)b.push([{text:L(lang,'📱 Telefon qo‘shish','📱 Добавить телефон'),callback_data:`ticket:addphone:${no}`}]);
  b.push([{text:L(lang,'⬅️ Murojaatlarim','⬅️ Мои обращения'),callback_data:'home:tickets'}]);
  return sendMessage(env,chatId,[`🎫 <b>${escapeHtml(no)}</b>`,`${t.status==='closed'?'✅':'🟡'} <b>${escapeHtml(stageText(t.stage,lang))}</b>`,`${d.icon} ${escapeHtml(d.title)}`,`${c.icon} ${escapeHtml(c.title)}`,t.assigned_name?`👨‍💻 ${L(lang,'Operator','Оператор')}: ${escapeHtml(t.assigned_name)}`:null,t.phone?`📞 ${escapeHtml(t.phone)}`:null,`🕒 ${escapeHtml(fmt(t.created_at,lang))}`,'',`📝 ${escapeHtml(t.description)}`].filter(Boolean).join('\n'),{reply_markup:inlineKeyboard(b)});
}

async function handleSession(env,msg,user,s){
  if(!s)return false;const lang=user.language||'uz',d=sessionData(s);
  if(s.state==='compose'){
    const result=await createFromMessage(env,user,d,msg);
    if(!result){await sendMessage(env,msg.chat.id,L(lang,'✍️ Matn, rasm, fayl yoki voice yuboring.','✍️ Отправьте текст, фото, файл или voice.'));return true}
    await ticketSuccess(env,msg.chat.id,user,result);return true;
  }
  if(s.state==='profile_account'){
    if(!msg.text)return true;d.accountLogin=msg.text.trim()==='-'?null:msg.text.trim().slice(0,80);await setSession(env,user.telegram_id,'profile_address',d);await sendMessage(env,msg.chat.id,L(lang,'📍 Xizmat manzilingizni yozing:','📍 Укажите адрес услуги:'));return true;
  }
  if(s.state==='profile_address'){
    if(!msg.text?.trim())return true;d.address=msg.text.trim().slice(0,300);await setSession(env,user.telegram_id,'profile_phone',d);await sendMessage(env,msg.chat.id,L(lang,'📞 Telefonni yuboring yoki kontakt tugmasini bosing:','📞 Отправьте телефон или нажмите кнопку контакта:'),{reply_markup:contactKeyboard(L(lang,'📱 O‘z raqamim','📱 Мой номер'))});return true;
  }
  if(s.state==='profile_phone'){
    const p=normalizePhone(msg.contact?.phone_number||msg.text||'');if(!p){await sendMessage(env,msg.chat.id,L(lang,'⚠️ Raqamni qayta yuboring.','⚠️ Отправьте номер ещё раз.'),{reply_markup:contactKeyboard(L(lang,'📱 O‘z raqamim','📱 Мой номер'))});return true}
    d.phone=p;await saveProfile(env,user.telegram_id,d);await clearSession(env,user.telegram_id);await sendMessage(env,msg.chat.id,L(lang,'✅ Profil saqlandi.','✅ Профиль сохранён.'),{reply_markup:removeKeyboard});await showHome(env,msg.chat.id,lang);return true;
  }
  if(s.state==='ticket_phone'){
    const t=await getTicket(env,d.ticketNo);if(!t||String(t.telegram_id)!==String(user.telegram_id)){await clearSession(env,user.telegram_id);return true}
    const p=normalizePhone(msg.contact?.phone_number||msg.text||'');if(!p){await sendMessage(env,msg.chat.id,L(lang,'⚠️ Telefon raqamni qayta yuboring.','⚠️ Отправьте номер ещё раз.'),{reply_markup:contactKeyboard(L(lang,'📱 O‘z raqamim','📱 Мой номер'))});return true}
    await updateTicketPhone(env,t.ticket_no,user.telegram_id,p);await saveProfile(env,user.telegram_id,{accountLogin:user.account_login,address:user.address,phone:p});await clearSession(env,user.telegram_id);await sendMessage(env,msg.chat.id,L(lang,'✅ Telefon raqam ticketga qo‘shildi.','✅ Телефон добавлен к заявке.'),{reply_markup:removeKeyboard});return showTicket(env,msg.chat.id,await getUser(env,user.telegram_id),t.ticket_no);
  }
  if(s.state==='ticket_reply'){
    const t=await getTicket(env,d.ticketNo);if(!t||String(t.telegram_id)!==String(user.telegram_id)||t.status!=='open'){await clearSession(env,user.telegram_id);await sendMessage(env,msg.chat.id,L(lang,'⚠️ Ticket yopilgan yoki topilmadi.','⚠️ Заявка закрыта или не найдена.'));return true}
    const body=String(msg.text||msg.caption||'').trim(),chat=t.support_chat_id||supportChat(env,t.department),hasMedia=Boolean(msg.photo||msg.document||msg.video||msg.voice||msg.audio);
    if(!body&&!hasMedia){await sendMessage(env,msg.chat.id,L(lang,'✍️ Javob yuboring.','✍️ Отправьте ответ.'));return true}
    try{
      if(body)await sendMessage(env,chat,`💬 <b>${escapeHtml(t.ticket_no)} · mijoz</b>\n\n${escapeHtml(body)}`,t.support_message_id?{reply_to_message_id:t.support_message_id}:{});
      if(!msg.text&&hasMedia)await copyMessage(env,chat,msg.chat.id,msg.message_id);
      await addMessage(env,t.ticket_no,'user',user.telegram_id,body||'[attachment]',msg.message_id);await setStage(env,t.ticket_no,'in_progress');await clearSession(env,user.telegram_id);
      await sendMessage(env,msg.chat.id,L(lang,'✅ Javob operatorga yuborildi.','✅ Ответ отправлен оператору.'),{reply_markup:inlineKeyboard([[{text:L(lang,'🎫 Ticketni ko‘rish','🎫 Открыть заявку'),callback_data:`ticket:view:${t.ticket_no}`}],[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]])});
    }catch(e){await sendMessage(env,msg.chat.id,L(lang,'⚠️ Hozir yuborishda xato bo‘ldi. Xabarni yana yuboring.','⚠️ Ошибка отправки. Отправьте сообщение ещё раз.'))}
    return true;
  }
  return false;
}

async function privateMessage(env,msg){
  let user=await upsertUser(env,msg.from),text=String(msg.text||'').trim(),lang=user.language||'uz';
  if(text==='/start'){await clearSession(env,user.telegram_id);if(!user.language)return sendMessage(env,msg.chat.id,'🌐 <b>Tilni tanlang / Выберите язык</b>',{reply_markup:languageKeyboard()});return showHome(env,msg.chat.id,user.language)}
  if(text==='/cancel'){await clearSession(env,user.telegram_id);await sendMessage(env,msg.chat.id,L(lang,'❎ Amal bekor qilindi.','❎ Действие отменено.'),{reply_markup:removeKeyboard});return showHome(env,msg.chat.id,lang)}
  if(text==='/profile')return showProfile(env,msg.chat.id,user);
  if(text==='/tickets')return showTickets(env,msg.chat.id,user);
  if(text==='/language')return sendMessage(env,msg.chat.id,'🌐 <b>Til / Язык</b>',{reply_markup:languageKeyboard()});
  if(text==='/help')return sendMessage(env,msg.chat.id,L(lang,'ℹ️ <b>Yordam</b>\n\nMuammoni oddiy yozing: <i>internet yo‘q</i>, <i>to‘lov tushmadi</i>, <i>yangi ulanish kerak</i>. Bot uni kerakli bo‘limga yuboradi.\n\n/start — menyu\n/tickets — murojaatlar\n/profile — profil\n/cancel — joriy amalni bekor qilish','ℹ️ <b>Помощь</b>\n\nПросто напишите: <i>нет интернета</i>, <i>платёж не зачислен</i>, <i>нужно подключение</i>. Бот направит заявку в нужный отдел.\n\n/start — меню\n/tickets — обращения\n/profile — профиль\n/cancel — отмена'),{reply_markup:homeKeyboard(lang)});
  const s=await getSession(env,user.telegram_id);if(await handleSession(env,msg,user,s))return;
  if(!user.language)return sendMessage(env,msg.chat.id,'🌐 <b>Tilni tanlang / Выберите язык</b>',{reply_markup:languageKeyboard()});
  if(!text)return showHome(env,msg.chat.id,lang);
  const i=classifyText(text);
  if(i.action==='home')return showHome(env,msg.chat.id,lang);
  if(i.action==='tariffs')return showTariffMenu(env,msg.chat.id,lang);
  if(i.action==='contacts')return showContacts(env,msg.chat.id,lang);
  if(i.action==='tv')return showTV(env,msg.chat.id,lang);
  if(i.action==='services')return showServices(env,msg.chat.id,lang);
  const result=await createFromMessage(env,user,{department:i.department,category:i.category},msg,text);if(result)return ticketSuccess(env,msg.chat.id,user,result);
}

async function operatorMessage(env,msg){
  const text=String(msg.text||'').trim();let t=null;
  if(msg.reply_to_message?.message_id)t=await getTicketBySupportMessage(env,msg.chat.id,msg.reply_to_message.message_id);
  if(t&&t.status==='open'&&!text.startsWith('/')){
    const u=await getUser(env,t.telegram_id),lang=u?.language||'uz',body=String(msg.text||msg.caption||'').trim(),hasMedia=Boolean(msg.photo||msg.document||msg.video||msg.voice||msg.audio);
    if(body)await sendMessage(env,t.telegram_id,`👨‍💻 <b>FiberNet ${L(lang,'operatori','оператор')}</b>\n\n${escapeHtml(body)}`,{reply_markup:inlineKeyboard([[{text:L(lang,'💬 Javob yozish','💬 Ответить'),callback_data:`ticket:reply:${t.ticket_no}`} ]])});
    else if(hasMedia){try{await copyMessage(env,t.telegram_id,msg.chat.id,msg.message_id)}catch{}}
    await addMessage(env,t.ticket_no,'operator',msg.from.id,body||'[attachment]',msg.message_id);await assignTicket(env,t.ticket_no,{id:msg.from.id,name:operatorName(msg.from)});await setStage(env,t.ticket_no,'in_progress',{id:msg.from.id,name:operatorName(msg.from)});return;
  }
  if(text==='/queue'||text==='/tickets'){
    const r=await listQueue(env,30),body=r.length?r.map(x=>`${x.priority==='critical'?'🚨':x.priority==='high'?'🔴':x.priority==='low'?'🟢':'🟡'} <b>${escapeHtml(x.ticket_no)}</b> · ${escapeHtml(departmentMeta(x.department,'uz').title)} · ${escapeHtml(stageText(x.stage,'uz'))}\n${escapeHtml((x.description||'').slice(0,140))}`).join('\n\n'):'✅ Ochiq murojaat yo‘q.';
    return sendMessage(env,msg.chat.id,`📥 <b>FiberNet Operator Queue</b>\n\n${body}`);
  }
  if(text==='/stats'){const s=await stats(env);return sendMessage(env,msg.chat.id,`📊 <b>FiberNet Assistant v${VERSION}</b>\n\n📚 Total: <b>${s.total||0}</b>\n🟡 Open: <b>${s.open_count||0}</b>\n✅ Closed: <b>${s.closed_count||0}</b>`)}
  const close=text.match(/^\/close\s+(FN-[A-Z0-9-]+)$/i);if(close){const no=close[1].toUpperCase();if(await closeTicket(env,no)){const ticket=await getTicket(env,no),u=await getUser(env,ticket.telegram_id);await sendMessage(env,ticket.telegram_id,L(u?.language||'uz',`✅ Murojaat yopildi: <code>${no}</code>`,`✅ Обращение закрыто: <code>${no}</code>`),{reply_markup:homeKeyboard(u?.language||'uz')});return sendMessage(env,msg.chat.id,`✅ ${escapeHtml(no)} yopildi.`)}return sendMessage(env,msg.chat.id,'⚠️ Ticket topilmadi yoki yopilgan.')}
  const reply=text.match(/^\/reply\s+(FN-[A-Z0-9-]+)\s+([\s\S]+)$/i);if(reply){const no=reply[1].toUpperCase(),ticket=await getTicket(env,no);if(!ticket||ticket.status!=='open')return sendMessage(env,msg.chat.id,'⚠️ Ticket topilmadi yoki yopilgan.');const u=await getUser(env,ticket.telegram_id),body=reply[2].trim();await sendMessage(env,ticket.telegram_id,`👨‍💻 <b>FiberNet ${L(u?.language||'uz','operatori','оператор')}</b>\n\n${escapeHtml(body)}`);await addMessage(env,no,'operator',msg.from.id,body,msg.message_id);await assignTicket(env,no,{id:msg.from.id,name:operatorName(msg.from)});return sendMessage(env,msg.chat.id,`✅ ${escapeHtml(no)} ga yuborildi.`)}
  if(text==='/help'||text==='/admin')return sendMessage(env,msg.chat.id,'🛠 <b>FiberNet Operator</b>\n\n/queue — navbat\n/stats — statistika\n/close FN-... — yopish\n/reply FN-... matn — javob\n\nEng qulay usul: ticket xabariga Reply qiling.');
}

async function callback(env,q){
  try{await answerCallback(env,q.id)}catch{}
  let user=await upsertUser(env,q.from);const lang=user.language||'uz',data=q.data||'',chatId=q.message.chat.id;if(data==='noop')return;
  if(isOperatorChat(env,chatId)&&data.startsWith('op:')){
    const[,a,no]=data.split(':'),t=await getTicket(env,no);if(!t||t.status!=='open')return;const op={id:q.from.id,name:operatorName(q.from)};
    if(a==='claim'){await assignTicket(env,no,op);return sendMessage(env,chatId,`👨‍💻 ${escapeHtml(op.name)} · ${escapeHtml(no)} ni qabul qildi.`)}
    if(a==='wait'){await assignTicket(env,no,op);await setStage(env,no,'waiting_customer',op);const u=await getUser(env,t.telegram_id);return sendMessage(env,t.telegram_id,L(u?.language||'uz',`⏳ Operator <code>${no}</code> bo‘yicha javobingizni kutmoqda.`,`⏳ Оператор ждёт ваш ответ по <code>${no}</code>.`),{reply_markup:inlineKeyboard([[{text:L(u?.language||'uz','💬 Javob yozish','💬 Ответить'),callback_data:`ticket:reply:${no}`} ]])})}
    if(a==='resolve'){await assignTicket(env,no,op);await setStage(env,no,'resolved',op);const u=await getUser(env,t.telegram_id);return sendMessage(env,t.telegram_id,L(u?.language||'uz',`✅ <b>Muammo hal qilindi deb belgilandi</b>\n\n🎫 <code>${no}</code>`,`✅ <b>Обращение отмечено решённым</b>\n\n🎫 <code>${no}</code>`),{reply_markup:inlineKeyboard([[{text:'👍',callback_data:`feedback:${no}:1`},{text:'👎',callback_data:`feedback:${no}:0`}],[{text:L(u?.language||'uz','💬 Muammo davom etyapti','💬 Проблема осталась'),callback_data:`ticket:reply:${no}`} ]])})}
    if(a==='close'){if(await closeTicket(env,no)){const u=await getUser(env,t.telegram_id);await sendMessage(env,t.telegram_id,L(u?.language||'uz',`✅ Murojaat yopildi: <code>${no}</code>`,`✅ Обращение закрыто: <code>${no}</code>`),{reply_markup:homeKeyboard(u?.language||'uz')});try{await editReplyMarkup(env,chatId,q.message.message_id)}catch{}}return}
  }
  if(data.startsWith('lang:')){const n=data==='lang:ru'?'ru':'uz';await setLanguage(env,user.telegram_id,n);await clearSession(env,user.telegram_id);return showHome(env,chatId,n)}
  if(data==='home:main'){await clearSession(env,user.telegram_id);return showHome(env,chatId,lang)}
  if(data==='home:language')return sendMessage(env,chatId,'🌐 <b>Til / Язык</b>',{reply_markup:languageKeyboard()});
  if(data==='home:tech')return showTech(env,chatId,lang);
  if(data==='home:accounting')return showAccounting(env,chatId,lang);
  if(data==='home:subscriber')return showSubscriber(env,chatId,lang);
  if(data==='home:connection')return showConnection(env,chatId,lang);
  if(data==='home:departments')return showDepartments(env,chatId,lang);
  if(data==='home:profile')return showProfile(env,chatId,user);
  if(data==='home:tickets')return showTickets(env,chatId,user);
  if(data==='home:tariffs')return showTariffMenu(env,chatId,lang);
  if(data==='home:services')return showServices(env,chatId,lang);
  if(data==='home:promo')return showPromo(env,chatId,lang);
  if(data==='home:contacts')return showContacts(env,chatId,lang);
  if(data==='home:about')return showAbout(env,chatId,lang);
  if(data==='home:tv')return showTV(env,chatId,lang);
  if(data==='profile:edit')return startProfile(env,user,chatId);
  if(data==='info:payment')return showPaymentInfo(env,chatId,lang);
  if(data.startsWith('diag:')){
    const cat=data.slice(5);return sendMessage(env,chatId,diagnosticText(lang,cat),{reply_markup:inlineKeyboard([
      [{text:L(lang,'✍️ Operatorga yuborish','✍️ Отправить оператору'),callback_data:`quick:tech:${cat}`}],
      [{text:L(lang,'⬅️ Texnik yordam','⬅️ Техподдержка'),callback_data:'home:tech'}]
    ])});
  }
  if(data.startsWith('quick:')){const[,dept,cat='other']=data.split(':');return startCompose(env,user,chatId,dept,cat)}
  if(data.startsWith('tariff:')){const[,s,p]=data.split(':');return showTariffs(env,chatId,lang,s,Number(p))}
  if(data.startsWith('ticket:view:'))return showTicket(env,chatId,user,data.slice('ticket:view:'.length));
  if(data.startsWith('ticket:addphone:')){const no=data.slice('ticket:addphone:'.length),t=await getTicket(env,no);if(!t||String(t.telegram_id)!==String(user.telegram_id))return;await setSession(env,user.telegram_id,'ticket_phone',{ticketNo:no});return sendMessage(env,chatId,L(lang,'📞 Telefon raqamni yozing yoki kontakt tugmasini bosing:','📞 Отправьте номер или нажмите кнопку контакта:'),{reply_markup:contactKeyboard(L(lang,'📱 O‘z raqamim','📱 Мой номер'))})}
  if(data.startsWith('ticket:reply:')){const no=data.slice('ticket:reply:'.length),t=await getTicket(env,no);if(!t||String(t.telegram_id)!==String(user.telegram_id)||t.status!=='open')return;await setSession(env,user.telegram_id,'ticket_reply',{ticketNo:no});return sendMessage(env,chatId,L(lang,'💬 Javobingizni yozing yoki media yuboring:','💬 Напишите ответ или отправьте медиа:'))}
  if(data.startsWith('feedback:')){const[,no,r]=data.split(':'),t=await getTicket(env,no);if(!t||String(t.telegram_id)!==String(user.telegram_id))return;await setRating(env,no,user.telegram_id,Number(r));return sendMessage(env,chatId,L(lang,'💙 Rahmat! Bahoyingiz qabul qilindi.','💙 Спасибо! Оценка принята.'),{reply_markup:homeKeyboard(lang)})}
}

async function retryDeliveries(env){const rows=await pendingDeliveries(env,20);for(const x of rows){try{await deliverTicket(env,x.ticket_no);await deliveryDone(env,x.ticket_no)}catch(e){await deliveryFailed(env,x.ticket_no,e)}}}
async function processUpdate(env,u){if(!await claimUpdate(env,u.update_id))return;try{if(u.callback_query)await callback(env,u.callback_query);else if(u.message){if(u.message.chat?.type==='private')await privateMessage(env,u.message);else if(isOperatorChat(env,u.message.chat?.id))await operatorMessage(env,u.message)}}catch(e){await releaseUpdate(env,u.update_id);throw e}}
async function webhook(req,env){if(!env.TELEGRAM_WEBHOOK_SECRET||req.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.TELEGRAM_WEBHOOK_SECRET)return new Response('Unauthorized',{status:401});let u;try{u=await req.json()}catch{return new Response('Bad Request',{status:400})}if(!Number.isInteger(u.update_id))return new Response('ok');await ensureV5Schema(env);await processUpdate(env,u);return new Response('ok')}

export default {
  async fetch(req,env){
    const url=new URL(req.url);
    if(req.method==='POST'&&url.pathname==='/telegram/webhook'){try{return await webhook(req,env)}catch(e){console.error('FiberNet v6 webhook error',{error:String(e),stack:e?.stack});return new Response('Retry',{status:500})}}
    if(req.method==='GET'&&url.pathname==='/health'){try{await ensureV5Schema(env);return Response.json({ok:true,service:'fibernet-bot',version:VERSION,mode:'professional-portal',stats:await stats(env),supportConfigured:Boolean(env.SUPPORT_CHAT_ID)})}catch(e){return Response.json({ok:false,version:VERSION,error:String(e)},{status:503})}}
    if(url.pathname==='/')return new Response(`FiberNet Assistant v${VERSION} is running.`);
    return new Response('Not found',{status:404});
  },
  async scheduled(controller,env,ctx){ctx.waitUntil((async()=>{try{await ensureV5Schema(env);await cleanupUpdates(env);await retryDeliveries(env)}catch(e){console.error('v6 maintenance',String(e))}if(controller?.cron==='15 23 * * *'){try{await syncOfficialSources(env)}catch(e){console.error('v6 sync',String(e))}}})())}
};

export const __test={normalizePhone,classifyText,priorityFor};
