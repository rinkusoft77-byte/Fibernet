import { inlineKeyboard } from './telegram.js';

export const L=(lang,uz,ru)=>lang==='ru'?ru:uz;

export function normalizePhone(v){
  let d=String(v||'').replace(/\D/g,'');
  if(d.length===9)d='998'+d;
  if(d.length===10&&d.startsWith('0'))d='998'+d.slice(1);
  if(d.startsWith('998')&&d.length===12)return `+${d}`;
  if(d.length>=7&&d.length<=15)return `+${d}`;
  return null;
}

export function operatorName(f={}){
  return [f.first_name,f.last_name].filter(Boolean).join(' ')||f.username||String(f.id||'operator');
}

export function departmentMeta(d,lang='uz'){
  return ({
    general:{icon:'🎫',title:L(lang,'Umumiy murojaat','Общее обращение')},
    tech:{icon:'🛠',title:L(lang,'Texnik yordam','Техподдержка')},
    accounting:{icon:'💳',title:L(lang,'Buxgalteriya','Бухгалтерия')},
    subscriber:{icon:'👥',title:L(lang,'Abonent bo‘limi','Абонентский отдел')},
    connection:{icon:'🔌',title:L(lang,'Ulanish bo‘limi','Отдел подключений')}
  })[d]||{icon:'🎫',title:L(lang,'Umumiy murojaat','Общее обращение')};
}

export function categoryMeta(c,lang='uz'){
  return ({
    no_internet:{icon:'🚫',title:L(lang,'Internet yo‘q','Нет интернета')},
    slow:{icon:'🐢',title:L(lang,'Internet sekin','Низкая скорость')},
    wifi:{icon:'📡',title:'Wi‑Fi'},
    iptv:{icon:'📺',title:'IPTV / HopHop TV'},
    equipment:{icon:'🔧',title:L(lang,'ONU / router','ONU / роутер')},
    payment_missing:{icon:'💸',title:L(lang,'To‘lov tushmagan','Платёж не зачислен')},
    balance:{icon:'💰',title:L(lang,'Balans / qarzdorlik','Баланс / задолженность')},
    documents:{icon:'🧾',title:L(lang,'Hisob / hujjatlar','Счёт / документы')},
    tariff_change:{icon:'🔄',title:L(lang,'Tarifni o‘zgartirish','Смена тарифа')},
    account_data:{icon:'🔐',title:L(lang,'Login / shartnoma','Логин / договор')},
    suspension:{icon:'⏸',title:L(lang,'To‘xtatish / faollashtirish','Приостановка / активация')},
    static_ip:{icon:'🌐',title:L(lang,'Statik IP','Статический IP')},
    connection:{icon:'🔌',title:L(lang,'Yangi ulanish','Новое подключение')},
    other:{icon:'📝',title:L(lang,'Boshqa murojaat','Другое обращение')}
  })[c]||{icon:'📝',title:L(lang,'Boshqa murojaat','Другое обращение')};
}

export function priorityFor(c,t=''){
  const s=String(t).toLowerCase();
  if(/\blos\b|qizil|красн|avari|авари|optik|оптик|обрыв|uzil|кабель.*оборван/.test(s))return'critical';
  if(c==='no_internet'||c==='payment_missing')return'high';
  if(c==='connection'||c==='documents'||c==='static_ip')return'low';
  return'normal';
}

