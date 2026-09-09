import { CONTACTS, MEDIA, POPULAR_SERVICES } from './config.js';
import { getTariffs, syncOfficialSources } from './catalog.js';
import {
  addMessage, assignTicket, cleanupUpdates, clearSession, closeTicket, createTicket,
  deliveryDone, deliveryFailed, enqueueDelivery, ensureV5Schema, getSession, getTicket,
  getTicketBySupportMessage, getUser, listQueue, listUserTickets, pendingDeliveries,
  saveProfile, sessionData, setLanguage, setRating, setSession, setStage,
  setSupportMessage, stats, upsertUser
} from './v5-db.js';
import {
  accountingIssuesKeyboard, categoryMeta, classifyText, connectionIssuesKeyboard,
  customerTypeKeyboard, departmentsKeyboard, departmentMeta, diagnosticKeyboard,
  entityTypeLabel, homeKeyboard, identifierChoiceKeyboard, L, languageKeyboard,
  normalizePhone, operatorKeyboard, operatorName, priorityFor, subscriberIssuesKeyboard,
  techIssuesKeyboard
} from './v8-ui.js';
import {
  answerCallback, contactKeyboard, copyMessage, editReplyMarkup, escapeHtml,
  inlineKeyboard, removeKeyboard, sendChatAction, sendMessage, sendPhoto
} from './telegram.js';
import {
  bindDepartment, claimV7Update, cleanupOperatorReplySessions, cleanupV7Updates,
  clearOperatorReplySession, DEPARTMENTS, ensureV7Routing, getDepartmentByChat,
  getDepartmentChat, getOperatorReplySession, listDepartmentChats, releaseV7Update,
  setOperatorReplySession, unbindDepartment
} from './v7-routing.js';

const VERSION = '8.0.0';
const BOT_NAME = 'FiberNet Assistant';
const ENV_CHAT_KEYS = {
  general: 'SUPPORT_CHAT_ID', tech: 'TECH_CHAT_ID', accounting: 'ACCOUNTING_CHAT_ID',
  subscriber: 'SUBSCRIBER_CHAT_ID', connection: 'CONNECTION_CHAT_ID'
};
const SECTION_MEDIA = {
  tech: MEDIA.homeBanner,
  accounting: 'https://www.fibernet.uz/wp-content/uploads/girl-payment.png',
  subscriber: MEDIA.homeBanner,
  connection: 'https://www.fibernet.uz/wp-content/uploads/girls-connect.png'
};

