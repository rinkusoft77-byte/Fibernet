export const URLS = {
  homeUz: "https://www.fibernet.uz/language/uz/uz/",
  homeRu: "https://www.fibernet.uz/",
  home: "https://www.fibernet.uz/language/uz/uz/",
  tariffs: "https://www.fibernet.uz/language/uz/tariflar/",
  tezkor: "https://www.fibernet.uz/language/uz/tariflar/7945-2/",
  online: "https://www.fibernet.uz/language/uz/tariflar/online-new/",
  faq: "https://www.fibernet.uz/language/uz/savol-va-javoblar/",
  settings: "https://www.fibernet.uz/language/uz/sozlamalar/",
  speed: "https://www.fibernet.uz/language/uz/tezlik-sinovi/",
  services: "https://www.fibernet.uz/language/uz/dop_uslugi_uz/",
  connect: "https://www.fibernet.uz/language/uz/meni-ulang-2/",
  contactsUz: "https://www.fibernet.uz/language/uz/aloqa-uchun/",
  contactsRu: "https://www.fibernet.uz/contacts/",
  promotionsUz: "https://www.fibernet.uz/language/uz/sales/faol-chegirma/",
  promotionsRu: "https://www.fibernet.uz/sales/aktivnaya-skidka/",
  cabinet: "https://cabinet.fibernet.uz/"
};

// Official FiberNet website artwork. Telegram can fetch HTTPS images directly.
export const MEDIA = {
  homeBanner: "https://www.fibernet.uz/wp-content/uploads/banner_site.png",
  promoUz: "https://www.fibernet.uz/wp-content/uploads/active-discount-content_UZ-1.png",
  promoRu: "https://www.fibernet.uz/wp-content/uploads/active-discount-content_%D1%80%D1%83.png"
};

export const CONTACTS = {
  phone: "+998 71 200-47-47",
  infoEmail: "info@fibernet.uz",
  supportEmail: "support@fibernet.uz",
  financeEmail: "office@fibernet.uz",
  addressUz: "Toshkent sh., Aviasozlar ko‘chasi, 1-tor ko‘cha, 22-uy",
  addressRu: "г. Ташкент, 1-й проезд Авиасозлар, дом 22"
};

export const FALLBACK_TARIFFS = {
  tezkor: [
    { name: "TEZKOR-100", price: 160000, evening: 100, daytime: 200, tasix: 200, router: "25 000 so‘m/oy", tv: "170" },
    { name: "TEZKOR-150", price: 180000, evening: 150, daytime: 200, tasix: 200, router: "25 000 so‘m/oy", tv: "170" },
    { name: "TEZKOR-200", price: 200000, evening: 200, daytime: 200, tasix: 200, router: "25 000 so‘m/oy", tv: "170" },
    { name: "TEZKOR-300", price: 300000, evening: 300, daytime: 300, tasix: 300, router: "25 000 so‘m/oy", tv: "170" },
    { name: "TEZKOR-500", price: 500000, evening: 500, daytime: 500, tasix: 500, router: "25 000 so‘m/oy", tv: "170" },
    { name: "TEZKOR-1000", price: 1000000, evening: 1000, daytime: 1000, tasix: 1000, router: "25 000 so‘m/oy", tv: "170" }
  ],
  online: [
    { name: "OnLine-5", price: 85000, evening: 5, daytime: 100, tasix: 100 },
    { name: "OnLine-8", price: 95000, evening: 8, daytime: 100, tasix: 100 },
    { name: "OnLine-20", price: 105000, evening: 20, daytime: 100, tasix: 100 },
    { name: "OnLine-25", price: 115000, evening: 25, daytime: 100, tasix: 100 },
    { name: "OnLine-30", price: 125000, evening: 30, daytime: 100, tasix: 100 },
    { name: "OnLine-40", price: 135000, evening: 40, daytime: 100, tasix: 100 },
    { name: "OnLine-50", price: 155000, evening: 50, daytime: 100, tasix: 100 },
    { name: "OnLine-60", price: 165000, evening: 60, daytime: 100, tasix: 100 },
    { name: "OnLine-80", price: 175000, evening: 80, daytime: 100, tasix: 100 },
    { name: "OnLine-100", price: 195000, evening: 100, daytime: 100, tasix: 100 }
  ]
};

export const POPULAR_SERVICES = [
  ["Wi‑Fi sozlash", "30 000 so‘m"],
  ["Kompyuterda tarmoqni sozlash", "30 000 so‘m"],
  ["LAN sozlash", "30 000 so‘m"],
  ["Tarmoq uskunasi diagnostikasi", "30 000 so‘m"],
  ["IPTV sozlash", "25 000 so‘m"],
  ["TV/pristavka sozlash", "20 000 so‘m"],
  ["Router yetkazib berish", "30 000 so‘m"],
  ["Ustani chaqirish", "25 000 so‘m"]
];

