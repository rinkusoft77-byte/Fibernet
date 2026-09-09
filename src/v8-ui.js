import { inlineKeyboard } from './telegram.js';

export const L = (lang, uz, ru) => lang === 'ru' ? ru : uz;

export function normalizePhone(value) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.length === 9) d = `998${d}`;
  if (d.length === 10 && d.startsWith('0')) d = `998${d.slice(1)}`;
  return d.length >= 7 && d.length <= 15 ? `+${d}` : null;
}

export function operatorName(from = {}) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id || 'operator');
}

export function entityTypeLabel(type, lang = 'uz') {
  if (type === 'legal') return L(lang, 'Yuridik shaxs', 'Юридическое лицо');
  if (type === 'physical') return L(lang, 'Jismoniy shaxs', 'Физическое лицо');
  return L(lang, 'Ko‘rsatilmagan', 'Не указано');
}

export function departmentMeta(dept, lang = 'uz') {
  return ({
    general: { icon: '🎫', title: L(lang, 'Umumiy', 'Общий отдел') },
    tech: { icon: '🛠', title: L(lang, 'Texnik yordam', 'Техподдержка') },
    accounting: { icon: '💳', title: L(lang, 'Buxgalteriya', 'Бухгалтерия') },
    subscriber: { icon: '👥', title: L(lang, 'Abonent bo‘limi', 'Абонентский отдел') },
    connection: { icon: '🔌', title: L(lang, 'Ulanish bo‘limi', 'Отдел подключений') }
  })[dept] || { icon: '🎫', title: L(lang, 'Umumiy', 'Общий отдел') };
}

export function categoryMeta(cat, lang = 'uz') {
  return ({
    no_internet: { icon: '🚫', title: L(lang, 'Internet yo‘q', 'Нет интернета') },
    slow: { icon: '🐢', title: L(lang, 'Internet sekin', 'Низкая скорость') },
    wifi: { icon: '📡', title: 'Wi‑Fi' },
    iptv: { icon: '📺', title: 'IPTV / HopHop TV' },
    equipment: { icon: '🔧', title: L(lang, 'ONU / router', 'ONU / роутер') },
    lan: { icon: '🔌', title: L(lang, 'Kabel / LAN', 'Кабель / LAN') },
    payment_missing: { icon: '💸', title: L(lang, 'To‘lov tushmagan', 'Платёж не зачислен') },
    balance: { icon: '💰', title: L(lang, 'Balans / qarzdorlik', 'Баланс / задолженность') },
    documents: { icon: '🧾', title: L(lang, 'Hisob / hujjatlar', 'Счёт / документы') },
    tariff_change: { icon: '🔄', title: L(lang, 'Tarifni o‘zgartirish', 'Смена тарифа') },
    account_data: { icon: '🔐', title: L(lang, 'Login / shartnoma', 'Логин / договор') },
    suspension: { icon: '⏸', title: L(lang, 'To‘xtatish / faollashtirish', 'Приостановка / активация') },
    static_ip: { icon: '🌐', title: L(lang, 'Statik IP', 'Статический IP') },
    legal_docs: { icon: '🏢', title: L(lang, 'Yuridik hujjatlar', 'Документы юрлица') },
    connection: { icon: '🔌', title: L(lang, 'Yangi ulanish', 'Новое подключение') },
    coverage: { icon: '📍', title: L(lang, 'Manzilni tekshirish', 'Проверка адреса') },
    other: { icon: '📝', title: L(lang, 'Boshqa masala', 'Другой вопрос') }
  })[cat] || { icon: '📝', title: L(lang, 'Boshqa masala', 'Другой вопрос') };
}

export function priorityFor(category, text = '') {
  const s = String(text).toLowerCase();
  if (/\blos\b|qizil|красн|avari|авари|optik|оптик|obryv|обрыв|uzil/.test(s)) return 'critical';
  if (category === 'no_internet' || category === 'payment_missing') return 'high';
  if (category === 'connection' || category === 'coverage' || category === 'documents' || category === 'legal_docs') return 'low';
  return 'normal';
}

