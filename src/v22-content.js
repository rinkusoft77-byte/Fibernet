import { MEDIA } from './config.js';
import { getUser, upsertUser } from './v5-db.js';
import { L } from './v8-ui.js';
import {
  answerCallback, escapeHtml, inlineKeyboard, sendChatAction, sendMessage, sendPhoto
} from './telegram.js';

let ready = false;

export const OFFICIAL = {
  siteUz: 'https://www.fibernet.uz/language/uz/uz/',
  siteRu: 'https://www.fibernet.uz/',
  channel: 'https://t.me/fibernet_channel',
  techTelegram: 'https://t.me/fibernet_tex',
  subscriberTelegram: 'https://t.me/fibernet_abonent',
  cabinet: 'https://cabinet.fibernet.uz/',
  tariffsUz: 'https://www.fibernet.uz/language/uz/tariflar/',
  tariffsRu: 'https://www.fibernet.uz/tariff/',
  tezkorUz: 'https://www.fibernet.uz/language/uz/tariflar/7945-2/',
  tezkorRu: 'https://www.fibernet.uz/tariff/tarify-tezkor/',
  onlineUz: 'https://www.fibernet.uz/language/uz/tariflar/online/',
  onlineRu: 'https://www.fibernet.uz/tariff/online/',
  connectUz: 'https://www.fibernet.uz/language/uz/meni-ulang-2/',
  connectRu: 'https://www.fibernet.uz/connect-me/',
  paymentUz: 'https://www.fibernet.uz/language/uz/tolov-usullari/',
  paymentRu: 'https://www.fibernet.uz/payments/',
  contactsUz: 'https://www.fibernet.uz/language/uz/aloqa-uchun/',
  contactsRu: 'https://www.fibernet.uz/contacts/',
  settingsUz: 'https://www.fibernet.uz/language/uz/sozlamalar/',
  settingsRu: 'https://www.fibernet.uz/adjustment/',
  servicesUz: 'https://www.fibernet.uz/language/uz/dop_uslugi_uz/',
  servicesRu: 'https://www.fibernet.uz/dop_uslugi/',
  speedUz: 'https://www.fibernet.uz/language/uz/tezlik-sinovi/',
  speedRu: 'https://www.fibernet.uz/speed-test/',
  newsUz: 'https://www.fibernet.uz/language/uz/bildirishnomalar-va-yangiliklar/',
  newsRu: 'https://www.fibernet.uz/news-and-adjusts/'
};

export const ART = {
  home: MEDIA.homeBanner,
  connection: 'https://www.fibernet.uz/wp-content/uploads/girls-connect.png',
  payment: 'https://www.fibernet.uz/wp-content/uploads/girl-payment.png',
  promoUz: MEDIA.promoUz,
  promoRu: MEDIA.promoRu,
  support: MEDIA.homeBanner,
  tv: MEDIA.homeBanner,
  services: MEDIA.homeBanner
};