export function classifyText(t=''){
  const s=String(t).toLowerCase().trim();
  if(!s)return{action:'home'};
  if(/^(salom|assalom|привет|здравствуйте|hello|menu|меню)[!,. ]*$/.test(s))return{action:'home'};
  if(/kontakt|contact|telefon|номер|телефон|aloqa|связаться/.test(s))return{action:'contacts'};
  if(/hophop|hop-hop|hop hop|телевид|iptv|tv/.test(s)&&!/ishlam|не работ|xato|ошиб|uzil|qot|завис/.test(s))return{action:'tv'};
  if(/xizmat|услуг|statik ip|статич.*ip|port blok|блокиров.*порт/.test(s)&&!/muammo|проблем|ishlam|не работ/.test(s))return{action:'services'};
  if(/tarif|тариф|tezkor|online|tekin|fiberpro/.test(s)&&!/o['’]?zgart|almasht|смен/.test(s))return{action:'tariffs'};
  if(/ulanish|ulanmoq|подключ|connect|yangi internet|новый internet|новый интернет/.test(s))return{action:'ticket',department:'connection',category:'connection'};
  if(/to['’]?lov|оплат|balans|баланс|qarz|долг|kvit|чек|hisob|сч[её]т|бухгалтер/.test(s))return{action:'ticket',department:'accounting',category:/tushm|не зачис|не приш|yo['’]?q/.test(s)?'payment_missing':/kvit|чек|hisob|сч[её]т/.test(s)?'documents':'balance'};
  if(/login|логин|shartnoma|договор|abonent|абонент|tarifni o['’]?zgart|almasht|смен.*тариф|pauza|приостанов|statik ip|статич.*ip/.test(s)){
    const category=/tarif|тариф/.test(s)?'tariff_change':/pauza|приостанов/.test(s)?'suspension':/statik ip|статич.*ip/.test(s)?'static_ip':'account_data';
    return{action:'ticket',department:'subscriber',category};
  }
  if(/wifi|wi-fi|internet|интернет|los|router|роутер|onu|ont|скорост|sekin|медлен|uzil|обрыв|hophop|iptv|телев|tv/.test(s)){
    let c='other';
    if(/yo['’]?q|нет интернет|не работает интернет|los/.test(s))c='no_internet';
    else if(/sekin|скорост|медлен/.test(s))c='slow';
    else if(/wifi|wi-fi/.test(s))c='wifi';
    else if(/hophop|tv|iptv|телев/.test(s))c='iptv';
    else if(/router|роутер|onu|ont/.test(s))c='equipment';
    return{action:'ticket',department:'tech',category:c};
  }
  return{action:'ticket',department:'general',category:'other'};
}

export const languageKeyboard=()=>inlineKeyboard([[
  {text:'🇺🇿 O‘zbekcha',callback_data:'lang:uz'},
  {text:'🇷🇺 Русский',callback_data:'lang:ru'}
]]);

export const homeKeyboard=lang=>inlineKeyboard([
  [{text:L(lang,'🛠 Texnik yordam','🛠 Техподдержка'),callback_data:'home:tech'},{text:L(lang,'💳 Buxgalteriya','💳 Бухгалтерия'),callback_data:'home:accounting'}],
  [{text:L(lang,'👥 Abonent bo‘limi','👥 Абонентский отдел'),callback_data:'home:subscriber'},{text:L(lang,'🔌 Ulanish','🔌 Подключение'),callback_data:'home:connection'}],
  [{text:L(lang,'✍️ Murojaat yozish','✍️ Написать обращение'),callback_data:'quick:general:other'},{text:L(lang,'📂 Murojaatlarim','📂 Мои обращения'),callback_data:'home:tickets'}],
  [{text:L(lang,'📶 Tariflar','📶 Тарифы'),callback_data:'home:tariffs'},{text:'📺 HopHop TV',callback_data:'home:tv'}],
  [{text:L(lang,'🧰 Xizmatlar','🧰 Услуги'),callback_data:'home:services'},{text:L(lang,'ℹ️ FiberNet haqida','ℹ️ О FiberNet'),callback_data:'home:about'}],
  [{text:L(lang,'👤 Profilim','👤 Мой профиль'),callback_data:'home:profile'},{text:L(lang,'☎️ Aloqa','☎️ Контакты'),callback_data:'home:contacts'}],
  [{text:L(lang,'🎁 Aksiyalar','🎁 Акции'),callback_data:'home:promo'},{text:L(lang,'🌐 Til','🌐 Язык'),callback_data:'home:language'}]
]);

export const departmentsKeyboard=lang=>inlineKeyboard([
  [{text:L(lang,'🎫 Umumiy operatorga yozish','🎫 Написать оператору'),callback_data:'quick:general:other'}],
  [{text:L(lang,'🛠 Texnik yordamga yozish','🛠 Написать в техподдержку'),callback_data:'quick:tech:other'}],
  [{text:L(lang,'💳 Buxgalteriyaga yozish','💳 Написать в бухгалтерию'),callback_data:'quick:accounting:other'}],
  [{text:L(lang,'👥 Abonent bo‘limiga yozish','👥 Написать в абонентский отдел'),callback_data:'quick:subscriber:other'}],
  [{text:L(lang,'🔌 Ulanish bo‘limiga yozish','🔌 Написать по подключению'),callback_data:'quick:connection:connection'}],
  [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);

export const techKeyboard=lang=>inlineKeyboard([
  [{text:L(lang,'✍️ Operatorga yozish','✍️ Написать оператору'),callback_data:'quick:tech:other'}],
  [{text:L(lang,'🚫 Internet yo‘q','🚫 Нет интернета'),callback_data:'diag:no_internet'},{text:L(lang,'🐢 Internet sekin','🐢 Низкая скорость'),callback_data:'diag:slow'}],
  [{text:'📡 Wi‑Fi',callback_data:'diag:wifi'},{text:'📺 IPTV / TV',callback_data:'diag:iptv'}],
  [{text:L(lang,'🔧 ONU / router','🔧 ONU / роутер'),callback_data:'diag:equipment'}],
  [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);

export const accountingKeyboard=lang=>inlineKeyboard([
  [{text:L(lang,'✍️ Buxgalteriyaga yozish','✍️ Написать в бухгалтерию'),callback_data:'quick:accounting:other'}],
  [{text:L(lang,'💸 To‘lov tushmagan','💸 Платёж не зачислен'),callback_data:'quick:accounting:payment_missing'}],
  [{text:L(lang,'💰 Balans / qarzdorlik','💰 Баланс / задолженность'),callback_data:'quick:accounting:balance'}],
  [{text:L(lang,'🧾 Hisob / hujjatlar','🧾 Счёт / документы'),callback_data:'quick:accounting:documents'}],
  [{text:L(lang,'ℹ️ To‘lov bo‘yicha ma’lumot','ℹ️ Информация об оплате'),callback_data:'info:payment'}],
  [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);

export const subscriberKeyboard=lang=>inlineKeyboard([
  [{text:L(lang,'✍️ Abonent bo‘limiga yozish','✍️ Написать в абонентский отдел'),callback_data:'quick:subscriber:other'}],
  [{text:L(lang,'🔄 Tarifni o‘zgartirish','🔄 Смена тарифа'),callback_data:'quick:subscriber:tariff_change'}],
  [{text:L(lang,'🔐 Login / shartnoma','🔐 Логин / договор'),callback_data:'quick:subscriber:account_data'}],
  [{text:L(lang,'⏸ To‘xtatish / faollashtirish','⏸ Приостановка / активация'),callback_data:'quick:subscriber:suspension'}],
  [{text:L(lang,'🌐 Statik IP','🌐 Статический IP'),callback_data:'quick:subscriber:static_ip'}],
  [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);

export const connectionKeyboard=lang=>inlineKeyboard([
  [{text:L(lang,'✍️ Ulanish uchun ariza','✍️ Заявка на подключение'),callback_data:'quick:connection:connection'}],
  [{text:L(lang,'📶 Tariflarni ko‘rish','📶 Посмотреть тарифы'),callback_data:'home:tariffs'}],
  [{text:L(lang,'☎️ Aloqa','☎️ Контакты'),callback_data:'home:contacts'}],
  [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);

export const infoBackKeyboard=lang=>inlineKeyboard([
  [{text:L(lang,'✍️ Operatorga yozish','✍️ Написать оператору'),callback_data:'quick:general:other'}],
  [{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);

export const operatorKeyboard=no=>inlineKeyboard([
  [{text:'👨‍💻 Qabul qilish',callback_data:`op:claim:${no}`},{text:'⏳ Mijozni kutish',callback_data:`op:wait:${no}`}],
  [{text:'✅ Hal qilindi',callback_data:`op:resolve:${no}`},{text:'❌ Yopish',callback_data:`op:close:${no}`}]
]);

export function diagnosticText(lang,category){
  const m=categoryMeta(category,lang);
  const body=({
    no_internet:L(lang,
      '1️⃣ ONU/ONT va routerni 60 soniyaga o‘chirib qayta yoqing.\n2️⃣ <b>LOS qizil</b> bo‘lsa optik kabelni bukmang yoki ajratmang.\n3️⃣ WAN/Ethernet indikatorlarini tekshiring.\n4️⃣ Muammo qolsa operatorga yuboring.',
      '1️⃣ Выключите ONU/ONT и роутер на 60 секунд.\n2️⃣ Если <b>LOS красный</b>, не сгибайте и не отсоединяйте оптоволокно.\n3️⃣ Проверьте WAN/Ethernet.\n4️⃣ Если проблема осталась — отправьте оператору.'),
    slow:L(lang,
      '1️⃣ Fon yuklamalarni to‘xtating.\n2️⃣ Router yonida 5 GHz orqali tekshiring.\n3️⃣ Iloji bo‘lsa kabel orqali solishtiring.\n4️⃣ Tezlik natijasini operatorga yozing.',
      '1️⃣ Остановите фоновые загрузки.\n2️⃣ Проверьте 5 GHz рядом с роутером.\n3️⃣ По возможности сравните по кабелю.\n4️⃣ Укажите результат оператору.'),
    wifi:L(lang,
      '1️⃣ Routerni ochiq va markaziy joyga qo‘ying.\n2️⃣ 5 GHz tezroq, 2.4 GHz uzoqroq ishlaydi.\n3️⃣ Routerni qayta yoqing.\n4️⃣ Uzilish davom etsa operatorga yozing.',
      '1️⃣ Разместите роутер открыто и ближе к центру.\n2️⃣ 5 GHz быстрее, 2.4 GHz работает дальше.\n3️⃣ Перезагрузите роутер.\n4️⃣ Если обрывы остаются — напишите оператору.'),
    iptv:L(lang,
      '1️⃣ Internet ishlayotganini tekshiring.\n2️⃣ Router va TV/pristavkani qayta yoqing.\n3️⃣ HopHop ilovasini qayta oching.\n4️⃣ Muammo bitta kanalmi yoki barcha kanallardami — operatorga yozing.',
      '1️⃣ Проверьте интернет.\n2️⃣ Перезагрузите роутер и ТВ/приставку.\n3️⃣ Перезапустите HopHop.\n4️⃣ Укажите, проблема на одном канале или на всех.'),
    equipment:L(lang,
      'ONU/ONT yoki router indikatorlarini tekshiring. Qizil LOS, PON o‘chgan yoki qurilma umuman yonmasa — holatni operatorga yozing.',
      'Проверьте индикаторы ONU/ONT и роутера. Красный LOS, погасший PON или отсутствие питания — сообщите оператору.')
  })[category]||L(lang,'Muammoni yozing va operatorga yuboring.','Опишите проблему и отправьте оператору.');
  return `${m.icon} <b>${m.title}</b>\n\n${body}`;
}