// Free text never creates a ticket directly. It only opens a guided section/problem.
export function classifyText(text = '') {
  const s = String(text).toLowerCase().trim();
  if (!s) return { action: 'home' };
  if (/^(salom|assalom|привет|здравствуйте|hello|menu|меню)[!,. ]*$/.test(s)) return { action: 'home' };
  if (/tarif|тариф|tezkor|online/.test(s) && !/o['’]?zgart|almasht|смен/.test(s)) return { action: 'tariffs' };
  if (/hophop|hop hop|iptv|телевид|tv/.test(s) && !/ishlam|не работ|xato|ошиб|qot|завис/.test(s)) return { action: 'tv' };
  if (/to['’]?lov|оплат|balans|баланс|qarz|долг|kvit|чек|hisob|сч[её]т|бухгалтер/.test(s)) {
    const category = /tushm|не зачис|не приш/.test(s) ? 'payment_missing' : /kvit|чек|hisob|сч[её]т/.test(s) ? 'documents' : 'balance';
    return { action: 'issue', department: 'accounting', entityType: 'none', category };
  }
  if (/ulanish|ulanmoq|подключ|connect|yangi internet|новый интернет|manzil.*tekshir|провер.*адрес/.test(s)) {
    return { action: 'issue', department: 'connection', entityType: 'none', category: /manzil|адрес/.test(s) ? 'coverage' : 'connection' };
  }
  if (/wifi|wi-fi|internet|интернет|los|router|роутер|onu|ont|скорост|sekin|медлен|uzil|обрыв|lan|кабель/.test(s)) {
    let category = 'other';
    if (/yo['’]?q|нет интернет|не работает интернет|los/.test(s)) category = 'no_internet';
    else if (/sekin|скорост|медлен/.test(s)) category = 'slow';
    else if (/wifi|wi-fi/.test(s)) category = 'wifi';
    else if (/router|роутер|onu|ont/.test(s)) category = 'equipment';
    else if (/lan|кабель/.test(s)) category = 'lan';
    return { action: 'choose_type', department: 'tech', category };
  }
  if (/login|логин|shartnoma|договор|abonent|абонент|tarifni o['’]?zgart|almasht|смен.*тариф|pauza|приостанов|statik ip|статич.*ip/.test(s)) {
    let category = 'account_data';
    if (/tarif|тариф/.test(s)) category = 'tariff_change';
    else if (/pauza|приостанов/.test(s)) category = 'suspension';
    else if (/statik ip|статич.*ip/.test(s)) category = 'static_ip';
    return { action: 'choose_type', department: 'subscriber', category };
  }
  return { action: 'departments' };
}

export const languageKeyboard = () => inlineKeyboard([[
  { text: '🇺🇿 O‘zbekcha', callback_data: 'lang:uz' },
  { text: '🇷🇺 Русский', callback_data: 'lang:ru' }
]]);

export const homeKeyboard = lang => inlineKeyboard([
  [{ text: L(lang, '🏢 Bo‘limlar', '🏢 Отделы'), callback_data: 'home:departments' }],
  [{ text: L(lang, '📶 Tariflar', '📶 Тарифы'), callback_data: 'home:tariffs' }, { text: '📺 HopHop TV', callback_data: 'home:tv' }],
  [{ text: L(lang, '👤 Profilim', '👤 Мой профиль'), callback_data: 'home:profile' }, { text: L(lang, '📂 Murojaatlarim', '📂 Мои обращения'), callback_data: 'home:tickets' }],
  [{ text: L(lang, '🎁 Aksiyalar', '🎁 Акции'), callback_data: 'home:promo' }, { text: L(lang, '☎️ Aloqa', '☎️ Контакты'), callback_data: 'home:contacts' }],
  [{ text: L(lang, 'ℹ️ FiberNet haqida', 'ℹ️ О FiberNet'), callback_data: 'home:about' }, { text: L(lang, '🌐 Til', '🌐 Язык'), callback_data: 'home:language' }]
]);

export const departmentsKeyboard = lang => inlineKeyboard([
  [{ text: L(lang, '🛠 Texnik yordam', '🛠 Техподдержка'), callback_data: 'dept:tech' }],
  [{ text: L(lang, '👥 Abonent bo‘limi', '👥 Абонентский отдел'), callback_data: 'dept:subscriber' }],
  [{ text: L(lang, '💳 Buxgalteriya', '💳 Бухгалтерия'), callback_data: 'dept:accounting' }],
  [{ text: L(lang, '🔌 Ulanish bo‘limi', '🔌 Отдел подключений'), callback_data: 'dept:connection' }],
  [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
]);

export const customerTypeKeyboard = (department, lang, suggestedCategory = 'other') => inlineKeyboard([
  [{ text: L(lang, '👤 Jismoniy shaxs', '👤 Физическое лицо'), callback_data: `type:${department}:physical:${suggestedCategory}` }],
  [{ text: L(lang, '🏢 Yuridik shaxs', '🏢 Юридическое лицо'), callback_data: `type:${department}:legal:${suggestedCategory}` }],
  [{ text: L(lang, '⬅️ Bo‘limlar', '⬅️ Отделы'), callback_data: 'home:departments' }]
]);

export const techIssuesKeyboard = (type, lang) => inlineKeyboard([
  [{ text: L(lang, '🚫 Internet yo‘q', '🚫 Нет интернета'), callback_data: `issue:tech:${type}:no_internet` }, { text: L(lang, '🐢 Internet sekin', '🐢 Низкая скорость'), callback_data: `issue:tech:${type}:slow` }],
  [{ text: '📡 Wi‑Fi', callback_data: `issue:tech:${type}:wifi` }, { text: '📺 IPTV / HopHop', callback_data: `issue:tech:${type}:iptv` }],
  [{ text: L(lang, '🔧 ONU / router', '🔧 ONU / роутер'), callback_data: `issue:tech:${type}:equipment` }, { text: L(lang, '🔌 Kabel / LAN', '🔌 Кабель / LAN'), callback_data: `issue:tech:${type}:lan` }],
  [{ text: L(lang, '📝 Boshqa texnik muammo', '📝 Другая тех. проблема'), callback_data: `issue:tech:${type}:other` }],
  [{ text: L(lang, '⬅️ Mijoz turi', '⬅️ Тип клиента'), callback_data: 'dept:tech' }]
]);

export const subscriberIssuesKeyboard = (type, lang) => inlineKeyboard([
  [{ text: L(lang, '🔄 Tarifni o‘zgartirish', '🔄 Смена тарифа'), callback_data: `issue:subscriber:${type}:tariff_change` }],
  [{ text: L(lang, '🔐 Login / shartnoma', '🔐 Логин / договор'), callback_data: `issue:subscriber:${type}:account_data` }],
  [{ text: L(lang, '⏸ To‘xtatish / faollashtirish', '⏸ Приостановка / активация'), callback_data: `issue:subscriber:${type}:suspension` }],
  [{ text: L(lang, '🌐 Statik IP', '🌐 Статический IP'), callback_data: `issue:subscriber:${type}:static_ip` }],
  ...(type === 'legal' ? [[{ text: L(lang, '🏢 Yuridik hujjatlar', '🏢 Документы юрлица'), callback_data: `issue:subscriber:${type}:legal_docs` }]] : []),
  [{ text: L(lang, '📝 Boshqa abonent masalasi', '📝 Другой вопрос'), callback_data: `issue:subscriber:${type}:other` }],
  [{ text: L(lang, '⬅️ Mijoz turi', '⬅️ Тип клиента'), callback_data: 'dept:subscriber' }]
]);

export const accountingIssuesKeyboard = lang => inlineKeyboard([
  [{ text: L(lang, '💸 To‘lov tushmagan', '💸 Платёж не зачислен'), callback_data: 'issue:accounting:none:payment_missing' }],
  [{ text: L(lang, '💰 Balans / qarzdorlik', '💰 Баланс / задолженность'), callback_data: 'issue:accounting:none:balance' }],
  [{ text: L(lang, '🧾 Hisob / hujjatlar', '🧾 Счёт / документы'), callback_data: 'issue:accounting:none:documents' }],
  [{ text: L(lang, '📝 Boshqa moliyaviy savol', '📝 Другой финансовый вопрос'), callback_data: 'issue:accounting:none:other' }],
  [{ text: L(lang, '⬅️ Bo‘limlar', '⬅️ Отделы'), callback_data: 'home:departments' }]
]);

export const connectionIssuesKeyboard = lang => inlineKeyboard([
  [{ text: L(lang, '🔌 Yangi ulanish', '🔌 Новое подключение'), callback_data: 'issue:connection:none:connection' }],
  [{ text: L(lang, '📍 Manzilni tekshirish', '📍 Проверить адрес'), callback_data: 'issue:connection:none:coverage' }],
  [{ text: L(lang, '📶 Tarif tanlash', '📶 Подбор тарифа'), callback_data: 'home:tariffs' }],
  [{ text: L(lang, '⬅️ Bo‘limlar', '⬅️ Отделы'), callback_data: 'home:departments' }]
]);

export const diagnosticKeyboard = (department, type, category, lang) => inlineKeyboard([
  [{ text: L(lang, '✅ Muammo hal bo‘ldi', '✅ Проблема решена'), callback_data: 'home:main' }],
  [{ text: L(lang, '👨‍💻 Operatorga murojaat', '👨‍💻 Обратиться к оператору'), callback_data: `assist:${department}:${type}:${category}` }],
  [{ text: L(lang, '⬅️ Orqaga', '⬅️ Назад'), callback_data: department === 'tech' ? `type:tech:${type}:other` : department === 'subscriber' ? `type:subscriber:${type}:other` : `dept:${department}` }]
]);

export const identifierChoiceKeyboard = (department, lang) => inlineKeyboard([
  ...(department === 'connection' ? [] : [[{ text: L(lang, '🔐 Login / shartnoma bilan', '🔐 По логину / договору'), callback_data: 'intake:login' }]]),
  [{ text: L(lang, '📍 Manzil bilan', '📍 По адресу'), callback_data: 'intake:address' }],
  [{ text: L(lang, '❌ Bekor qilish', '❌ Отмена'), callback_data: 'intake:cancel' }]
]);

export const operatorKeyboard = no => inlineKeyboard([
  [{ text: '👨‍💻 Qabul qilish', callback_data: `op:claim:${no}` }, { text: '💬 Javob berish', callback_data: `op:reply:${no}` }],
  [{ text: '⏳ Mijozni kutish', callback_data: `op:wait:${no}` }, { text: '✅ Hal qilindi', callback_data: `op:resolve:${no}` }],
  [{ text: '❌ Murojaatni yopish', callback_data: `op:close:${no}` }]
]);