export async function ensureV22Schema(env) {
  if (ready) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fn22_media_cache (
    asset_key TEXT PRIMARY KEY,
    source_url TEXT NOT NULL,
    telegram_file_id TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  ready = true;
}

async function cachedFileId(env, key) {
  await ensureV22Schema(env);
  const row = await env.DB.prepare(
    'SELECT telegram_file_id FROM fn22_media_cache WHERE asset_key=?'
  ).bind(key).first();
  return row?.telegram_file_id || null;
}

async function saveFileId(env, key, url, result) {
  const photos = result?.photo;
  const fileId = Array.isArray(photos) && photos.length
    ? photos[photos.length - 1]?.file_id
    : null;
  if (!fileId) return;
  await env.DB.prepare(`INSERT INTO fn22_media_cache(asset_key,source_url,telegram_file_id,updated_at)
    VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(asset_key) DO UPDATE SET
      source_url=excluded.source_url,
      telegram_file_id=excluded.telegram_file_id,
      updated_at=CURRENT_TIMESTAMP`)
    .bind(key, url, fileId).run();
}

export async function premiumCard(env, chatId, {
  key, photo, caption, keyboard
}) {
  await ensureV22Schema(env);
  if (photo) {
    try {
      await sendChatAction(env, chatId, 'upload_photo');
      const cached = await cachedFileId(env, key);
      if (cached) {
        try {
          return await sendPhoto(env, chatId, cached, caption, { reply_markup: keyboard });
        } catch {
          await env.DB.prepare('UPDATE fn22_media_cache SET telegram_file_id=NULL WHERE asset_key=?')
            .bind(key).run();
        }
      }
      const result = await sendPhoto(env, chatId, photo, caption, { reply_markup: keyboard });
      await saveFileId(env, key, photo, result);
      return result;
    } catch (e) {
      console.warn('v22 premium photo fallback', key, String(e));
    }
  }
  return sendMessage(env, chatId, caption, { reply_markup: keyboard });
}

function site(lang) { return lang === 'ru' ? OFFICIAL.siteRu : OFFICIAL.siteUz; }
function tariffs(lang) { return lang === 'ru' ? OFFICIAL.tariffsRu : OFFICIAL.tariffsUz; }
function contacts(lang) { return lang === 'ru' ? OFFICIAL.contactsRu : OFFICIAL.contactsUz; }
function connect(lang) { return lang === 'ru' ? OFFICIAL.connectRu : OFFICIAL.connectUz; }
function payments(lang) { return lang === 'ru' ? OFFICIAL.paymentRu : OFFICIAL.paymentUz; }
function settings(lang) { return lang === 'ru' ? OFFICIAL.settingsRu : OFFICIAL.settingsUz; }
function services(lang) { return lang === 'ru' ? OFFICIAL.servicesRu : OFFICIAL.servicesUz; }
function speed(lang) { return lang === 'ru' ? OFFICIAL.speedRu : OFFICIAL.speedUz; }
function news(lang) { return lang === 'ru' ? OFFICIAL.newsRu : OFFICIAL.newsUz; }

export function premiumHomeKeyboard(lang) {
  return inlineKeyboard([
    [
      { text: L(lang, '🛠 Yordam', '🛠 Помощь'), callback_data: 'home:departments' },
      { text: L(lang, '📶 Tariflar', '📶 Тарифы'), callback_data: 'home:tariffs' }
    ],
    [
      { text: L(lang, '💳 To‘lov', '💳 Оплата'), callback_data: 'v22:payment' },
      { text: '📺 TV', callback_data: 'home:tv' }
    ],
    [
      { text: L(lang, '🔌 Ulanish', '🔌 Подключение'), callback_data: 'v22:connect' },
      { text: L(lang, '🧰 Xizmatlar', '🧰 Услуги'), callback_data: 'v22:services' }
    ],
    [
      { text: L(lang, '👤 Profil', '👤 Профиль'), callback_data: 'home:profile' },
      { text: L(lang, '📂 Murojaatlar', '📂 Обращения'), callback_data: 'home:tickets' }
    ],
    [
      { text: L(lang, '☎️ Aloqa', '☎️ Контакты'), callback_data: 'home:contacts' },
      { text: L(lang, '📰 Yangiliklar', '📰 Новости'), callback_data: 'v22:news' }
    ],
    [
      { text: L(lang, '🎁 Aksiyalar', '🎁 Акции'), callback_data: 'home:promo' },
      { text: L(lang, 'ℹ️ FiberNet', 'ℹ️ FiberNet'), callback_data: 'home:about' }
    ],
    [{ text: L(lang, '🌐 Til', '🌐 Язык'), callback_data: 'home:language' }]
  ]);
}

export async function showPremiumHome(env, chatId, lang) {
  const caption = L(lang,
    '🌐 <b>FiberNet Assistant</b>\n<i>Tez · Ishonchli · Qulay</i>\n\nInternet, GPON/MET, Wi‑Fi, TV, tariflar, to‘lov va operator yordami — barchasi bir joyda.\n\n🛡 Rasmiy ma’lumotlar <b>fibernet.uz</b> va <b>@fibernet_channel</b> asosida beriladi.\n\n👇 Kerakli xizmatni tanlang:',
    '🌐 <b>FiberNet Assistant</b>\n<i>Быстро · Надёжно · Удобно</i>\n\nИнтернет, GPON/MET, Wi‑Fi, ТВ, тарифы, оплата и помощь оператора — в одном месте.\n\n🛡 Информация основана на официальных источниках <b>fibernet.uz</b> и <b>@fibernet_channel</b>.\n\n👇 Выберите услугу:');
  return premiumCard(env, chatId, {
    key: 'home',
    photo: ART.home,
    caption,
    keyboard: premiumHomeKeyboard(lang)
  });
}

export async function showPremiumSupport(env, chatId, lang) {
  const caption = L(lang,
    '🛠 <b>Yordam markazi</b>\n\nBo‘lim nomini bilishingiz shart emas. Muammoni tanlang — bot kerakli diagnostika va bo‘limga o‘zi olib boradi.\n\n💡 Avval tezkor tekshiruvlar beriladi. Yechilmasa, alohida operator Topic ochiladi va operator odatda <b>5–15 daqiqa</b> ichida javob beradi.',
    '🛠 <b>Центр помощи</b>\n\nНе нужно знать название отдела. Выберите проблему — бот сам откроет нужную диагностику и маршрут.\n\n💡 Сначала будут быстрые проверки. Если не поможет, создастся отдельный Topic, где оператор обычно отвечает за <b>5–15 минут</b>.');
  const keyboard = inlineKeyboard([
    [
      { text: L(lang, '🚫 Internet yo‘q', '🚫 Нет интернета'), callback_data: 'svc:internet' },
      { text: L(lang, '🐢 Internet sekin', '🐢 Низкая скорость'), callback_data: 'svc:slow' }
    ],
    [
      { text: '📡 Wi‑Fi', callback_data: 'svc:wifi' },
      { text: '📺 IPTV / HopHop', callback_data: 'svc:tv' }
    ],
    [{ text: L(lang, '🔧 ONU / router', '🔧 ONU / роутер'), callback_data: 'svc:equipment' }],
    [{ text: L(lang, '💳 To‘lov / balans', '💳 Оплата / баланс'), callback_data: 'svc:money' }],
    [{ text: L(lang, '👤 Tarif / login / Statik IP', '👤 Тариф / логин / статический IP'), callback_data: 'svc:subscriber' }],
    [{ text: L(lang, '🔌 Yangi ulanish / manzil', '🔌 Подключение / адрес'), callback_data: 'svc:connect' }],
    [{ text: L(lang, '✍️ Muammoni yozaman', '✍️ Опишу проблему'), callback_data: 'svc:describe' }],
    [
      { text: L(lang, '⚙️ Sozlamalar', '⚙️ Настройки'), url: settings(lang) },
      { text: L(lang, '📈 Speedtest', '📈 Speedtest'), url: speed(lang) }
    ],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
  return premiumCard(env, chatId, {
    key: 'support',
    photo: ART.support,
    caption,
    keyboard
  });
}

export async function showPremiumTariffs(env, chatId, lang) {
  const caption = L(lang,
    '📶 <b>Uy uchun FiberNet tariflari</b>\n\n⚡ <b>TEZKOR</b> — 100–1000 Mbit/s gacha, 160 000 so‘mdan. Tariflarda 170 ta TV kanal ko‘rsatilgan.\n\n🌐 <b>OnLine</b> — 85 000 so‘mdan; 00:00–18:00 oralig‘ida 100 Mbit/s, kechki tezlik tarifga qarab 5–100 Mbit/s. Trafik cheklanmagan.\n\nℹ️ Tezlik abonent uskunasi va server imkoniyatiga bog‘liq. Narxlar QQS bilan.',
    '📶 <b>Домашние тарифы FiberNet</b>\n\n⚡ <b>TEZKOR</b> — до 100–1000 Мбит/с, от 160 000 сум. В тарифах указано 170 ТВ‑каналов.\n\n🌐 <b>OnLine</b> — от 85 000 сум; с 00:00 до 18:00 — 100 Мбит/с, вечером 5–100 Мбит/с по тарифу. Трафик безлимитный.\n\nℹ️ Скорость зависит от оборудования и сервера. Цены включают НДС.');
  const keyboard = inlineKeyboard([
    [
      { text: '⚡ TEZKOR', callback_data: 'tariff:tezkor:0' },
      { text: '🌐 OnLine', callback_data: 'tariff:online:0' }
    ],
    [
      { text: L(lang, '📋 Rasmiy tariflar', '📋 Официальные тарифы'), url: tariffs(lang) },
      { text: L(lang, '🔌 Ulanish', '🔌 Подключиться'), callback_data: 'v22:connect' }
    ],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
  return premiumCard(env, chatId, {
    key: 'tariffs',
    photo: ART.home,
    caption,
    keyboard
  });
}

export async function showPremiumTV(env, chatId, lang) {
  const caption = L(lang,
    '📺 <b>FiberNet TV</b>\n\nRasmiy tarif sahifalarida <b>170 ta TV kanal</b> ko‘rsatilgan. Ayrim yuqori tariflarda onlayn kino xizmatlari ham mavjud.\n\nTV ishlamasa: internetni tekshiring → router/TV qurilmasini qayta yoqing → muammo barcha kanallardami aniqlang → kerak bo‘lsa Texnik yordamga yuboring.',
    '📺 <b>FiberNet TV</b>\n\nНа официальных тарифных страницах указано <b>170 ТВ‑каналов</b>. На некоторых старших тарифах доступны онлайн‑кинотеатры.\n\nЕсли ТВ не работает: проверьте интернет → перезагрузите роутер/ТВ → уточните, проблема на всех каналах или одном → при необходимости откройте техподдержку.');
  const keyboard = inlineKeyboard([
    [{ text: L(lang, '🛠 TV bo‘yicha yordam', '🛠 Помощь по ТВ'), callback_data: 'svc:tv' }],
    [{ text: L(lang, '📶 Tariflarni ko‘rish', '📶 Смотреть тарифы'), callback_data: 'home:tariffs' }],
    [{ text: L(lang, '🌐 Rasmiy sayt', '🌐 Официальный сайт'), url: tariffs(lang) }],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
  return premiumCard(env, chatId, { key:'tv', photo:ART.tv, caption, keyboard });
}

export async function showPremiumPayment(env, chatId, lang) {
  const caption = L(lang,
    '💳 <b>FiberNet to‘lovlari</b>\n\nRasmiy sahifada bank/MUNIS, UZPAYNET, Payme, CLICK va U‑PAY orqali to‘lov usullari ko‘rsatilgan.\n\n✅ To‘lovda <b>login</b> va summani tekshiring.\n🧾 Muammo bo‘lsa chekni saqlang.\n🔐 Bot karta ma’lumoti yoki kabinet parolini so‘ramaydi.',
    '💳 <b>Оплата FiberNet</b>\n\nНа официальной странице указаны оплата через банки/МУНИС, UZPAYNET, Payme, CLICK и U‑PAY.\n\n✅ Проверяйте <b>логин</b> и сумму.\n🧾 При проблеме сохраните чек.\n🔐 Бот не запрашивает данные карты или пароль кабинета.');
  const keyboard = inlineKeyboard([
    [{ text: L(lang, '🌐 To‘lov qo‘llanmasi', '🌐 Инструкция по оплате'), url: payments(lang) }],
    [{ text: L(lang, '💸 To‘lov tushmadi', '💸 Платёж не зачислен'), callback_data: 'issue:accounting:none:payment_missing' }],
    [{ text: L(lang, '💰 Balans / qarzdorlik', '💰 Баланс / задолженность'), callback_data: 'issue:accounting:none:balance' }],
    [{ text: L(lang, '👤 Shaxsiy kabinet', '👤 Личный кабинет'), url: OFFICIAL.cabinet }],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
  return premiumCard(env, chatId, { key:'payment', photo:ART.payment, caption, keyboard });
}

export async function showPremiumConnect(env, chatId, lang) {
  const caption = L(lang,
    '🔌 <b>FiberNet’ga ulanish</b>\n\n1️⃣ Manzil bo‘yicha texnik imkoniyat tekshiriladi.\n2️⃣ Ulanish sanasi va vaqti kelishiladi.\n3️⃣ Shartnoma va tarif tanlanadi.\n4️⃣ Xodimlar ulaydi va ishlashini tekshiradi.\n\n✨ Rasmiy saytda FiberNet ulanishi bepul ekani ko‘rsatilgan.',
    '🔌 <b>Подключение FiberNet</b>\n\n1️⃣ Проверяется техническая возможность по адресу.\n2️⃣ Согласовываются дата и время.\n3️⃣ Подписывается договор и выбирается тариф.\n4️⃣ Специалисты подключают и проверяют услугу.\n\n✨ На официальном сайте указано, что подключение к FiberNet бесплатное.');
  const keyboard = inlineKeyboard([
    [{ text: L(lang, '📍 Manzilni tekshirish', '📍 Проверить адрес'), callback_data: 'issue:connection:none:coverage' }],
    [{ text: L(lang, '🔌 Ulanish uchun murojaat', '🔌 Заявка на подключение'), callback_data: 'issue:connection:none:connection' }],
    [{ text: L(lang, '🌐 Rasmiy yo‘riqnoma', '🌐 Официальная инструкция'), url: connect(lang) }],
    [{ text: L(lang, '📶 Tariflar', '📶 Тарифы'), callback_data: 'home:tariffs' }],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
  return premiumCard(env, chatId, { key:'connect', photo:ART.connection, caption, keyboard });
}

export async function showPremiumServices(env, chatId, lang) {
  const caption = L(lang,
    '🧰 <b>Qo‘shimcha xizmatlar</b>\n\nFiberNet rasmiy sahifalarida quyidagi xizmatlar ko‘rsatilgan:\n\n🌐 Statik IP\n📺 IPTV sozlash\n🔌 LAN/tarmoq sozlash\n🛡 Wi‑Fi xavfsizligini sozlash\n🔄 Tarifni almashtirish\n🚫 Portni bloklash\n\nNarx va mavjudlik xizmat turiga qarab farq qilishi mumkin.',
    '🧰 <b>Дополнительные услуги</b>\n\nНа официальных страницах FiberNet указаны:\n\n🌐 Статический IP\n📺 Настройка IPTV\n🔌 Настройка LAN/сети\n🛡 Настройка безопасности Wi‑Fi\n🔄 Смена тарифа\n🚫 Блокировка порта\n\nСтоимость и доступность зависят от услуги.');
  const keyboard = inlineKeyboard([
    [{ text: L(lang, '🌐 Statik IP', '🌐 Статический IP'), callback_data: 'issue:subscriber:physical:static_ip' }],
    [{ text: L(lang, '📋 Rasmiy xizmatlar', '📋 Официальные услуги'), url: services(lang) }],
    [{ text: L(lang, '🛠 Texnik yordam', '🛠 Техподдержка'), callback_data: 'home:departments' }],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
  return premiumCard(env, chatId, { key:'services', photo:ART.services, caption, keyboard });
}

export async function showPremiumContacts(env, chatId, lang) {
  const caption = L(lang,
    '☎️ <b>FiberNet kontaktlari</b>\n\n🛠 <b>Texnik yordam 24/7</b>\n+998 71 200‑47‑47 · ichki 3\nsupport@fibernet.uz\n\n👥 <b>Abonent bo‘limi</b>\n+998 71 200‑47‑47 · ichki 4\nDu–Ju 09:00–18:00 · Sha 09:00–13:00\n\n📧 info@fibernet.uz\n💳 office@fibernet.uz / billing@fibernet.uz\n📍 Toshkent, 1‑proyezd Aviasozlar, 22',
    '☎️ <b>Контакты FiberNet</b>\n\n🛠 <b>Техподдержка 24/7</b>\n+998 71 200‑47‑47 · доб. 3\nsupport@fibernet.uz\n\n👥 <b>Абонентский отдел</b>\n+998 71 200‑47‑47 · доб. 4\nПн–Пт 09:00–18:00 · Сб 09:00–13:00\n\n📧 info@fibernet.uz\n💳 office@fibernet.uz / billing@fibernet.uz\n📍 Ташкент, 1‑й проезд Авиасозлар, 22');
  const keyboard = inlineKeyboard([
    [
      { text: L(lang, '🛠 Telegram yordam', '🛠 Telegram техподдержка'), url: OFFICIAL.techTelegram },
      { text: L(lang, '👥 Abonent Telegram', '👥 Абонентский Telegram'), url: OFFICIAL.subscriberTelegram }
    ],
    [{ text: L(lang, '🌐 Rasmiy kontaktlar', '🌐 Официальные контакты'), url: contacts(lang) }],
    [{ text: L(lang, '📣 FiberNet kanali', '📣 Канал FiberNet'), url: OFFICIAL.channel }],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
  return premiumCard(env, chatId, { key:'contacts', photo:ART.home, caption, keyboard });
}

export async function showPremiumPromo(env, chatId, lang) {
  const caption = L(lang,
    '🎁 <b>FiberNet aksiyalari</b>\n\nAksiya shartlari va yangi takliflar vaqt o‘tishi bilan o‘zgarishi mumkin. Eng yangi ma’lumotni rasmiy kanal va fibernet.uz orqali tekshiring.\n\n📣 Bot faqat rasmiy FiberNet manbalariga havola beradi.',
    '🎁 <b>Акции FiberNet</b>\n\nУсловия акций и новые предложения могут меняться. Самую свежую информацию проверяйте в официальном канале и на fibernet.uz.\n\n📣 Бот ведёт только на официальные источники FiberNet.');
  const keyboard = inlineKeyboard([
    [{ text: L(lang, '📣 Rasmiy kanal', '📣 Официальный канал'), url: OFFICIAL.channel }],
    [{ text: L(lang, '🌐 FiberNet sayti', '🌐 Сайт FiberNet'), url: site(lang) }],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
  return premiumCard(env, chatId, {
    key: lang === 'ru' ? 'promo_ru' : 'promo_uz',
    photo: lang === 'ru' ? ART.promoRu : ART.promoUz,
    caption,
    keyboard
  });
}

export async function showPremiumAbout(env, chatId, lang) {
  const caption = L(lang,
    'ℹ️ <b>FiberNet · NET TELEVISION</b>\n\nFiberNet uy va biznes uchun internet xizmatlari, optik ulanish, Wi‑Fi, TV, statik IP va boshqa telekommunikatsiya xizmatlarini taqdim etadi.\n\n🔐 Xavfsizlik: bot hech qachon shaxsiy kabinet paroli, karta CVV kodi yoki SMS tasdiqlash kodini so‘ramaydi.\n\n✅ Ma’lumotlar: fibernet.uz + @fibernet_channel.',
    'ℹ️ <b>FiberNet · NET TELEVISION</b>\n\nFiberNet предоставляет интернет для дома и бизнеса, оптическое подключение, Wi‑Fi, ТВ, статический IP и другие телеком‑услуги.\n\n🔐 Безопасность: бот никогда не просит пароль личного кабинета, CVV карты или SMS‑код подтверждения.\n\n✅ Источники: fibernet.uz + @fibernet_channel.');
  const keyboard = inlineKeyboard([
    [{ text: L(lang, '🌐 Rasmiy sayt', '🌐 Официальный сайт'), url: site(lang) }],
    [{ text: L(lang, '📣 Telegram kanal', '📣 Telegram‑канал'), url: OFFICIAL.channel }],
    [{ text: L(lang, '👤 Shaxsiy kabinet', '👤 Личный кабинет'), url: OFFICIAL.cabinet }],
    [{ text: L(lang, '📚 Rasmiy manbalar', '📚 Официальные источники'), callback_data: 'v22:sources' }],
    [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'home:main' }]
  ]);
  return premiumCard(env, chatId, { key:'about', photo:ART.home, caption, keyboard });
}

export async function showPremiumNews(env, chatId, lang) {
  const caption = L(lang,
    '📰 <b>Yangiliklar va texnik ogohlantirishlar</b>\n\nRejalashtirilgan texnik ishlar, ofis ish vaqti, yangi tariflar va aksiyalarni rasmiy FiberNet manbalaridan kuzating.',
    '📰 <b>Новости и технические уведомления</b>\n\nПлановые работы, режим офиса, новые тарифы и акции публикуются в официальных источниках FiberNet.');
  return premiumCard(env, chatId, {
    key:'news',
    photo:ART.home,
    caption,
    keyboard:inlineKeyboard([
      [{ text: L(lang, '📣 Telegram kanal', '📣 Telegram‑канал'), url: OFFICIAL.channel }],
      [{ text: L(lang, '📰 Saytdagi yangiliklar', '📰 Новости на сайте'), url: news(lang) }],
      [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data:'home:main' }]
    ])
  });
}

export async function showSources(env, chatId, lang) {
  return sendMessage(env, chatId, L(lang,
    '📚 <b>Rasmiy manbalar</b>\n\nBotdagi tarif, kontakt, to‘lov, ulanish va xizmat ma’lumotlari FiberNet’ning rasmiy resurslariga tayangan. Vaqtga bog‘liq ma’lumotlarda rasmiy sahifa ustuvor hisoblanadi.',
    '📚 <b>Официальные источники</b>\n\nДанные о тарифах, контактах, оплате, подключении и услугах основаны на официальных ресурсах FiberNet. Для меняющейся информации приоритет имеет официальная страница.'), {
    reply_markup:inlineKeyboard([
      [{ text:'🌐 fibernet.uz', url:site(lang) }],
      [{ text:'📣 @fibernet_channel', url:OFFICIAL.channel }],
      [{ text:L(lang,'📶 Tariflar','📶 Тарифы'), url:tariffs(lang) }],
      [{ text:L(lang,'💳 To‘lov','💳 Оплата'), url:payments(lang) }],
      [{ text:L(lang,'☎️ Kontaktlar','☎️ Контакты'), url:contacts(lang) }],
      [{ text:L(lang,'🏠 Bosh menyu','🏠 Главное меню'), callback_data:'home:main' }]
    ])
  });
}

export async function handleV22ContentUpdate(env, update) {
  const q = update?.callback_query;
  if (!q?.message?.chat || q.message.chat.type !== 'private') return false;
  const user = await upsertUser(env, q.from);
  const lang = user?.language === 'ru' ? 'ru' : 'uz';
  const data = String(q.data || '');

  const actions = {
    'home:main': () => showPremiumHome(env, q.message.chat.id, lang),
    'home:departments': () => showPremiumSupport(env, q.message.chat.id, lang),
    'home:tariffs': () => showPremiumTariffs(env, q.message.chat.id, lang),
    'home:tv': () => showPremiumTV(env, q.message.chat.id, lang),
    'home:promo': () => showPremiumPromo(env, q.message.chat.id, lang),
    'home:contacts': () => showPremiumContacts(env, q.message.chat.id, lang),
    'home:about': () => showPremiumAbout(env, q.message.chat.id, lang),
    'v22:payment': () => showPremiumPayment(env, q.message.chat.id, lang),
    'v22:connect': () => showPremiumConnect(env, q.message.chat.id, lang),
    'v22:services': () => showPremiumServices(env, q.message.chat.id, lang),
    'v22:news': () => showPremiumNews(env, q.message.chat.id, lang),
    'v22:sources': () => showSources(env, q.message.chat.id, lang),
    'v18:continue': () => showPremiumHome(env, q.message.chat.id, lang)
  };

  const fn = actions[data];
  if (!fn) return false;
  await answerCallback(env, q.id);
  await fn();
  return true;
}

export async function v22Health(env) {
  await ensureV22Schema(env);
  const cached = await env.DB.prepare(
    'SELECT COUNT(*) n FROM fn22_media_cache WHERE telegram_file_id IS NOT NULL'
  ).first();
  return {
    mode:'official-fibernet-content-premium-cards-cached-media',
    official_sources:['fibernet.uz','@fibernet_channel'],
    cached_media:Number(cached?.n || 0)
  };
}

export const __test = { OFFICIAL, ART };
