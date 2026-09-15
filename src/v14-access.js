import { ensureV5Schema } from './v5-db.js';
import { L, entityTypeLabel } from './v8-ui.js';
import { answerCallback, escapeHtml, inlineKeyboard, sendMessage } from './telegram.js';

let ready = false;

export const ACCESS_TYPES = ['ethernet', 'gpon_onu', 'gpon_onuwifi'];

export function accessLabel(type, lang = 'uz') {
  return ({
    ethernet: L(lang, 'MET / oddiy Ethernet kabel', 'MET / обычный Ethernet-кабель'),
    gpon_onu: L(lang, 'GPON · ONU', 'GPON · ONU'),
    gpon_onuwifi: L(lang, 'GPON · ONU Wi‑Fi', 'GPON · ONU Wi‑Fi')
  })[type] || L(lang, 'Ko‘rsatilmagan', 'Не указано');
}

export async function ensureV14Schema(env) {
  if (ready) return;
  await ensureV5Schema(env);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fn14_user_access (
    telegram_id INTEGER PRIMARY KEY,
    access_type TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS fn14_enrich_tech_ticket
    AFTER INSERT ON fn5_tickets
    WHEN NEW.department='tech'
    BEGIN
      UPDATE fn5_tickets
      SET description = COALESCE((
        SELECT '🌐 Ulanish turi / Тип подключения: ' ||
          CASE access_type
            WHEN 'ethernet' THEN 'MET / Ethernet kabel'
            WHEN 'gpon_onu' THEN 'GPON · ONU'
            WHEN 'gpon_onuwifi' THEN 'GPON · ONU Wi‑Fi'
            ELSE access_type
          END || char(10)
        FROM fn14_user_access WHERE telegram_id=NEW.telegram_id
      ), '') || NEW.description
      WHERE ticket_no=NEW.ticket_no;
    END`).run();
  ready = true;
}

async function userLang(env, id) {
  const row = await env.DB.prepare('SELECT language FROM fn5_users WHERE telegram_id=?').bind(id).first();
  return row?.language === 'ru' ? 'ru' : 'uz';
}

async function saveAccess(env, telegramId, accessType) {
  if (!ACCESS_TYPES.includes(accessType)) throw new Error('Invalid access type');
  await ensureV14Schema(env);
  await env.DB.prepare(`INSERT INTO fn14_user_access(telegram_id,access_type,updated_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET access_type=excluded.access_type,updated_at=CURRENT_TIMESTAMP`)
    .bind(telegramId, accessType).run();
}

export async function getAccess(env, telegramId) {
  await ensureV14Schema(env);
  return env.DB.prepare('SELECT access_type,updated_at FROM fn14_user_access WHERE telegram_id=?')
    .bind(telegramId).first();
}

function accessKeyboard(type, suggested, lang) {
  return inlineKeyboard([
    [{ text: L(lang, '🔌 MET / oddiy kabel', '🔌 MET / обычный кабель'), callback_data: `net:ethernet:${type}:${suggested}` }],
    [{ text: '🌐 GPON', callback_data: `net:gpon:${type}:${suggested}` }],
    [{ text: L(lang, '⬅️ Mijoz turi', '⬅️ Тип клиента'), callback_data: 'dept:tech' }]
  ]);
}

function gponDeviceKeyboard(type, suggested, lang) {
  return inlineKeyboard([
    [{ text: '🔌 ONU', callback_data: `gpon:gpon_onu:${type}:${suggested}` }],
    [{ text: '📶 ONU Wi‑Fi', callback_data: `gpon:gpon_onuwifi:${type}:${suggested}` }],
    [{ text: L(lang, '⬅️ Ulanish turi', '⬅️ Тип подключения'), callback_data: `type:tech:${type}:${suggested}` }]
  ]);
}

function techIssuesKeyboard(entityType, accessType, lang) {
  const issue = (text, cat) => ({ text, callback_data: `issue:tech:${entityType}:${cat}` });
  const rows = [
    [issue(L(lang, '🚫 Internet yo‘q', '🚫 Нет интернета'), 'no_internet'), issue(L(lang, '🐢 Internet sekin', '🐢 Низкая скорость'), 'slow')]
  ];
  if (accessType === 'ethernet') {
    rows.push([issue('📡 Wi‑Fi', 'wifi'), issue(L(lang, '🔌 Kabel / LAN', '🔌 Кабель / LAN'), 'lan')]);
  } else if (accessType === 'gpon_onu') {
    rows.push([issue(L(lang, '🔧 ONU / PON / LOS', '🔧 ONU / PON / LOS'), 'equipment'), issue(L(lang, '🔌 Kabel / LAN', '🔌 Кабель / LAN'), 'lan')]);
    rows.push([issue('📺 IPTV / HopHop', 'iptv')]);
  } else {
    rows.push([issue('📡 Wi‑Fi', 'wifi'), issue(L(lang, '🔧 ONU / PON / LOS', '🔧 ONU / PON / LOS'), 'equipment')]);
    rows.push([issue('📺 IPTV / HopHop', 'iptv')]);
  }
  rows.push([issue(L(lang, '📝 Boshqa texnik muammo', '📝 Другая тех. проблема'), 'other')]);
  rows.push([{ text: L(lang, '⬅️ Ulanish turini o‘zgartirish', '⬅️ Изменить тип подключения'), callback_data: `type:tech:${entityType}:other` }]);
  return inlineKeyboard(rows);
}

function diagnosticKeyboard(entityType, category, lang) {
  return inlineKeyboard([
    [{ text: L(lang, '✅ Muammo hal bo‘ldi', '✅ Проблема решена'), callback_data: 'home:main' }],
    [{ text: L(lang, '👨‍💻 Operatorga murojaat', '👨‍💻 Обратиться к оператору'), callback_data: `assist:tech:${entityType}:${category}` }],
    [{ text: L(lang, '⬅️ Muammolar', '⬅️ Проблемы'), callback_data: `netissues:${entityType}` }]
  ]);
}

function diagnosticText(lang, accessType, category, entityType) {
  const access = accessLabel(accessType, lang);
  const who = entityTypeLabel(entityType, lang);
  const ethernet = {
    no_internet: L(lang,
      '1️⃣ Router yoki kompyuterga kirgan Ethernet kabelni tekshiring.\n2️⃣ LAN/WAN portdagi LINK chirog‘i yonayotganini tekshiring.\n3️⃣ Router bo‘lsa 60 soniyaga o‘chirib qayta yoqing.\n4️⃣ Imkon bo‘lsa kabelni kompyuterga to‘g‘ridan-to‘g‘ri ulab tekshiring.\n5️⃣ Kabel yoki port bo‘shashgan bo‘lsa qayta ulang.',
      '1️⃣ Проверьте Ethernet-кабель до роутера/компьютера.\n2️⃣ Проверьте индикатор LINK на LAN/WAN.\n3️⃣ Перезагрузите роутер на 60 секунд.\n4️⃣ По возможности проверьте кабель напрямую на компьютере.\n5️⃣ Переподключите кабель и порт.'),
    slow: L(lang,
      '1️⃣ Tezlikni avval kabel orqali tekshiring.\n2️⃣ Fon yuklamalari va torrentlarni to‘xtating.\n3️⃣ Boshqa LAN port va kabel bilan sinang.\n4️⃣ Router orqali sekin, to‘g‘ridan-to‘g‘ri kabelda tez bo‘lsa — muammo router/Wi‑Fi tomonda.',
      '1️⃣ Сначала измерьте скорость по кабелю.\n2️⃣ Остановите фоновые загрузки и торренты.\n3️⃣ Проверьте другой LAN-порт и кабель.\n4️⃣ Если напрямую скорость нормальная, а через роутер низкая — проблема на стороне роутера/Wi‑Fi.'),
    wifi: L(lang,
      '1️⃣ Kabel orqali internet borligini tekshiring.\n2️⃣ Router yonida 5 GHz bilan test qiling.\n3️⃣ 2.4 GHz uzoq masofa uchun, 5 GHz yuqori tezlik uchun.\n4️⃣ Routerni ochiq va balandroq joyga qo‘ying.\n5️⃣ Wi‑Fi tarmog‘ini unutib qayta ulang.',
      '1️⃣ Проверьте интернет по кабелю.\n2️⃣ Рядом с роутером протестируйте 5 GHz.\n3️⃣ 2.4 GHz — дальность, 5 GHz — скорость.\n4️⃣ Разместите роутер выше и открыто.\n5️⃣ Забудьте сеть Wi‑Fi и подключитесь заново.'),
    lan: L(lang,
      '1️⃣ Kabel konnektorlarini ikki tomondan tekshiring.\n2️⃣ Boshqa LAN portni sinang.\n3️⃣ Boshqa Ethernet kabel bilan tekshiring.\n4️⃣ Kompyuterda Ethernet adapter yoqilganini tekshiring.',
      '1️⃣ Проверьте коннекторы кабеля с двух сторон.\n2️⃣ Попробуйте другой LAN-порт.\n3️⃣ Проверьте другим Ethernet-кабелем.\n4️⃣ Убедитесь, что Ethernet-адаптер включён.')
  };
  const gpon = {
    no_internet: L(lang,
      '1️⃣ ONU quvvatda ekanini tekshiring.\n2️⃣ <b>PON</b> indikatorini tekshiring.\n3️⃣ <b>LOS qizil</b> yonib/miltillab tursa optik kabelni bukmang va ulagichni ajratmang — bu liniya signal muammosi bo‘lishi mumkin.\n4️⃣ ONU’ni 60 soniyaga o‘chirib qayta yoqing.\n5️⃣ LAN kabel va portlarni tekshiring.',
      '1️⃣ Проверьте питание ONU.\n2️⃣ Проверьте индикатор <b>PON</b>.\n3️⃣ Если <b>LOS горит/мигает красным</b>, не сгибайте оптику и не отсоединяйте коннектор — вероятна проблема сигнала линии.\n4️⃣ Перезагрузите ONU на 60 секунд.\n5️⃣ Проверьте LAN-кабель и порты.'),
    slow: L(lang,
      '1️⃣ Avval ONU’dan LAN kabel orqali speed test qiling.\n2️⃣ PON/LOS holatini tekshiring.\n3️⃣ Fon yuklamalarini to‘xtating.\n4️⃣ ONU Wi‑Fi bo‘lsa router yonida 5 GHz bilan tekshiring.\n5️⃣ Kabelda tez, Wi‑Fi’da sekin bo‘lsa — radio/Wi‑Fi muammosi.',
      '1️⃣ Сначала измерьте скорость по LAN от ONU.\n2️⃣ Проверьте PON/LOS.\n3️⃣ Остановите фоновые загрузки.\n4️⃣ Для ONU Wi‑Fi проверьте 5 GHz рядом с устройством.\n5️⃣ Если по кабелю быстро, а по Wi‑Fi медленно — проблема в Wi‑Fi.'),
    equipment: L(lang,
      '1️⃣ Power yonishi kerak.\n2️⃣ PON odatda barqaror yonadi.\n3️⃣ LOS qizil bo‘lmasligi kerak.\n4️⃣ Optik kabelni qattiq bukmang va konnektorni o‘zboshimchalik bilan ajratmang.\n5️⃣ ONU qizib ketmaganini tekshiring.',
      '1️⃣ Power должен гореть.\n2️⃣ PON обычно должен быть стабильным.\n3️⃣ LOS не должен гореть красным.\n4️⃣ Не перегибайте оптический кабель и не отсоединяйте коннектор без необходимости.\n5️⃣ Проверьте, не перегревается ли ONU.'),
    wifi: L(lang,
      '1️⃣ ONU yonida 5 GHz tarmog‘ini tekshiring.\n2️⃣ 2.4 GHz uzoq masofaga, 5 GHz tezlikka mos.\n3️⃣ ONU’ni yopiq shkaf ichiga qo‘ymang.\n4️⃣ Wi‑Fi tarmog‘ini unutib qayta ulang.\n5️⃣ LAN orqali tezlik normal bo‘lsa, muammo Wi‑Fi qamrovida.',
      '1️⃣ Проверьте 5 GHz рядом с ONU.\n2️⃣ 2.4 GHz — дальность, 5 GHz — скорость.\n3️⃣ Не размещайте ONU в закрытом шкафу.\n4️⃣ Забудьте сеть и подключитесь заново.\n5️⃣ Если по LAN скорость нормальная — проблема в покрытии Wi‑Fi.'),
    lan: L(lang,
      '1️⃣ ONU LAN portidagi indikatorni tekshiring.\n2️⃣ Boshqa LAN portni sinang.\n3️⃣ Ethernet kabelni almashtirib ko‘ring.\n4️⃣ Kompyuter/TV’dagi tarmoq adapterini tekshiring.',
      '1️⃣ Проверьте индикатор LAN на ONU.\n2️⃣ Попробуйте другой LAN-порт.\n3️⃣ Замените Ethernet-кабель.\n4️⃣ Проверьте сетевой адаптер компьютера/ТВ.'),
    iptv: L(lang,
      '1️⃣ Internet ishlayotganini tekshiring.\n2️⃣ ONU va TV/pristavkani qayta yoqing.\n3️⃣ HopHop ilovasini qayta oching.\n4️⃣ Muammo bitta kanalmi yoki barcha kanallardami aniqlang.',
      '1️⃣ Проверьте интернет.\n2️⃣ Перезагрузите ONU и ТВ/приставку.\n3️⃣ Перезапустите HopHop.\n4️⃣ Проверьте, проблема на одном канале или на всех.')
  };
  const generic = L(lang,
    'Bu muammo uchun avtomatik tekshiruv tugadi. Agar muammo qolgan bo‘lsa operatorga murojaat qiling.',
    'Автоматическая проверка завершена. Если проблема осталась, обратитесь к оператору.');
  const text = accessType === 'ethernet' ? (ethernet[category] || generic) : (gpon[category] || generic);
  return `🛠 <b>${L(lang, 'Texnik diagnostika', 'Техническая диагностика')}</b>\n\n👤 ${escapeHtml(who)}\n🌐 <b>${escapeHtml(access)}</b>\n\n${text}\n\n${L(lang, 'Muammo hal bo‘lmasa, operatorga murojaat tugmasini bosing.', 'Если проблема не решена, нажмите кнопку обращения к оператору.')}`;
}

async function showTechIssues(env, chatId, userId, entityType) {
  const lang = await userLang(env, userId);
  const row = await getAccess(env, userId);
  if (!row?.access_type) {
    return sendMessage(env, chatId, L(lang,
      '🌐 <b>Ulanish turini tanlang</b>\n\nSizning internetingiz qanday texnologiya orqali ulangan?',
      '🌐 <b>Выберите тип подключения</b>\n\nПо какой технологии подключён ваш интернет?'),
      { reply_markup: accessKeyboard(entityType, 'other', lang) });
  }
  return sendMessage(env, chatId,
    `🛠 <b>${L(lang, 'Texnik yordam', 'Техподдержка')}</b>\n👤 ${escapeHtml(entityTypeLabel(entityType, lang))}\n🌐 ${escapeHtml(accessLabel(row.access_type, lang))}\n\n${L(lang, 'Muammo turini tanlang:', 'Выберите проблему:')}`,
    { reply_markup: techIssuesKeyboard(entityType, row.access_type, lang) });
}

export async function handleV14Access(env, update) {
  const q = update?.callback_query;
  if (!q?.message?.chat || q.message.chat.type !== 'private') return false;
  const data = String(q.data || '');
  const userId = q.from?.id;
  if (!userId) return false;
  await ensureV14Schema(env);
  const lang = await userLang(env, userId);

  if (data.startsWith('type:tech:')) {
    const [, , entityType = 'physical', suggested = 'other'] = data.split(':');
    await answerCallback(env, q.id);
    await sendMessage(env, q.message.chat.id, L(lang,
      '🌐 <b>Ulanish texnologiyasini tanlang</b>\n\nFiberNet abonenti qaysi usulda ulangan?',
      '🌐 <b>Выберите технологию подключения</b>\n\nКак подключён абонент FiberNet?'),
      { reply_markup: accessKeyboard(entityType, suggested, lang) });
    return true;
  }

  if (data.startsWith('net:')) {
    const [, network, entityType = 'physical', suggested = 'other'] = data.split(':');
    await answerCallback(env, q.id);
    if (network === 'gpon') {
      await sendMessage(env, q.message.chat.id, L(lang,
        '🌐 <b>GPON qurilmasini tanlang</b>\n\nAbonentda qaysi ONU turi o‘rnatilgan?',
        '🌐 <b>Выберите GPON-устройство</b>\n\nКакой тип ONU установлен у абонента?'),
        { reply_markup: gponDeviceKeyboard(entityType, suggested, lang) });
      return true;
    }
    if (network === 'ethernet') {
      await saveAccess(env, userId, 'ethernet');
      await sendMessage(env, q.message.chat.id,
        `✅ ${L(lang, 'Ulanish turi saqlandi', 'Тип подключения сохранён')}: <b>${escapeHtml(accessLabel('ethernet', lang))}</b>`);
      await showTechIssues(env, q.message.chat.id, userId, entityType);
      return true;
    }
    return false;
  }

  if (data.startsWith('gpon:')) {
    const [, accessType, entityType = 'physical'] = data.split(':');
    if (!['gpon_onu', 'gpon_onuwifi'].includes(accessType)) return false;
    await answerCallback(env, q.id);
    await saveAccess(env, userId, accessType);
    await sendMessage(env, q.message.chat.id,
      `✅ ${L(lang, 'Ulanish turi saqlandi', 'Тип подключения сохранён')}: <b>${escapeHtml(accessLabel(accessType, lang))}</b>`);
    await showTechIssues(env, q.message.chat.id, userId, entityType);
    return true;
  }

  if (data.startsWith('netissues:')) {
    const entityType = data.split(':')[1] || 'physical';
    await answerCallback(env, q.id);
    await showTechIssues(env, q.message.chat.id, userId, entityType);
    return true;
  }

  if (data.startsWith('issue:tech:')) {
    const [, , entityType = 'physical', category = 'other'] = data.split(':');
    const row = await getAccess(env, userId);
    if (!row?.access_type) return false;
    await answerCallback(env, q.id);
    await sendMessage(env, q.message.chat.id,
      diagnosticText(lang, row.access_type, category, entityType),
      { reply_markup: diagnosticKeyboard(entityType, category, lang) });
    return true;
  }

  return false;
}

export async function v14Health(env) {
  await ensureV14Schema(env);
  const r = await env.DB.prepare(`SELECT access_type,COUNT(*) n FROM fn14_user_access GROUP BY access_type ORDER BY access_type`).all();
  return { access_types: ACCESS_TYPES, saved_profiles: r.results || [] };
}

export const __test = { accessLabel, diagnosticText };
