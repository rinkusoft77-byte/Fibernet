import { inlineKeyboard } from "./telegram.js";

export const L = (lang, uz, ru) => lang === "ru" ? ru : uz;

export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 9) digits = `998${digits}`;
  if (digits.length === 10 && digits.startsWith("0")) digits = `998${digits.slice(1)}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function operatorName(from = {}) {
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id || "operator");
}

export function departmentMeta(dept, lang = "uz") {
  return ({
    tech: { icon: "🛠", title: L(lang, "Texnik yordam", "Техподдержка") },
    accounting: { icon: "💳", title: L(lang, "Buxgalteriya", "Бухгалтерия") },
    subscriber: { icon: "👥", title: L(lang, "Abonent bo‘limi", "Абонентский отдел") },
    connection: { icon: "🔌", title: L(lang, "Ulanish bo‘limi", "Отдел подключений") }
  })[dept] || { icon: "🛠", title: L(lang, "Texnik yordam", "Техподдержка") };
}

export function categoryMeta(cat, lang = "uz") {
  return ({
    no_internet: { icon: "🚫", title: L(lang, "Internet yo‘q", "Нет интернета") },
    slow: { icon: "🐢", title: L(lang, "Internet sekin", "Низкая скорость") },
    wifi: { icon: "📡", title: "Wi‑Fi" },
    iptv: { icon: "📺", title: "IPTV / TV" },
    equipment: { icon: "🔧", title: L(lang, "ONU / router", "ONU / роутер") },
    payment_missing: { icon: "💸", title: L(lang, "To‘lov tushmagan", "Платёж не зачислен") },
    balance: { icon: "💰", title: L(lang, "Balans / qarzdorlik", "Баланс / задолженность") },
    documents: { icon: "🧾", title: L(lang, "Hisob / hujjatlar", "Счёт / документы") },
    tariff_change: { icon: "🔄", title: L(lang, "Tarifni o‘zgartirish", "Смена тарифа") },
    account_data: { icon: "🔐", title: L(lang, "Login / shartnoma", "Логин / договор") },
    suspension: { icon: "⏸", title: L(lang, "Xizmatni to‘xtatish / yoqish", "Приостановка / активация") },
    connection: { icon: "🔌", title: L(lang, "Yangi ulanish", "Новое подключение") },
    other: { icon: "📝", title: L(lang, "Boshqa murojaat", "Другое обращение") }
  })[cat] || { icon: "📝", title: L(lang, "Boshqa murojaat", "Другое обращение") };
}

export function priorityFor(category, text = "") {
  const s = String(text).toLowerCase();
  if (/\blos\b|qizil|красн|avari|авари|optik|обрыв|uzil/.test(s)) return "critical";
  if (category === "no_internet" || category === "payment_missing") return "high";
  if (category === "connection") return "low";
  return "normal";
}

export function classifyText(text = "") {
  const s = String(text).toLowerCase().trim();
  if (!s) return { action: "home" };
  if (/^(salom|assalom|привет|здравствуйте|hello|menu|меню)[!,. ]*$/.test(s)) return { action: "home" };
  if (/tarif|тариф|tezkor|online/.test(s) && !/o['’]?zgart|смен/.test(s)) return { action: "tariffs" };
  if (/ulanish|ulanmoq|подключ|connect|yangi internet|новый интернет/.test(s)) return { action: "ticket", department: "connection", category: "connection" };
  if (/to['’]?lov|оплат|balans|баланс|qarz|долг|kvit|чек|hisob|сч[её]т/.test(s)) {
    return { action: "ticket", department: "accounting", category: /tushm|не зачис|не приш/.test(s) ? "payment_missing" : "balance" };
  }
  if (/login|логин|shartnoma|договор|abonent|абонент|tarifni o['’]?zgart|смен.*тариф|pauza|приостанов/.test(s)) {
    const category = /tarif|тариф/.test(s) ? "tariff_change" : /pauza|приостанов/.test(s) ? "suspension" : "account_data";
    return { action: "ticket", department: "subscriber", category };
  }
  if (/wifi|wi-fi|internet|интернет|los|router|роутер|onu|ont|скорост|sekin|медлен|uzil|обрыв|tv|iptv|телев/.test(s)) {
    let category = "other";
    if (/yo['’]?q|нет интернет|не работает интернет|los/.test(s)) category = "no_internet";
    else if (/sekin|скорост|медлен/.test(s)) category = "slow";
    else if (/wifi|wi-fi/.test(s)) category = "wifi";
    else if (/tv|iptv|телев/.test(s)) category = "iptv";
    else if (/router|роутер|onu|ont/.test(s)) category = "equipment";
    return { action: "ticket", department: "tech", category };
  }
  return { action: "departments" };
}

export const languageKeyboard = () => inlineKeyboard([[
  { text: "🇺🇿 O‘zbekcha", callback_data: "lang:uz" },
  { text: "🇷🇺 Русский", callback_data: "lang:ru" }
]]);

export const homeKeyboard = lang => inlineKeyboard([
  [
    { text: L(lang, "🛠 Texnik yordam", "🛠 Техподдержка"), callback_data: "home:tech" },
    { text: L(lang, "💳 Buxgalteriya", "💳 Бухгалтерия"), callback_data: "home:accounting" }
  ],
  [
    { text: L(lang, "👥 Abonent bo‘limi", "👥 Абонентский отдел"), callback_data: "home:subscriber" },
    { text: L(lang, "🔌 Ulanish", "🔌 Подключение"), callback_data: "ticket:new:connection:connection" }
  ],
  [
    { text: L(lang, "📶 Tariflar", "📶 Тарифы"), callback_data: "home:tariffs" },
    { text: L(lang, "📂 Murojaatlarim", "📂 Мои обращения"), callback_data: "home:tickets" }
  ],
  [
    { text: L(lang, "👤 Profilim", "👤 Мой профиль"), callback_data: "home:profile" },
    { text: L(lang, "🧰 Xizmatlar", "🧰 Услуги"), callback_data: "home:services" }
  ],
  [
    { text: L(lang, "🎁 Aksiyalar", "🎁 Акции"), callback_data: "home:promo" },
    { text: L(lang, "☎️ Aloqa", "☎️ Контакты"), callback_data: "home:contacts" }
  ],
  [{ text: L(lang, "🌐 Til", "🌐 Язык"), callback_data: "home:language" }]
]);

export const techKeyboard = lang => inlineKeyboard([
  [{ text: L(lang, "🚫 Internet yo‘q", "🚫 Нет интернета"), callback_data: "diag:no_internet" }, { text: L(lang, "🐢 Internet sekin", "🐢 Низкая скорость"), callback_data: "diag:slow" }],
  [{ text: "📡 Wi‑Fi", callback_data: "diag:wifi" }, { text: "📺 IPTV / TV", callback_data: "diag:iptv" }],
  [{ text: L(lang, "🔧 ONU / router", "🔧 ONU / роутер"), callback_data: "diag:equipment" }],
  [{ text: L(lang, "📝 Boshqa muammo", "📝 Другая проблема"), callback_data: "ticket:new:tech:other" }],
  [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
]);

export const accountingKeyboard = lang => inlineKeyboard([
  [{ text: L(lang, "💸 To‘lov tushmagan", "💸 Платёж не зачислен"), callback_data: "ticket:new:accounting:payment_missing" }],
  [{ text: L(lang, "💰 Balans / qarzdorlik", "💰 Баланс / задолженность"), callback_data: "ticket:new:accounting:balance" }],
  [{ text: L(lang, "🧾 Hisob / hujjatlar", "🧾 Счёт / документы"), callback_data: "ticket:new:accounting:documents" }],
  [{ text: L(lang, "📝 Boshqa savol", "📝 Другой вопрос"), callback_data: "ticket:new:accounting:other" }],
  [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
]);

export const subscriberKeyboard = lang => inlineKeyboard([
  [{ text: L(lang, "🔄 Tarifni o‘zgartirish", "🔄 Смена тарифа"), callback_data: "ticket:new:subscriber:tariff_change" }],
  [{ text: L(lang, "🔐 Login / shartnoma", "🔐 Логин / договор"), callback_data: "ticket:new:subscriber:account_data" }],
  [{ text: L(lang, "⏸ To‘xtatish / faollashtirish", "⏸ Приостановка / активация"), callback_data: "ticket:new:subscriber:suspension" }],
  [{ text: L(lang, "📝 Boshqa savol", "📝 Другой вопрос"), callback_data: "ticket:new:subscriber:other" }],
  [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
]);

export const departmentsKeyboard = lang => inlineKeyboard([
  [{ text: L(lang, "🛠 Texnik yordam", "🛠 Техподдержка"), callback_data: "home:tech" }],
  [{ text: L(lang, "💳 Buxgalteriya", "💳 Бухгалтерия"), callback_data: "home:accounting" }],
  [{ text: L(lang, "👥 Abonent bo‘limi", "👥 Абонентский отдел"), callback_data: "home:subscriber" }],
  [{ text: L(lang, "🔌 Ulanish", "🔌 Подключение"), callback_data: "ticket:new:connection:connection" }],
  [{ text: L(lang, "🏠 Bosh menyu", "🏠 Главное меню"), callback_data: "home:main" }]
]);

export const operatorKeyboard = no => inlineKeyboard([
  [{ text: "👨‍💻 Qabul qilish", callback_data: `op:claim:${no}` }, { text: "⏳ Mijozni kutish", callback_data: `op:wait:${no}` }],
  [{ text: "✅ Hal qilindi", callback_data: `op:resolve:${no}` }, { text: "❌ Yopish", callback_data: `op:close:${no}` }]
]);

export function diagnosticText(lang, category) {
  const m = categoryMeta(category, lang);
  const text = ({
    no_internet: L(lang,
      "1) ONU/ONT va routerni 60 soniyaga o‘chirib qayta yoqing.\n2) <b>LOS qizil</b> bo‘lsa optik kabelni bukmang yoki ajratmang.\n3) WAN/Ethernet indikatorlarini tekshiring.\n4) Muammo qolsa operatorga murojaat yuboring.",
      "1) Перезагрузите ONU/ONT и роутер на 60 секунд.\n2) Если <b>LOS красный</b>, не сгибайте и не отсоединяйте оптоволокно.\n3) Проверьте WAN/Ethernet.\n4) Если проблема осталась, отправьте обращение оператору."
    ),
    slow: L(lang,
      "1) Yuklamalarni vaqtincha to‘xtating.\n2) 5 GHz tarmoqni router yonida tekshiring.\n3) Iloji bo‘lsa kabel bilan solishtiring.\n4) Test natijasini murojaatda yozing.",
      "1) Остановите фоновые загрузки.\n2) Проверьте 5 GHz рядом с роутером.\n3) По возможности сравните по кабелю.\n4) Укажите результат теста в обращении."
    ),
    wifi: L(lang,
      "1) Routerni ochiq va markaziy joyga qo‘ying.\n2) 5 GHz — tezroq, 2.4 GHz — uzoqroq.\n3) Routerni qayta yoqing.\n4) Uzilish davom etsa operatorga yozing.",
      "1) Разместите роутер открыто и ближе к центру.\n2) 5 GHz быстрее, 2.4 GHz дальше.\n3) Перезагрузите роутер.\n4) Если обрывы остаются, напишите оператору."
    ),
    iptv: L(lang,
      "1) Internet ishlayotganini tekshiring.\n2) Router va TV/pristavkani qayta yoqing.\n3) Muammo bitta kanalmi yoki barcha kanallardami — murojaatda yozing.",
      "1) Проверьте интернет.\n2) Перезагрузите роутер и ТВ/приставку.\n3) Укажите, проблема на одном канале или на всех."
    ),
    equipment: L(lang,
      "ONU/ONT yoki router indikatorlari holatini tekshiring. Qizil LOS yoki qurilma umuman yonmasa operatorga murojaat yuboring.",
      "Проверьте индикаторы ONU/ONT и роутера. При красном LOS или если устройство не включается, отправьте обращение оператору."
    )
  })[category] || L(lang, "Muammoni yozib operatorga yuboring.", "Опишите проблему и отправьте оператору.");
  return `${m.icon} <b>${m.title}</b>\n\n${text}`;
}
