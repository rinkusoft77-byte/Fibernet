import { inlineKeyboard } from './telegram.js';
export const L=(lang,uz,ru)=>lang==='ru'?ru:uz;
export function normalizePhone(v){let d=String(v||'').replace(/\D/g,'');if(d.length===9)d='998'+d;if(d.length===10&&d.startsWith('0'))d='998'+d.slice(1);return d.length>=7&&d.length<=15?`+${d}`:null}
export function operatorName(f={}){return [f.first_name,f.last_name].filter(Boolean).join(' ')||f.username||String(f.id||'operator')}
export function departmentMeta(d,lang='uz'){return ({tech:{icon:'🛠',title:L(lang,'Texnik yordam','Техподдержка')},accounting:{icon:'💳',title:L(lang,'Buxgalteriya','Бухгалтерия')},subscriber:{icon:'👥',title:L(lang,'Abonent bo‘limi','Абонентский отдел')},connection:{icon:'🔌',title:L(lang,'Ulanish bo‘limi','Отдел подключений')}})[d]||{icon:'🛠',title:L(lang,'Texnik yordam','Техподдержка')}}
export function categoryMeta(c,lang='uz'){return ({no_internet:{icon:'🚫',title:L(lang,'Internet yo‘q','Нет интернета')},slow:{icon:'🐢',title:L(lang,'Internet sekin','Низкая скорость')},wifi:{icon:'📡',title:'Wi‑Fi'},iptv:{icon:'📺',title:'IPTV / TV'},equipment:{icon:'🔧',title:L(lang,'ONU / router','ONU / роутер')},payment_missing:{icon:'💸',title:L(lang,'To‘lov tushmagan','Платёж не зачислен')},balance:{icon:'💰',title:L(lang,'Balans / qarzdorlik','Баланс / задолженность')},documents:{icon:'🧾',title:L(lang,'Hisob / hujjatlar','Счёт / документы')},tariff_change:{icon:'🔄',title:L(lang,'Tarifni o‘zgartirish','Смена тарифа')},account_data:{icon:'🔐',title:L(lang,'Login / shartnoma','Логин / договор')},suspension:{icon:'⏸',title:L(lang,'To‘xtatish / faollashtirish','Приостановка / активация')},connection:{icon:'🔌',title:L(lang,'Yangi ulanish','Новое подключение')},other:{icon:'📝',title:L(lang,'Boshqa murojaat','Другое обращение')}})[c]||{icon:'📝',title:L(lang,'Boshqa murojaat','Другое обращение')}}
export function priorityFor(c,t=''){const s=String(t).toLowerCase();if(/\blos\b|qizil|красн|avari|авари|optik|обрыв|uzil/.test(s))return'critical';if(c==='no_internet'||c==='payment_missing')return'high';if(c==='connection')return'low';return'normal'}
export function classifyText(t=''){const s=String(t).toLowerCase().trim();if(!s)return{action:'home'};if(/^(salom|assalom|привет|здравствуйте|hello|menu|меню)[!,. ]*$/.test(s))return{action:'home'};if(/tarif|тариф|tezkor|online/.test(s)&&!/o['’]?zgart|смен/.test(s))return{action:'tariffs'};if(/ulanish|ulanmoq|подключ|connect|yangi internet|новый internet|новый интернет/.test(s))return{action:'ticket',department:'connection',category:'connection'};if(/to['’]?lov|оплат|balans|баланс|qarz|долг|kvit|чек|hisob|сч[её]т/.test(s))return{action:'ticket',department:'accounting',category:/tushm|не зачис|не приш/.test(s)?'payment_missing':'balance'};if(/login|логин|shartnoma|договор|abonent|абонент|tarifni o['’]?zgart|смен.*тариф|pauza|приостанов/.test(s))return{action:'ticket',department:'subscriber',category:/tarif|тариф/.test(s)?'tariff_change':/pauza|приостанов/.test(s)?'suspension':'account_data'};if(/wifi|wi-fi|internet|интернет|los|router|роутер|onu|ont|скорост|sekin|медлен|uzil|обрыв|tv|iptv|телев/.test(s)){let c='other';if(/yo['’]?q|нет интернет|не работает интернет|los/.test(s))c='no_internet';else if(/sekin|скорост|медлен/.test(s))c='slow';else if(/wifi|wi-fi/.test(s))c='wifi';else if(/tv|iptv|телев/.test(s))c='iptv';else if(/router|роутер|onu|ont/.test(s))c='equipment';return{action:'ticket',department:'tech',category:c}}return{action:'departments'}}
export const languageKeyboard=()=>inlineKeyboard([[{text:'🇺🇿 O‘zbekcha',callback_data:'lang:uz'},{text:'🇷🇺 Русский',callback_data:'lang:ru'}]]);
export const homeKeyboard=lang=>inlineKeyboard([
[{text:L(lang,'🛠 Texnik yordam','🛠 Техподдержка'),callback_data:'home:tech'},{text:L(lang,'💳 Buxgalteriya','💳 Бухгалтерия'),callback_data:'home:accounting'}],
[{text:L(lang,'👥 Abonent bo‘limi','👥 Абонентский отдел'),callback_data:'home:subscriber'},{text:L(lang,'🔌 Ulanish','🔌 Подключение'),callback_data:'quick:connection:connection'}],
[{text:L(lang,'✍️ Murojaat yozish','✍️ Написать обращение'),callback_data:'home:departments'},{text:L(lang,'📂 Murojaatlarim','📂 Мои обращения'),callback_data:'home:tickets'}],
[{text:L(lang,'📶 Tariflar','📶 Тарифы'),callback_data:'home:tariffs'},{text:L(lang,'👤 Profilim','👤 Мой профиль'),callback_data:'home:profile'}],
[{text:L(lang,'🧰 Xizmatlar','🧰 Услуги'),callback_data:'home:services'},{text:L(lang,'☎️ Aloqa','☎️ Контакты'),callback_data:'home:contacts'}],
[{text:L(lang,'🎁 Aksiyalar','🎁 Акции'),callback_data:'home:promo'},{text:L(lang,'🌐 Til','🌐 Язык'),callback_data:'home:language'}]
]);
export const departmentsKeyboard=lang=>inlineKeyboard([
[{text:L(lang,'🛠 Texnik yordamga yozish','🛠 Написать в техподдержку'),callback_data:'quick:tech:other'}],
[{text:L(lang,'💳 Buxgalteriyaga yozish','💳 Написать в бухгалтерию'),callback_data:'quick:accounting:other'}],
[{text:L(lang,'👥 Abonent bo‘limiga yozish','👥 Написать в абонентский отдел'),callback_data:'quick:subscriber:other'}],
[{text:L(lang,'🔌 Ulanish bo‘limiga yozish','🔌 Написать по подключению'),callback_data:'quick:connection:connection'}],
[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);
export const techKeyboard=lang=>inlineKeyboard([
[{text:L(lang,'✍️ Darhol yozish','✍️ Написать сразу'),callback_data:'quick:tech:other'}],
[{text:L(lang,'🚫 Internet yo‘q','🚫 Нет интернета'),callback_data:'quick:tech:no_internet'},{text:L(lang,'🐢 Internet sekin','🐢 Низкая скорость'),callback_data:'quick:tech:slow'}],
[{text:'📡 Wi‑Fi',callback_data:'quick:tech:wifi'},{text:'📺 IPTV / TV',callback_data:'quick:tech:iptv'}],
[{text:L(lang,'🔧 ONU / router','🔧 ONU / роутер'),callback_data:'quick:tech:equipment'}],
[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);
export const accountingKeyboard=lang=>inlineKeyboard([
[{text:L(lang,'✍️ Buxgalteriyaga yozish','✍️ Написать в бухгалтерию'),callback_data:'quick:accounting:other'}],
[{text:L(lang,'💸 To‘lov tushmagan','💸 Платёж не зачислен'),callback_data:'quick:accounting:payment_missing'}],
[{text:L(lang,'💰 Balans / qarzdorlik','💰 Баланс / задолженность'),callback_data:'quick:accounting:balance'}],
[{text:L(lang,'🧾 Hisob / hujjatlar','🧾 Счёт / документы'),callback_data:'quick:accounting:documents'}],
[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);
export const subscriberKeyboard=lang=>inlineKeyboard([
[{text:L(lang,'✍️ Abonent bo‘limiga yozish','✍️ Написать в абонентский отдел'),callback_data:'quick:subscriber:other'}],
[{text:L(lang,'🔄 Tarifni o‘zgartirish','🔄 Смена тарифа'),callback_data:'quick:subscriber:tariff_change'}],
[{text:L(lang,'🔐 Login / shartnoma','🔐 Логин / договор'),callback_data:'quick:subscriber:account_data'}],
[{text:L(lang,'⏸ To‘xtatish / faollashtirish','⏸ Приостановка / активация'),callback_data:'quick:subscriber:suspension'}],
[{text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'),callback_data:'home:main'}]
]);
export const operatorKeyboard=no=>inlineKeyboard([[{text:'👨‍💻 Qabul qilish',callback_data:`op:claim:${no}`},{text:'⏳ Mijozni kutish',callback_data:`op:wait:${no}`}],[{text:'✅ Hal qilindi',callback_data:`op:resolve:${no}`},{text:'❌ Yopish',callback_data:`op:close:${no}`}]]);