export const DIAGNOSTICS = {
  uz: {
    no_internet: `<b>🚫 Internet ishlamayapti</b>\n\n1️⃣ Shaxsiy kabinetda balansni tekshiring.\n2️⃣ ONU/modem va routerni 60 soniyaga o‘chirib, qayta yoqing.\n3️⃣ Optik qurilmada <b>LOS</b> qizil yonayotgan bo‘lsa, optik kabelni bukmang yoki ajratmang.\n4️⃣ Ethernet kabeli va routerning WAN indikatorini tekshiring.`,
    slow: `<b>🐢 Internet sekin</b>\n\n1️⃣ Tezlikni imkon qadar kabel orqali tekshiring.\n2️⃣ Wi‑Fi bo‘lsa, routerga yaqinlashing va 5 GHz tarmoqdan foydalaning.\n3️⃣ Fon yuklamalari, Windows Update, torrent va boshqa qurilmalarni vaqtincha to‘xtating.\n4️⃣ Router/ONU ni qayta ishga tushiring va testni takrorlang.`,
    wifi: `<b>📡 Wi‑Fi muammosi</b>\n\n1️⃣ Routerni ochiq va balandroq joyga qo‘ying.\n2️⃣ 5 GHz — tezroq, 2.4 GHz — uzoqroq masofaga.\n3️⃣ Routerni qayta yoqing.\n4️⃣ Wi‑Fi parolini begona qurilmalar ulanmasligi uchun yangilang.`,
    iptv: `<b>📺 IPTV / TV muammosi</b>\n\n1️⃣ Avval internet ishlayotganini tekshiring.\n2️⃣ Router va TV/pristavkani qayta yoqing.\n3️⃣ Ilovani yopib qayta oching.\n4️⃣ Muammo faqat bitta kanal yoki barcha kanallarda ekanini aniqlang.`,
    billing: `<b>💳 To‘lov / shaxsiy kabinet</b>\n\nBalans va tarif holatini shaxsiy kabinetdan tekshiring. Tarifni o‘zgartirish uchun yangi tarif qiymatiga yetarli depozit talab qilinishi mumkin.\n\n🔐 Bot hech qachon kabinet parolingizni so‘ramaydi.`,
    other: `<b>📝 Boshqa muammo</b>\n\nOperatorga murojaat yuborish uchun ticket oching. Muammoni aniq yozing: qachondan boshlangan, qaysi qurilmalarda va indikatorlar holati.`
  },
  ru: {
    no_internet: `<b>🚫 Нет интернета</b>\n\n1️⃣ Проверьте баланс в личном кабинете.\n2️⃣ Отключите ONU/модем и роутер на 60 секунд, затем включите.\n3️⃣ Если на оптическом терминале красным горит <b>LOS</b>, не сгибайте и не отсоединяйте оптоволокно.\n4️⃣ Проверьте Ethernet-кабель и индикатор WAN на роутере.`,
    slow: `<b>🐢 Низкая скорость</b>\n\n1️⃣ По возможности измерьте скорость по кабелю.\n2️⃣ По Wi‑Fi подойдите ближе к роутеру и используйте 5 GHz.\n3️⃣ Временно остановите фоновые загрузки, Windows Update, торренты и другие устройства.\n4️⃣ Перезагрузите роутер/ONU и повторите тест.`,
    wifi: `<b>📡 Проблема с Wi‑Fi</b>\n\n1️⃣ Поставьте роутер выше и на открытом месте.\n2️⃣ 5 GHz быстрее, 2.4 GHz лучше работает на расстоянии.\n3️⃣ Перезагрузите роутер.\n4️⃣ Обновите пароль Wi‑Fi, чтобы исключить посторонние подключения.`,
    iptv: `<b>📺 Проблема IPTV / ТВ</b>\n\n1️⃣ Сначала проверьте, работает ли интернет.\n2️⃣ Перезагрузите роутер и ТВ/приставку.\n3️⃣ Перезапустите приложение.\n4️⃣ Уточните, проблема на одном канале или на всех.`,
    billing: `<b>💳 Оплата / личный кабинет</b>\n\nПроверьте баланс и тариф в личном кабинете. Для смены тарифа может потребоваться депозит не ниже стоимости нового тарифа.\n\n🔐 Бот никогда не запрашивает пароль от личного кабинета.`,
    other: `<b>📝 Другая проблема</b>\n\nСоздайте заявку оператору. Опишите, когда началась проблема, на каких устройствах и какие индикаторы горят.`
  }
};