function adminIds(env) { return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String); }
function isAdmin(env, id) { return adminIds(env).includes(String(id)); }
function isGroupChat(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
function isPrivateChat(chat) { return chat?.type === 'private'; }
function nameOf(u) { return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : String(u?.telegram_id || '—')); }
function fmt(v, lang='uz') { try { return new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'uz-UZ', { timeZone:'Asia/Tashkent', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(new Date(v)); } catch { return String(v || '—'); } }
function stageText(s, lang='uz') { return ({new:L(lang,'Yangi','Новая'),in_progress:L(lang,'Jarayonda','В работе'),waiting_customer:L(lang,'Mijoz javobi kutilmoqda','Ожидается ответ клиента'),resolved:L(lang,'Hal qilindi','Решено'),closed:L(lang,'Yopilgan','Закрыто')})[s] || s || '—'; }

async function card(env, chatId, photo, caption, keyboard) {
  if (photo) {
    try { await sendChatAction(env, chatId, 'upload_photo'); return await sendPhoto(env, chatId, photo, caption, { reply_markup: keyboard }); }
    catch (e) { console.warn('photo fallback', String(e)); }
  }
  return sendMessage(env, chatId, caption, { reply_markup: keyboard });
}

function issuePhoto(department, category) {
  if (department === 'accounting') return SECTION_MEDIA.accounting;
  if (department === 'connection') return SECTION_MEDIA.connection;
  return SECTION_MEDIA.tech;
}

function diagnosticText(lang, department, type, category) {
  const c = categoryMeta(category, lang);
  const who = type && type !== 'none' ? `\n👤 <b>${escapeHtml(entityTypeLabel(type, lang))}</b>\n` : '';
  const map = {
    no_internet: L(lang,
      '1️⃣ ONU/ONT va routerni 60 soniyaga o‘chirib yoqing.\n2️⃣ ONU’da <b>LOS qizil</b> bo‘lsa optik kabelni bukmang/ajratmang.\n3️⃣ PON/WAN/Ethernet indikatorlarini tekshiring.\n4️⃣ Balans va tarif holatini kabinetdan tekshiring.\n\nAgar internet qaytmasa, pastdagi operator tugmasini bosing.',
      '1️⃣ Выключите ONU/ONT и роутер на 60 секунд.\n2️⃣ Если <b>LOS красный</b>, не сгибайте и не отключайте оптику.\n3️⃣ Проверьте PON/WAN/Ethernet.\n4️⃣ Проверьте баланс и тариф в кабинете.\n\nЕсли интернет не появился — нажмите кнопку оператора.'),
    slow: L(lang,
      '1️⃣ Tezlikni imkon bo‘lsa kabel orqali tekshiring.\n2️⃣ Fon yuklamalarini to‘xtating.\n3️⃣ Wi‑Fi’da router yonida 5 GHz bilan sinang.\n4️⃣ ONU/router qayta yoqilgach testni takrorlang.\n\nNatija o‘zgarmasa operatorga murojaat qiling.',
      '1️⃣ По возможности измерьте скорость по кабелю.\n2️⃣ Остановите фоновые загрузки.\n3️⃣ Рядом с роутером проверьте 5 GHz.\n4️⃣ Перезагрузите ONU/роутер и повторите тест.\n\nЕсли не помогло — обратитесь к оператору.'),
    wifi: L(lang,
      '1️⃣ Avval internet kabel orqali ishlashini tekshiring.\n2️⃣ 5 GHz — tezroq, 2.4 GHz — uzoqroq masofa uchun.\n3️⃣ Routerni ochiq va balandroq joyga qo‘ying.\n4️⃣ Wi‑Fi’ni telefonda unutib, qayta ulang.\n\nUzilish davom etsa operatorga murojaat qiling.',
      '1️⃣ Сначала проверьте интернет по кабелю.\n2️⃣ 5 GHz быстрее, 2.4 GHz лучше на расстоянии.\n3️⃣ Поставьте роутер выше и открыто.\n4️⃣ Забудьте Wi‑Fi на телефоне и подключитесь заново.\n\nЕсли обрывы остаются — обратитесь к оператору.'),
    iptv: L(lang,
      '1️⃣ Internet ishlayotganini tekshiring.\n2️⃣ Router va TV/pristavkani qayta yoqing.\n3️⃣ HopHop ilovasini yopib qayta oching.\n4️⃣ Muammo bitta kanalmi yoki barcha kanallardami tekshiring.\n\nMuammo qolsa texnik operatorga yuboring.',
      '1️⃣ Проверьте интернет.\n2️⃣ Перезагрузите роутер и ТВ/приставку.\n3️⃣ Перезапустите HopHop.\n4️⃣ Проверьте: проблема на одном канале или на всех.\n\nЕсли проблема осталась — отправьте в техподдержку.'),
    equipment: L(lang,
      '1️⃣ ONU/router quvvatini tekshiring.\n2️⃣ PON odatda barqaror, LOS esa qizil yonmasligi kerak.\n3️⃣ WAN/LAN kabellarini qayta mahkam ulang.\n4️⃣ Qurilma juda qizib ketmaganini tekshiring.\n\nQizil LOS yoki qurilma yoqilmasa operatorga yuboring.',
      '1️⃣ Проверьте питание ONU/роутера.\n2️⃣ PON должен быть стабильным, LOS не должен гореть красным.\n3️⃣ Переподключите WAN/LAN.\n4️⃣ Проверьте перегрев.\n\nПри красном LOS или если устройство не включается — оператор.'),
    lan: L(lang,
      '1️⃣ Kabel ikkala tomonda mahkam ulanganini tekshiring.\n2️⃣ Boshqa LAN portni sinang.\n3️⃣ Windows’da Ethernet adapter yoqilganini tekshiring.\n4️⃣ Iloji bo‘lsa boshqa kabel bilan sinang.\n\nLink chiqmasa operatorga murojaat qiling.',
      '1️⃣ Проверьте кабель с обеих сторон.\n2️⃣ Попробуйте другой LAN-порт.\n3️⃣ Убедитесь, что Ethernet-адаптер включён.\n4️⃣ Попробуйте другой кабель.\n\nЕсли link не появляется — обратитесь к оператору.'),
    payment_missing: L(lang,
      '1️⃣ To‘lov cheki/kvitansiyasini saqlang.\n2️⃣ To‘lovdagi abonent loginini tekshiring.\n3️⃣ Summani va to‘lov vaqtini tekshiring.\n4️⃣ Kabinetda balans yangilanganini tekshiring.\n\nHali tushmagan bo‘lsa Buxgalteriyaga yuboring.',
      '1️⃣ Сохраните чек.\n2️⃣ Проверьте абонентский логин в платеже.\n3️⃣ Проверьте сумму и время оплаты.\n4️⃣ Проверьте баланс в кабинете.\n\nЕсли платёж не появился — отправьте в бухгалтерию.'),
    balance: L(lang,
      'Balans va qarzdorlikning aniq qiymati billing tizimidan olinadi. Bot parol so‘ramaydi. Kabinetdagi ma’lumot mos kelmasa, pastdagi tugma orqali Buxgalteriyaga murojaat yuboring.',
      'Точный баланс и задолженность берутся из биллинга. Бот не запрашивает пароль. Если данные кабинета не совпадают — отправьте обращение в бухгалтерию.'),
    documents: L(lang,
      'Hisob, akt, kvitansiya yoki boshqa moliyaviy hujjat kerak bo‘lsa, qaysi abonent/shartnoma bo‘yicha ekanini tayyorlab qo‘ying. Pastdagi tugma orqali Buxgalteriyaga yuboring.',
      'Если нужен счёт, акт, квитанция или другой финансовый документ, подготовьте логин/договор и отправьте запрос в бухгалтерию.'),
    tariff_change: L(lang,
      '1️⃣ Kerakli yangi tarifni Tariflar bo‘limida ko‘ring.\n2️⃣ Login/shartnoma raqamini tayyorlang.\n3️⃣ O‘zgarish shartlarini operator tasdiqlaydi.\n\nDavom ettirish uchun operator tugmasini bosing.',
      '1️⃣ Выберите новый тариф в разделе Тарифы.\n2️⃣ Подготовьте логин/договор.\n3️⃣ Условия смены подтвердит оператор.\n\nДля продолжения нажмите кнопку оператора.'),
    account_data: L(lang,
      'Login yoki shartnoma bo‘yicha savolda parol yubormang. Abonentni topish uchun login/shartnoma yoki xizmat manzili yetarli. Operatorga yuborish uchun pastdagi tugmani bosing.',
      'Не отправляйте пароль. Для поиска абонента достаточно логина/договора или адреса услуги. Нажмите кнопку оператора.'),
    suspension: L(lang,
      'Xizmatni vaqtincha to‘xtatish yoki qayta faollashtirish shartlarini operator tekshiradi. Login/shartnoma yoki xizmat manzilini tayyorlang.',
      'Условия приостановки/активации проверит оператор. Подготовьте логин/договор или адрес услуги.'),
    static_ip: L(lang,
      'Statik IP mavjudligi, narxi va texnik shartlari abonent turiga va xizmatga bog‘liq bo‘lishi mumkin. Operator abonent ma’lumotlari bo‘yicha tekshiradi.',
      'Доступность, стоимость и условия статического IP могут зависеть от услуги и типа клиента. Оператор проверит по данным абонента.'),
    legal_docs: L(lang,
      'Yuridik shaxslar uchun shartnoma, rekvizitlar, hisob/akt va xizmat hujjatlari bo‘yicha Abonent bo‘limi tekshiradi. Login/shartnoma yoki xizmat manzilini tayyorlang.',
      'Для юрлиц вопросы договора, реквизитов, актов и документов проверяет абонентский отдел. Подготовьте логин/договор или адрес.'),
    connection: L(lang,
      'Yangi ulanish uchun eng muhim ma’lumot — aniq manzil. Texnik imkoniyat manzil bo‘yicha tekshiriladi. Pastdagi operator tugmasini bosing, keyin manzilni yuboring.',
      'Для нового подключения нужен точный адрес. Техническая возможность проверяется по адресу. Нажмите кнопку оператора и отправьте адрес.'),
    coverage: L(lang,
      'FiberNet ulanish imkoniyati aniq manzil bo‘yicha tekshiriladi. Ko‘cha, uy va imkon bo‘lsa xonadon/ofis raqamini tayyorlang.',
      'Возможность подключения FiberNet проверяется по точному адресу. Подготовьте улицу, дом и при наличии квартиру/офис.'),
    other: L(lang,
      'Bu masala uchun tayyor avtomatik yechim yo‘q. Pastdagi operator tugmasini bosing. Avval login/shartnoma yoki manzil so‘raladi, keyin muammoni bir gapda yozasiz.',
      'Для этого вопроса нет готового автоматического решения. Нажмите кнопку оператора: сначала укажете логин/договор или адрес, затем кратко опишете вопрос.')
  };
  return `${c.icon} <b>${escapeHtml(c.title)}</b>${who}\n${map[category] || map.other}`;
}

async function showHome(env, chatId, lang) {
  const caption = L(lang,
    `⚡️ <b>${BOT_NAME}</b>\n\nFiberNet xizmatlari bir joyda. Avval <b>Bo‘limlar</b>ga kiring, muammo turini tanlang va bot ko‘rsatgan tekshiruvlarni bajaring. Faqat yechim bo‘lmasa operatorga murojaat ochiladi.\n\n👇 Kerakli bo‘limni tanlang:`,
    `⚡️ <b>${BOT_NAME}</b>\n\nСервисы FiberNet в одном месте. Откройте <b>Отделы</b>, выберите проблему и выполните подсказки. Обращение оператору открывается только если решение не помогло.\n\n👇 Выберите раздел:`);
  return card(env, chatId, MEDIA.homeBanner, caption, homeKeyboard(lang));
}

function showDepartments(env, chatId, lang) {
  return sendMessage(env, chatId, L(lang,
    '🏢 <b>FiberNet bo‘limlari</b>\n\nMuammo yoki xizmat turiga mos bo‘limni tanlang:',
    '🏢 <b>Отделы FiberNet</b>\n\nВыберите отдел по типу вопроса:'), { reply_markup: departmentsKeyboard(lang) });
}

function showDepartment(env, chatId, lang, department, suggested='other') {
  if (department === 'tech') return sendMessage(env, chatId, L(lang, '🛠 <b>Texnik yordam</b>\n\nAvval mijoz turini tanlang:', '🛠 <b>Техподдержка</b>\n\nСначала выберите тип клиента:'), { reply_markup: customerTypeKeyboard('tech', lang, suggested) });
  if (department === 'subscriber') return sendMessage(env, chatId, L(lang, '👥 <b>Abonent bo‘limi</b>\n\nAvval mijoz turini tanlang:', '👥 <b>Абонентский отдел</b>\n\nСначала выберите тип клиента:'), { reply_markup: customerTypeKeyboard('subscriber', lang, suggested) });
  if (department === 'accounting') return card(env, chatId, SECTION_MEDIA.accounting, L(lang, '💳 <b>Buxgalteriya</b>\n\nMuammo turini tanlang:', '💳 <b>Бухгалтерия</b>\n\nВыберите вопрос:'), accountingIssuesKeyboard(lang));
  if (department === 'connection') return card(env, chatId, SECTION_MEDIA.connection, L(lang, '🔌 <b>Ulanish bo‘limi</b>\n\nKerakli xizmatni tanlang:', '🔌 <b>Отдел подключений</b>\n\nВыберите услугу:'), connectionIssuesKeyboard(lang));
  return showDepartments(env, chatId, lang);
}

function showTypeIssues(env, chatId, lang, department, type, suggested='other') {
  const typeText = entityTypeLabel(type, lang);
  if (department === 'tech') {
    if (suggested !== 'other') return showIssue(env, chatId, lang, department, type, suggested);
    return sendMessage(env, chatId, `🛠 <b>${L(lang,'Texnik yordam','Техподдержка')}</b>\n👤 ${escapeHtml(typeText)}\n\n${L(lang,'Muammo turini tanlang:','Выберите проблему:')}`, { reply_markup: techIssuesKeyboard(type, lang) });
  }
  if (department === 'subscriber') {
    if (suggested !== 'other') return showIssue(env, chatId, lang, department, type, suggested);
    return sendMessage(env, chatId, `👥 <b>${L(lang,'Abonent bo‘limi','Абонентский отдел')}</b>\n👤 ${escapeHtml(typeText)}\n\n${L(lang,'Masalani tanlang:','Выберите вопрос:')}`, { reply_markup: subscriberIssuesKeyboard(type, lang) });
  }
}

async function showIssue(env, chatId, lang, department, type, category) {
  return card(env, chatId, issuePhoto(department, category), diagnosticText(lang, department, type, category), diagnosticKeyboard(department, type, category, lang));
}

async function showTariffMenu(env, chatId, lang) {
  return sendMessage(env, chatId, L(lang, '📶 <b>Tariflar</b>\n\nTarif seriyasini tanlang:', '📶 <b>Тарифы</b>\n\nВыберите серию:'), { reply_markup: inlineKeyboard([
    [{ text:'⚡ TEZKOR', callback_data:'tariff:tezkor:0' }, { text:'🌐 OnLine', callback_data:'tariff:online:0' }],
    [{ text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'), callback_data:'home:main' }]
  ]) });
}

async function showTariffs(env, chatId, lang, series, page=0) {
  const items = await getTariffs(env, series); const pp=4; const pages=Math.max(1,Math.ceil(items.length/pp));
  page=Math.max(0,Math.min(Number(page)||0,pages-1));
  const body=items.slice(page*pp,page*pp+pp).map(x=>[
    `⚡ <b>${escapeHtml(x.name)}</b>`, `💳 ${Number(x.price||0).toLocaleString('ru-RU')} ${L(lang,'so‘m/oy','сум/мес')}`,
    `🌙 ${escapeHtml(x.evening||'—')} Mbit/s`, `☀️ ${escapeHtml(x.daytime||'—')} Mbit/s`, x.tv?`📺 ${escapeHtml(x.tv)}+`:null
  ].filter(Boolean).join('\n')).join('\n\n');
  const nav=[]; if(page>0)nav.push({text:'⬅️',callback_data:`tariff:${series}:${page-1}`}); nav.push({text:`${page+1}/${pages}`,callback_data:'noop'}); if(page<pages-1)nav.push({text:'➡️',callback_data:`tariff:${series}:${page+1}`});
  return sendMessage(env, chatId, `📶 <b>${series==='tezkor'?'TEZKOR':'OnLine'}</b>\n\n${body||'—'}`, { reply_markup:inlineKeyboard([nav,[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]]) });
}

function showTV(env, chatId, lang) {
  return sendMessage(env, chatId, L(lang,
    '📺 <b>HopHop TV</b>\n\nFiberNet interaktiv TV xizmati. TEZKOR tariflarida 170+ kanal ko‘rsatilgan. TV ishlamasa: 🏢 Bo‘limlar → 🛠 Texnik yordam → mijoz turi → 📺 IPTV/HopHop yo‘lidan kiring.',
    '📺 <b>HopHop TV</b>\n\nИнтерактивное ТВ FiberNet. В тарифах TEZKOR указано 170+ каналов. Если ТВ не работает: 🏢 Отделы → 🛠 Техподдержка → тип клиента → 📺 IPTV/HopHop.'), { reply_markup:inlineKeyboard([[{text:L(lang,'🏢 Bo‘limlar','🏢 Отделы'),callback_data:'home:departments'}],[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]]) });
}

function showAbout(env, chatId, lang) {
  return sendMessage(env, chatId, L(lang,
    'ℹ️ <b>FiberNet / NET TELEVISION</b>\n\n🌐 Optik internet\n📺 IPTV / HopHop TV\n📶 TEZKOR va OnLine tariflari\n🛠 Texnik yordam\n💳 Buxgalteriya\n👥 Abonent bo‘limi\n🔌 Yangi ulanish\n\n🔐 Bot hech qachon kabinet parolini so‘ramaydi.',
    'ℹ️ <b>FiberNet / NET TELEVISION</b>\n\n🌐 Оптический интернет\n📺 IPTV / HopHop TV\n📶 Тарифы TEZKOR и OnLine\n🛠 Техподдержка\n💳 Бухгалтерия\n👥 Абонентский отдел\n🔌 Подключение\n\n🔐 Бот никогда не запрашивает пароль кабинета.'), { reply_markup:homeKeyboard(lang) });
}

function showContacts(env, chatId, lang) {
  return sendMessage(env, chatId, [`☎️ <b>${L(lang,'FiberNet aloqa','Контакты FiberNet')}</b>`,'',`📞 <b>${CONTACTS.phone}</b>`,`🧑‍💻 ${CONTACTS.supportEmail}`,`📧 ${CONTACTS.infoEmail}`,`💳 ${CONTACTS.financeEmail}`,`📍 ${escapeHtml(lang==='ru'?CONTACTS.addressRu:CONTACTS.addressUz)}`].join('\n'), { reply_markup:homeKeyboard(lang) });
}

async function showPromo(env, chatId, lang) {
  const cap=L(lang,'🎁 <b>FiberNet aksiyalari</b>\n\nAmaldagi aksiya ma’lumotlari. Savol bo‘lsa Bo‘limlar → Abonent bo‘limi orqali kerakli mavzuni tanlang.','🎁 <b>Акции FiberNet</b>\n\nИнформация об акциях. Для вопроса: Отделы → Абонентский отдел.');
  return card(env,chatId,lang==='ru'?MEDIA.promoRu:MEDIA.promoUz,cap,inlineKeyboard([[{text:L(lang,'🏢 Bo‘limlar','🏢 Отделы'),callback_data:'home:departments'}],[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]]));
}

async function showProfile(env, chatId, user) {
  const lang=user.language||'uz';
  return sendMessage(env,chatId,[`👤 <b>${L(lang,'Profilim','Мой профиль')}</b>`,'',`🙍 ${escapeHtml(nameOf(user))}`,`🔐 ${escapeHtml(user.account_login||'—')}`,`📍 ${escapeHtml(user.address||'—')}`,`📞 ${escapeHtml(user.phone||'—')}`].join('\n'),{reply_markup:inlineKeyboard([[{text:L(lang,'✏️ Profilni tahrirlash','✏️ Изменить профиль'),callback_data:'profile:edit'}],[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]])});
}

async function startProfile(env,user,chatId){await setSession(env,user.telegram_id,'profile_account',{});return sendMessage(env,chatId,L(user.language||'uz','🔐 Login/shartnoma raqamini yuboring. Bilmasangiz <code>-</code>.','🔐 Отправьте логин/номер договора. Если не знаете — <code>-</code>.'));}

async function showTickets(env,chatId,user){
  const lang=user.language||'uz',rows=await listUserTickets(env,user.telegram_id,12);
  if(!rows.length)return sendMessage(env,chatId,L(lang,'📭 Hali murojaat yo‘q.','📭 Обращений пока нет.'),{reply_markup:homeKeyboard(lang)});
  const b=rows.map(x=>[{text:`${x.status==='closed'?'✅':x.stage==='waiting_customer'?'⏳':'🟡'} ${x.ticket_no}`,callback_data:`ticket:view:${x.ticket_no}`}]);
  b.push([{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]);
  return sendMessage(env,chatId,L(lang,'📂 <b>Murojaatlarim</b>','📂 <b>Мои обращения</b>'),{reply_markup:inlineKeyboard(b)});
}

async function showTicket(env,chatId,user,no){
  const t=await getTicket(env,no); if(!t||String(t.telegram_id)!==String(user.telegram_id))return;
  const lang=user.language||'uz',d=departmentMeta(t.department,lang),c=categoryMeta(t.category,lang),b=[];
  if(t.status==='open')b.push([{text:L(lang,'💬 Operatorga javob yozish','💬 Ответить оператору'),callback_data:`ticket:reply:${no}`}]);
  b.push([{text:L(lang,'⬅️ Murojaatlarim','⬅️ Мои обращения'),callback_data:'home:tickets'}]);
  return sendMessage(env,chatId,[`🎫 <b>${escapeHtml(no)}</b>`,`📌 ${escapeHtml(stageText(t.stage,lang))}`,`${d.icon} ${escapeHtml(d.title)}`,`${c.icon} ${escapeHtml(c.title)}`,t.assigned_name?`👨‍💻 ${escapeHtml(t.assigned_name)}`:null,`🕒 ${escapeHtml(fmt(t.created_at,lang))}`,'',`📝 ${escapeHtml(t.description)}`].filter(Boolean).join('\n'),{reply_markup:inlineKeyboard(b)});
}

function userTicketKeyboard(lang,no){return inlineKeyboard([[{text:L(lang,'💬 Operatorga javob','💬 Ответить оператору'),callback_data:`ticket:reply:${no}`}],[{text:L(lang,'📂 Murojaatlarim','📂 Мои обращения'),callback_data:'home:tickets'}]]);}
function resolvedKeyboard(lang,no){return inlineKeyboard([[{text:'👍',callback_data:`feedback:${no}:1`},{text:'👎',callback_data:`feedback:${no}:0`}],[{text:L(lang,'💬 Muammo davom etyapti','💬 Проблема осталась'),callback_data:`ticket:reply:${no}`}]]);}

async function resolveDepartmentChat(env,department){const bound=await getDepartmentChat(env,department);if(bound?.chat_id)return{chatId:bound.chat_id,title:bound.title||null};const k=ENV_CHAT_KEYS[department]||'SUPPORT_CHAT_ID';if(env[k])return{chatId:env[k],title:k};if(env.SUPPORT_CHAT_ID)return{chatId:env.SUPPORT_CHAT_ID,title:'SUPPORT_CHAT_ID'};return null;}

async function deliverTicket(env,no){
  const t=await getTicket(env,no);if(!t)throw new Error(`Ticket ${no} not found`);
  const u=await getUser(env,t.telegram_id),lang=u?.language||'uz',d=departmentMeta(t.department,lang),c=categoryMeta(t.category,lang),route=await resolveDepartmentChat(env,t.department);
  if(!route?.chatId)throw new Error(`No operator group for ${t.department}`);
  const p=t.priority==='critical'?'🚨':t.priority==='high'?'🔴':t.priority==='low'?'🟢':'🟡';
  const text=[`${p} <b>${escapeHtml(t.priority.toUpperCase())} · ${escapeHtml(no)}</b>`,'━━━━━━━━━━━━━━━━━━',`${d.icon} <b>${escapeHtml(d.title)}</b>`,`${c.icon} ${escapeHtml(c.title)}`,'',`👤 <b>${escapeHtml(nameOf(u))}</b>`,u?.username?`🔗 @${escapeHtml(u.username)}`:null,`🆔 Telegram: <code>${t.telegram_id}</code>`,`🔐 Login/shartnoma: <code>${escapeHtml(t.account_login||'—')}</code>`,`📍 Manzil: ${escapeHtml(t.address||'—')}`,`📞 Telefon: <b>${escapeHtml(t.phone||'—')}</b>`,'',`📝 <b>${L(lang,'Murojaat','Обращение')}:</b>`,escapeHtml(t.description||'—'),'','1️⃣ Qabul qilish → 2️⃣ Javob berish → 3️⃣ Guruhga javob yozish'].filter(Boolean).join('\n');
  const sent=await sendMessage(env,route.chatId,text,{reply_markup:operatorKeyboard(no)});await setSupportMessage(env,no,route.chatId,sent.message_id);await deliveryDone(env,no);return{chatId:route.chatId,messageId:sent.message_id};
}
async function safeDeliver(env,no){try{await deliverTicket(env,no);return true}catch(e){await enqueueDelivery(env,no,e);console.error('v8 queued',{no,error:String(e)});return false}}

async function createGuidedTicket(env,msg,user,data,extra=''){
  const lang=user.language||'uz',c=categoryMeta(data.category,lang),typeLine=data.entityType&&data.entityType!=='none'?`${L(lang,'Mijoz turi','Тип клиента')}: ${entityTypeLabel(data.entityType,lang)}\n`:'';
  const description=[typeLine+`${L(lang,'Tanlangan muammo','Выбранная проблема')}: ${c.title}`,L(lang,'Bot tavsiyalari bajarildi, lekin muammo hal bo‘lmadi.','Рекомендации бота выполнены, но проблема не решена.'),extra?`${L(lang,'Qo‘shimcha','Дополнительно')}: ${extra}`:null].filter(Boolean).join('\n');
  const no=await createTicket(env,{telegramId:user.telegram_id,department:data.department,category:data.category,description,accountLogin:data.accountLogin??user.account_login,address:data.address??user.address,phone:user.phone,priority:priorityFor(data.category,description),telegramMessageId:msg?.message_id||null});
  await clearSession(env,user.telegram_id);const delivered=await safeDeliver(env,no);
  await sendMessage(env,msg.chat.id,L(lang,`✅ <b>Murojaat yuborildi</b>\n\n🎫 <code>${no}</code>\n${delivered?'👨‍💻 Tegishli bo‘lim operator guruhiga yuborildi.':'⏳ Murojaat saqlandi va yuborish navbatiga qo‘yildi.'}\n\nOperator javobi shu botga keladi.`,`✅ <b>Обращение отправлено</b>\n\n🎫 <code>${no}</code>\n${delivered?'👨‍💻 Отправлено в группу нужного отдела.':'⏳ Обращение сохранено и поставлено в очередь.'}\n\nОтвет оператора придёт в этот бот.`),{reply_markup:userTicketKeyboard(lang,no)});return no;
}

async function beginAssist(env,q,department,type,category){
  const user=await upsertUser(env,q.from),lang=user.language||'uz';await setSession(env,user.telegram_id,'support_choice',{department,entityType:type,category});
  await answerCallback(env,q.id);
  return sendMessage(env,q.message.chat.id,L(lang,'👨‍💻 <b>Operatorga murojaat</b>\n\nAbonentni topish uchun bittasini tanlang:','👨‍💻 <b>Обращение оператору</b>\n\nВыберите способ идентификации абонента:'),{reply_markup:identifierChoiceKeyboard(department,lang)});
}

async function handleSession(env,msg,user,s){
  if(!s)return false;const lang=user.language||'uz',d=sessionData(s);
  if(s.state==='profile_account'){if(!msg.text)return true;d.accountLogin=msg.text.trim()==='-'?null:msg.text.trim().slice(0,80);await setSession(env,user.telegram_id,'profile_address',d);await sendMessage(env,msg.chat.id,L(lang,'📍 Manzilingizni yozing:','📍 Укажите адрес:'));return true;}
  if(s.state==='profile_address'){if(!msg.text?.trim())return true;d.address=msg.text.trim().slice(0,300);await setSession(env,user.telegram_id,'profile_phone',d);await sendMessage(env,msg.chat.id,L(lang,'📞 Telefonni yuboring yoki kontakt tugmasini bosing:','📞 Отправьте телефон или нажмите кнопку:'),{reply_markup:contactKeyboard(L(lang,'📱 O‘z raqamim','📱 Мой номер'))});return true;}
  if(s.state==='profile_phone'){const p=normalizePhone(msg.contact?.phone_number||msg.text||'');if(!p){await sendMessage(env,msg.chat.id,L(lang,'⚠️ Raqamni qayta yuboring.','⚠️ Отправьте номер ещё раз.'));return true;}d.phone=p;await saveProfile(env,user.telegram_id,d);await clearSession(env,user.telegram_id);await sendMessage(env,msg.chat.id,L(lang,'✅ Profil saqlandi.','✅ Профиль сохранён.'),{reply_markup:removeKeyboard});return showHome(env,msg.chat.id,lang);}
  if(s.state==='support_value'){
    if(!msg.text?.trim()){await sendMessage(env,msg.chat.id,L(lang,'✍️ Matn ko‘rinishida yuboring.','✍️ Отправьте текстом.'));return true;}
    const value=msg.text.trim().slice(0,300);if(d.identifierMode==='login')d.accountLogin=value;else d.address=value;
    if(d.category==='other'){await setSession(env,user.telegram_id,'support_details',d);await sendMessage(env,msg.chat.id,L(lang,'📝 Muammoni bir-ikki gapda yozing:','📝 Кратко опишите проблему:'));return true;}
    await createGuidedTicket(env,msg,user,d);return true;
  }
  if(s.state==='support_details'){
    const body=String(msg.text||msg.caption||'').trim();if(!body){await sendMessage(env,msg.chat.id,L(lang,'📝 Muammoni matn bilan yozing.','📝 Опишите проблему текстом.'));return true;}await createGuidedTicket(env,msg,user,d,body.slice(0,1200));return true;
  }
  if(s.state==='ticket_reply'){
    const t=await getTicket(env,d.ticketNo);if(!t||String(t.telegram_id)!==String(user.telegram_id)||t.status!=='open'){await clearSession(env,user.telegram_id);return true;}
    const chat=t.support_chat_id||(await resolveDepartmentChat(env,t.department))?.chatId,body=String(msg.text||msg.caption||'').trim(),media=Boolean(msg.photo||msg.document||msg.video||msg.voice||msg.audio);
    try{if(body)await sendMessage(env,chat,`💬 <b>${escapeHtml(t.ticket_no)} · mijoz</b>\n\n${escapeHtml(body)}`,t.support_message_id?{reply_to_message_id:t.support_message_id}:{});if(media)await copyMessage(env,chat,msg.chat.id,msg.message_id);await addMessage(env,t.ticket_no,'user',user.telegram_id,body||'[attachment]',msg.message_id);await setStage(env,t.ticket_no,'in_progress');await clearSession(env,user.telegram_id);await sendMessage(env,msg.chat.id,L(lang,'✅ Javob operatorga yuborildi.','✅ Ответ отправлен оператору.'),{reply_markup:homeKeyboard(lang)});}catch(e){await sendMessage(env,msg.chat.id,L(lang,'⚠️ Yuborishda xato. Yana urinib ko‘ring.','⚠️ Ошибка отправки. Попробуйте ещё раз.'));}return true;
  }
  return false;
}

async function privateMessage(env,msg){
  let user=await upsertUser(env,msg.from);const text=String(msg.text||'').trim();let lang=user.language||'uz';
  if(text==='/start'){await clearSession(env,user.telegram_id);if(!user.language)return sendMessage(env,msg.chat.id,'🌐 <b>Tilni tanlang / Выберите язык</b>',{reply_markup:languageKeyboard()});return showHome(env,msg.chat.id,user.language);}
  if(text==='/cancel'){await clearSession(env,user.telegram_id);await sendMessage(env,msg.chat.id,L(lang,'❎ Amal bekor qilindi.','❎ Действие отменено.'),{reply_markup:removeKeyboard});return showHome(env,msg.chat.id,lang);}
  if(text==='/profile')return showProfile(env,msg.chat.id,user);if(text==='/tickets')return showTickets(env,msg.chat.id,user);if(text==='/language')return sendMessage(env,msg.chat.id,'🌐 <b>Til / Язык</b>',{reply_markup:languageKeyboard()});
  const s=await getSession(env,user.telegram_id);if(await handleSession(env,msg,user,s))return;if(!user.language)return sendMessage(env,msg.chat.id,'🌐 <b>Tilni tanlang / Выберите язык</b>',{reply_markup:languageKeyboard()});
  if(!text)return showHome(env,msg.chat.id,lang);
  const i=classifyText(text);if(i.action==='home')return showHome(env,msg.chat.id,lang);if(i.action==='tariffs')return showTariffMenu(env,msg.chat.id,lang);if(i.action==='tv')return showTV(env,msg.chat.id,lang);if(i.action==='departments')return showDepartments(env,msg.chat.id,lang);if(i.action==='choose_type')return showDepartment(env,msg.chat.id,lang,i.department,i.category);if(i.action==='issue')return showIssue(env,msg.chat.id,lang,i.department,i.entityType,i.category);return showDepartments(env,msg.chat.id,lang);
}

async function privateCallback(env,q){
  let user=await upsertUser(env,q.from),lang=user.language||'uz',data=q.data||'',chatId=q.message.chat.id;try{await answerCallback(env,q.id)}catch{}
  if(data==='noop')return;
  if(data.startsWith('lang:')){const n=data==='lang:ru'?'ru':'uz';await setLanguage(env,user.telegram_id,n);await clearSession(env,user.telegram_id);return showHome(env,chatId,n);}
  if(data==='home:main'){await clearSession(env,user.telegram_id);return showHome(env,chatId,lang);}if(data==='home:departments')return showDepartments(env,chatId,lang);if(data==='home:tariffs')return showTariffMenu(env,chatId,lang);if(data==='home:tv')return showTV(env,chatId,lang);if(data==='home:profile')return showProfile(env,chatId,user);if(data==='home:tickets')return showTickets(env,chatId,user);if(data==='home:promo')return showPromo(env,chatId,lang);if(data==='home:contacts')return showContacts(env,chatId,lang);if(data==='home:about')return showAbout(env,chatId,lang);if(data==='home:language')return sendMessage(env,chatId,'🌐 <b>Til / Язык</b>',{reply_markup:languageKeyboard()});
  if(data.startsWith('dept:'))return showDepartment(env,chatId,lang,data.slice(5));
  if(data.startsWith('type:')){const[,dept,type,suggested='other']=data.split(':');return showTypeIssues(env,chatId,lang,dept,type,suggested);}
  if(data.startsWith('issue:')){const[,dept,type,cat]=data.split(':');return showIssue(env,chatId,lang,dept,type,cat);}
  if(data.startsWith('assist:')){const[,dept,type,cat]=data.split(':');return beginAssist(env,q,dept,type,cat);}
  if(data==='intake:cancel'){await clearSession(env,user.telegram_id);return showHome(env,chatId,lang);}
  if(data==='intake:login'||data==='intake:address'){
    const s=await getSession(env,user.telegram_id);if(!s||s.state!=='support_choice')return showHome(env,chatId,lang);const d=sessionData(s),mode=data.endsWith('login')?'login':'address';d.identifierMode=mode;await setSession(env,user.telegram_id,'support_value',d);return sendMessage(env,chatId,mode==='login'?L(lang,'🔐 Login yoki shartnoma raqamini yozing:','🔐 Укажите логин или номер договора:'):L(lang,'📍 Xizmat manzilini to‘liq yozing:','📍 Укажите полный адрес услуги:'));
  }
  if(data==='profile:edit')return startProfile(env,user,chatId);
  if(data.startsWith('tariff:')){const[,s,p]=data.split(':');return showTariffs(env,chatId,lang,s,Number(p));}
  if(data.startsWith('ticket:view:'))return showTicket(env,chatId,user,data.slice('ticket:view:'.length));
  if(data.startsWith('ticket:reply:')){const no=data.slice('ticket:reply:'.length),t=await getTicket(env,no);if(!t||String(t.telegram_id)!==String(user.telegram_id)||t.status!=='open')return;await setSession(env,user.telegram_id,'ticket_reply',{ticketNo:no});return sendMessage(env,chatId,L(lang,'💬 Operatorga javobingizni yozing yoki media yuboring:','💬 Напишите ответ оператору или отправьте медиа:'));}
  if(data.startsWith('feedback:')){const[,no,r]=data.split(':'),t=await getTicket(env,no);if(!t||String(t.telegram_id)!==String(user.telegram_id))return;await setRating(env,no,user.telegram_id,Number(r));return sendMessage(env,chatId,L(lang,'💙 Rahmat! Bahoyingiz qabul qilindi.','💙 Спасибо! Оценка принята.'),{reply_markup:homeKeyboard(lang)});}
}

function canTake(t,opId){return !t.assigned_to||String(t.assigned_to)===String(opId);}

async function operatorReplyMessage(env,msg,t){
  if(!t||t.status!=='open')return true;if(!canTake(t,msg.from.id)){await sendMessage(env,msg.chat.id,`⚠️ <code>${escapeHtml(t.ticket_no)}</code> boshqa operatorga biriktirilgan.`);return true;}
  if(!t.assigned_to)await assignTicket(env,t.ticket_no,{id:msg.from.id,name:operatorName(msg.from)});
  const u=await getUser(env,t.telegram_id),lang=u?.language||'uz',body=String(msg.text||msg.caption||'').trim(),media=Boolean(msg.photo||msg.document||msg.video||msg.voice||msg.audio);if(!body&&!media)return true;
  try{if(body)await sendMessage(env,t.telegram_id,`👨‍💻 <b>FiberNet ${L(lang,'operatori','оператор')}</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\n${escapeHtml(body)}`,{reply_markup:userTicketKeyboard(lang,t.ticket_no)});if(media)await copyMessage(env,t.telegram_id,msg.chat.id,msg.message_id);await addMessage(env,t.ticket_no,'operator',msg.from.id,body||'[attachment]',msg.message_id);await setStage(env,t.ticket_no,'in_progress',{id:msg.from.id,name:operatorName(msg.from)});await clearOperatorReplySession(env,msg.chat.id,msg.from.id);await sendMessage(env,msg.chat.id,`✅ Javob mijozga yuborildi · <code>${escapeHtml(t.ticket_no)}</code>`,{reply_to_message_id:msg.message_id});}catch(e){await sendMessage(env,msg.chat.id,`⚠️ Yuborilmadi: <code>${escapeHtml(String(e).slice(0,200))}</code>`);}return true;
}

async function groupCommand(env,msg){
  const text=String(msg.text||'').trim();const bind=text.match(/^\/bind(?:@\w+)?\s+(general|tech|accounting|subscriber|connection)$/i);
  if(bind){if(!isAdmin(env,msg.from.id)){await sendMessage(env,msg.chat.id,'⛔ Faqat bot admini.');return true;}const d=bind[1].toLowerCase();await bindDepartment(env,d,msg.chat.id,msg.chat.title||null,msg.from.id);await sendMessage(env,msg.chat.id,`✅ <b>${escapeHtml(departmentMeta(d,'uz').title)}</b> guruhi biriktirildi.\n🆔 <code>${msg.chat.id}</code>`);return true;}
  const unbind=text.match(/^\/unbind(?:@\w+)?\s+(general|tech|accounting|subscriber|connection)$/i);if(unbind){if(!isAdmin(env,msg.from.id))return true;await unbindDepartment(env,unbind[1].toLowerCase());await sendMessage(env,msg.chat.id,'✅ Binding olib tashlandi.');return true;}
  if(/^\/where(?:@\w+)?$/i.test(text)){const b=await getDepartmentByChat(env,msg.chat.id);await sendMessage(env,msg.chat.id,`📍 <b>Guruh</b>\n🆔 <code>${msg.chat.id}</code>\n🎯 ${escapeHtml(b?.department||'biriktirilmagan')}`);return true;}
  if(/^\/routes(?:@\w+)?$/i.test(text)){if(!isAdmin(env,msg.from.id))return true;const rows=await listDepartmentChats(env);const lines=DEPARTMENTS.map(d=>{const x=rows.find(r=>r.department===d);return `${x?'✅':'⚪️'} <b>${d}</b>${x?` → ${escapeHtml(x.title||String(x.chat_id))}`:''}`});await sendMessage(env,msg.chat.id,`🗂 <b>Bo‘lim guruhlari</b>\n\n${lines.join('\n')}`);return true;}
  if(/^\/cancelreply(?:@\w+)?$/i.test(text)){await clearOperatorReplySession(env,msg.chat.id,msg.from.id);await sendMessage(env,msg.chat.id,'❎ Javob rejimi bekor qilindi.');return true;}
  if(/^\/(queue|tickets)(?:@\w+)?$/i.test(text)){const b=await getDepartmentByChat(env,msg.chat.id),rows=await listQueue(env,40),f=b?rows.filter(x=>x.department===b.department):rows,body=f.length?f.map(x=>`${x.priority==='critical'?'🚨':x.priority==='high'?'🔴':'🟡'} <b>${escapeHtml(x.ticket_no)}</b> · ${escapeHtml(x.stage)}\n${escapeHtml((x.description||'').slice(0,140))}`).join('\n\n'):'✅ Ochiq murojaat yo‘q.';await sendMessage(env,msg.chat.id,`📥 <b>Navbat</b>\n\n${body}`);return true;}
  if(/^\/stats(?:@\w+)?$/i.test(text)){const s=await stats(env);await sendMessage(env,msg.chat.id,`📊 <b>FiberNet v8</b>\n\n📚 ${s.total||0}\n🟡 ${s.open_count||0}\n✅ ${s.closed_count||0}`);return true;}
  return false;
}

async function operatorCallback(env,q){
  const data=q.data||'';if(!data.startsWith('op:'))return false;const[,action,no]=data.split(':'),t=await getTicket(env,no);if(!t||t.status!=='open'){await answerCallback(env,q.id,'Murojaat yopilgan yoki topilmadi');return true;}if(t.support_chat_id&&String(t.support_chat_id)!==String(q.message.chat.id)){await answerCallback(env,q.id,'Bu ticket boshqa guruhga tegishli');return true;}const op={id:q.from.id,name:operatorName(q.from)};if(!canTake(t,op.id)&&action!=='close'){await answerCallback(env,q.id,`Boshqa operator: ${t.assigned_name||t.assigned_to}`);return true;}
  if(action==='claim'){await assignTicket(env,no,op);await answerCallback(env,q.id,'Sizga biriktirildi');const u=await getUser(env,t.telegram_id);await sendMessage(env,t.telegram_id,L(u?.language||'uz',`👨‍💻 Operator <code>${no}</code> murojaatingizni qabul qildi.`,`👨‍💻 Оператор принял обращение <code>${no}</code>.`),{reply_markup:userTicketKeyboard(u?.language||'uz',no)});return true;}
  if(action==='reply'){if(!t.assigned_to)await assignTicket(env,no,op);await setOperatorReplySession(env,q.message.chat.id,q.from.id,no);await setStage(env,no,'in_progress',op);await answerCallback(env,q.id,'Endi guruhga javob yozing');await sendMessage(env,q.message.chat.id,`✍️ <b>${escapeHtml(op.name)}</b>, <code>${escapeHtml(no)}</code> uchun keyingi xabaringiz mijozga boradi.\n❌ /cancelreply`,{reply_to_message_id:q.message.message_id});return true;}
  if(action==='wait'){if(!t.assigned_to)await assignTicket(env,no,op);await setStage(env,no,'waiting_customer',op);await answerCallback(env,q.id,'Mijoz javobi kutilmoqda');const u=await getUser(env,t.telegram_id);await sendMessage(env,t.telegram_id,L(u?.language||'uz',`⏳ Operator <code>${no}</code> bo‘yicha javobingizni kutmoqda.`,`⏳ Оператор ждёт ваш ответ по <code>${no}</code>.`),{reply_markup:userTicketKeyboard(u?.language||'uz',no)});return true;}
  if(action==='resolve'){if(!t.assigned_to)await assignTicket(env,no,op);await setStage(env,no,'resolved',op);await answerCallback(env,q.id,'Hal qilindi');const u=await getUser(env,t.telegram_id);await sendMessage(env,t.telegram_id,L(u?.language||'uz',`✅ <b>Murojaat hal qilindi</b>\n🎫 <code>${no}</code>\n\nNatijani baholang:`,`✅ <b>Обращение решено</b>\n🎫 <code>${no}</code>\n\nОцените результат:`),{reply_markup:resolvedKeyboard(u?.language||'uz',no)});return true;}
  if(action==='close'){if(t.assigned_to&&String(t.assigned_to)!==String(op.id)&&!isAdmin(env,op.id)){await answerCallback(env,q.id,'Faqat qabul qilgan operator yoki admin');return true;}await closeTicket(env,no);await clearOperatorReplySession(env,q.message.chat.id,q.from.id);await answerCallback(env,q.id,'Yopildi');const u=await getUser(env,t.telegram_id);await sendMessage(env,t.telegram_id,L(u?.language||'uz',`✅ Murojaat yopildi: <code>${no}</code>`,`✅ Обращение закрыто: <code>${no}</code>`),{reply_markup:homeKeyboard(u?.language||'uz')});try{await editReplyMarkup(env,q.message.chat.id,q.message.message_id)}catch{}return true;}
  return true;
}

async function groupMessage(env,msg){
  if(await groupCommand(env,msg))return;const s=await getOperatorReplySession(env,msg.chat.id,msg.from.id);if(s){const t=await getTicket(env,s.ticket_no);return operatorReplyMessage(env,msg,t);}if(msg.reply_to_message?.message_id){const t=await getTicketBySupportMessage(env,msg.chat.id,msg.reply_to_message.message_id);if(t)return operatorReplyMessage(env,msg,t);}return;
}

async function processUpdate(env,u){
  if(!await claimV7Update(env,u.update_id))return;try{if(u.callback_query){if(isGroupChat(u.callback_query.message?.chat))await operatorCallback(env,u.callback_query);else await privateCallback(env,u.callback_query);}else if(u.message){if(isPrivateChat(u.message.chat))await privateMessage(env,u.message);else if(isGroupChat(u.message.chat))await groupMessage(env,u.message);}}catch(e){await releaseV7Update(env,u.update_id);throw e;}
}

async function retryDeliveries(env){const rows=await pendingDeliveries(env,30);for(const x of rows){try{await deliverTicket(env,x.ticket_no);await deliveryDone(env,x.ticket_no);}catch(e){await deliveryFailed(env,x.ticket_no,e);}}}

export default {
  async fetch(req,env){const url=new URL(req.url);if(req.method==='POST'&&url.pathname==='/telegram/webhook'){if(!env.TELEGRAM_WEBHOOK_SECRET||req.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.TELEGRAM_WEBHOOK_SECRET)return new Response('Unauthorized',{status:401});let u;try{u=await req.json()}catch{return new Response('Bad Request',{status:400})}if(!Number.isInteger(u.update_id))return new Response('ok');try{await ensureV5Schema(env);await ensureV7Routing(env);await processUpdate(env,u);return new Response('ok')}catch(e){console.error('FiberNet v8 webhook error',{error:String(e),stack:e?.stack});return new Response('Retry',{status:500})}}
    if(req.method==='GET'&&url.pathname==='/health'){try{await ensureV5Schema(env);await ensureV7Routing(env);return Response.json({ok:true,service:'fibernet-bot',version:VERSION,architecture:'guided-departments',stats:await stats(env),routes:await listDepartmentChats(env)})}catch(e){return Response.json({ok:false,version:VERSION,error:String(e)},{status:503})}}
    if(req.method==='GET'&&url.pathname==='/')return new Response(`FiberNet Assistant v${VERSION} is running.`);return new Response('Not found',{status:404});
  },
  async scheduled(controller,env,ctx){ctx.waitUntil((async()=>{try{await ensureV5Schema(env);await ensureV7Routing(env);await cleanupUpdates(env);await cleanupV7Updates(env);await cleanupOperatorReplySessions(env);await retryDeliveries(env);}catch(e){console.error('v8 maintenance',String(e))}if(controller?.cron==='15 23 * * *'){try{await syncOfficialSources(env)}catch(e){console.error('v8 sync',String(e))}}})())}
};

export const __test={classifyText,normalizePhone,priorityFor};
