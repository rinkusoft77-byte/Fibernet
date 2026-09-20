import {
  clearSession, getSession, getUser, sessionData, setLanguage, setSession, upsertUser
} from './v5-db.js';
import { createExpressTicket } from './v16-ux.js';
import { categoryMeta, homeKeyboard, L, languageKeyboard } from './v8-ui.js';
import { answerCallback, escapeHtml, inlineKeyboard, sendMessage } from './telegram.js';

const now = () => new Date().toISOString();
let ready = false;

function isPrivate(chat) { return chat?.type === 'private'; }
function isGroup(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
function adminIds(env) { return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String); }
function isAdmin(env, id) { return adminIds(env).includes(String(id)); }

export async function ensureV18Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn18_profiles (
      telegram_id INTEGER PRIMARY KEY,
      given_name TEXT,
      family_name TEXT,
      login TEXT,
      address TEXT,
      status TEXT NOT NULL DEFAULT 'skipped',
      submitted_at TEXT,
      reviewed_by INTEGER,
      reviewed_by_name TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn18_profiles_status ON fn18_profiles(status,submitted_at)`,
    `CREATE TABLE IF NOT EXISTS fn18_processed (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

async function claimUpdate(env, id) {
  if (!Number.isInteger(id)) return true;
  await ensureV18Schema(env);
  try {
    await env.DB.prepare('INSERT INTO fn18_processed(update_id) VALUES(?)').bind(id).run();
    return true;
  } catch (e) {
    const s = String(e).toLowerCase();
    if (s.includes('unique') || s.includes('constraint')) return false;
    throw e;
  }
}

export async function getClientProfile(env, telegramId) {
  await ensureV18Schema(env);
  return env.DB.prepare('SELECT * FROM fn18_profiles WHERE telegram_id=?').bind(telegramId).first();
}

async function saveProfileState(env, telegramId, data, status = 'pending') {
  await ensureV18Schema(env);
  await env.DB.prepare(`INSERT INTO fn18_profiles(
    telegram_id,given_name,family_name,login,address,status,submitted_at,reviewed_by,reviewed_by_name,reviewed_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,?)
  ON CONFLICT(telegram_id) DO UPDATE SET
    given_name=excluded.given_name,family_name=excluded.family_name,login=excluded.login,address=excluded.address,
    status=excluded.status,submitted_at=excluded.submitted_at,
    reviewed_by=NULL,reviewed_by_name=NULL,reviewed_at=NULL,updated_at=excluded.updated_at`)
    .bind(
      telegramId,
      data.givenName || null,
      data.familyName || null,
      data.login || null,
      data.address || null,
      status,
      status === 'pending' ? now() : null,
      now()
    ).run();
}

async function clearLegacyIdentity(env, telegramId) {
  await env.DB.prepare('UPDATE fn5_users SET account_login=NULL,address=NULL,updated_at=? WHERE telegram_id=?')
    .bind(now(), telegramId).run();
}

function fullName(p) {
  return [p?.given_name, p?.family_name].filter(Boolean).join(' ').trim();
}

function profileStatusText(status, lang) {
  const m = {
    approved: L(lang, '✅ Admin tasdiqlagan', '✅ Подтверждён администратором'),
    pending: L(lang, '⏳ Admin tasdig‘ini kutmoqda', '⏳ Ожидает подтверждения администратора'),
    rejected: L(lang, '❌ Admin qaytargan', '❌ Отклонён администратором'),
    skipped: L(lang, '⏭ Profil o‘tkazib yuborilgan', '⏭ Профиль пропущен')
  };
  return m[status] || L(lang, 'Profil yo‘q', 'Профиль не заполнен');
}

function profileGateKeyboard(lang, profile) {
  const rows = [];
  if (profile?.status === 'pending') {
    rows.push([{ text: L(lang, '✏️ Ma’lumotni yangilash', '✏️ Изменить данные'), callback_data: 'v18:fill' }]);
    rows.push([{ text: L(lang, '➡️ Botdan foydalanish', '➡️ Продолжить в бот'), callback_data: 'v18:continue' }]);
  } else if (profile?.status === 'approved') {
    rows.push([{ text: L(lang, '➡️ Davom etish', '➡️ Продолжить'), callback_data: 'v18:continue' }]);
    rows.push([{ text: L(lang, '✏️ Profilni o‘zgartirish', '✏️ Изменить профиль'), callback_data: 'v18:fill' }]);
  } else {
    rows.push([{ text: L(lang, '📝 Profilni to‘ldirish', '📝 Заполнить профиль'), callback_data: 'v18:fill' }]);
    rows.push([{ text: L(lang, '⏭ O‘tkazib yuborish', '⏭ Пропустить'), callback_data: 'v18:skip' }]);
  }
  return inlineKeyboard(rows);
}

async function showHome(env, chatId, user) {
  const lang = user?.language === 'ru' ? 'ru' : 'uz';
  const p = await getClientProfile(env, user.telegram_id);
  const badge = p?.status === 'approved'
    ? L(lang, '✅ Tasdiqlangan mijoz', '✅ Подтверждённый клиент')
    : p?.status === 'pending'
      ? L(lang, '⏳ Profil tekshiruvda', '⏳ Профиль на проверке')
      : L(lang, 'ℹ️ Profil tasdiqlanmagan', 'ℹ️ Профиль не подтверждён');
  return sendMessage(env, chatId, [
    '🌐 <b>FiberNet Assistant</b>',
    badge,
    '',
    L(lang, 'Kerakli xizmatni tanlang:', 'Выберите нужный раздел:')
  ].join('\n'), { reply_markup: homeKeyboard(lang) });
}

async function showProfileGate(env, chatId, user) {
  const lang = user?.language === 'ru' ? 'ru' : 'uz';
  const p = await getClientProfile(env, user.telegram_id);
  if (p?.status === 'approved') return showHome(env, chatId, user);
  const intro = p?.status === 'pending'
    ? L(lang,
      'Profilingiz admin tekshiruvida. Tasdiqlanguncha botdan foydalanishingiz mumkin, lekin operatorga murojaatda ma’lumotlar alohida so‘raladi.',
      'Профиль находится на проверке администратора. До подтверждения ботом можно пользоваться, но при обращении к оператору данные будут запрошены отдельно.')
    : L(lang,
      'Botdan foydalanishdan oldin profil yaratishingiz mumkin. Ism va familiya majburiy; login va manzil ixtiyoriy. Profilni admin tasdiqlagach, keyingi murojaatlarda ma’lumotlarni qayta yozish shart bo‘lmaydi.',
      'Перед использованием бота можно создать профиль. Имя и фамилия обязательны; логин и адрес — по желанию. После подтверждения администратором данные будут автоматически использоваться в следующих обращениях.');
  return sendMessage(env, chatId, [
    `👤 <b>${L(lang, 'Mijoz profili', 'Профиль клиента')}</b>`,
    '',
    intro,
    p ? `\n📌 ${profileStatusText(p.status, lang)}` : null
  ].filter(Boolean).join('\n'), { reply_markup: profileGateKeyboard(lang, p) });
}

async function showProfile(env, chatId, user) {
  const lang = user?.language === 'ru' ? 'ru' : 'uz';
  const p = await getClientProfile(env, user.telegram_id);
  if (!p) return showProfileGate(env, chatId, user);
  const lines = [
    `👤 <b>${L(lang, 'Mijoz profili', 'Профиль клиента')}</b>`,
    '',
    `📌 ${profileStatusText(p.status, lang)}`,
    `🙍 <b>${escapeHtml(fullName(p) || '—')}</b>`,
    `🔐 ${escapeHtml(p.login || '—')}`,
    `📍 ${escapeHtml(p.address || '—')}`
  ];
  if (p.status === 'approved' && p.reviewed_by_name) {
    lines.push(`🛡 ${L(lang, 'Tasdiqlagan', 'Подтвердил')}: ${escapeHtml(p.reviewed_by_name)}`);
  }
  return sendMessage(env, chatId, lines.join('\n'), {
    reply_markup: inlineKeyboard([
      [{ text: L(lang, '✏️ Profilni tahrirlash', '✏️ Изменить профиль'), callback_data: 'v18:fill' }],
      ...(p.status === 'pending' ? [] : [[{ text: L(lang, '⏭ Profilni ishlatmaslik', '⏭ Не использовать профиль'), callback_data: 'v18:skip' }]]),
      [{ text: L(lang, '🏠 Bosh menyu', '🏠 Главное меню'), callback_data: 'v18:continue' }]
    ])
  });
}

function optionalKeyboard(lang, field) {
  return inlineKeyboard([
    [{ text: L(lang, '⏭ O‘tkazib yuborish', '⏭ Пропустить'), callback_data: `v18:fieldskip:${field}` }],
    [{ text: L(lang, '❌ Bekor qilish', '❌ Отмена'), callback_data: 'v18:cancel' }]
  ]);
}

function previewKeyboard(lang) {
  return inlineKeyboard([
    [{ text: L(lang, '✅ Admin tasdig‘iga yuborish', '✅ Отправить администратору'), callback_data: 'v18:submit' }],
    [{ text: L(lang, '✏️ Qayta to‘ldirish', '✏️ Заполнить заново'), callback_data: 'v18:fill' }],
    [{ text: L(lang, '⏭ Hozircha o‘tkazib yuborish', '⏭ Пока пропустить'), callback_data: 'v18:skip' }]
  ]);
}

async function startProfileForm(env, qOrMsg) {
  const from = qOrMsg.from;
  const chatId = qOrMsg.message?.chat?.id || qOrMsg.chat?.id;
  const user = await upsertUser(env, from);
  const lang = user.language || 'uz';
  await setSession(env, user.telegram_id, 'v18_profile_first', {});
  return sendMessage(env, chatId, L(lang,
    '1️⃣ <b>Ismingizni yozing</b>\n\nBu maydon majburiy. Admin aynan shu ma’lumot orqali profilingizni tekshiradi.',
    '1️⃣ <b>Введите имя</b>\n\nЭто обязательное поле. Администратор проверит профиль по этим данным.'));
}

function validName(value) {
  const s = String(value || '').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 60) return null;
  if (/\d/.test(s)) return null;
  return s;
}

async function profilePreview(env, chatId, user, data) {
  const lang = user.language || 'uz';
  return sendMessage(env, chatId, [
    `📋 <b>${L(lang, 'Profilni tekshiring', 'Проверьте профиль')}</b>`,
    '',
    `🙍 ${escapeHtml([data.givenName, data.familyName].filter(Boolean).join(' '))}`,
    `🔐 ${escapeHtml(data.login || L(lang, 'ko‘rsatilmagan', 'не указан'))}`,
    `📍 ${escapeHtml(data.address || L(lang, 'ko‘rsatilmagan', 'не указан'))}`,
    '',
    L(lang,
      'Yuborilgandan keyin profil admin tasdig‘iga tushadi. Tasdiqlanmaguncha bu ma’lumotlar avtomatik ticketga biriktirilmaydi.',
      'После отправки профиль попадёт на проверку администратора. До подтверждения эти данные не будут автоматически подставляться в обращение.')
  ].join('\n'), { reply_markup: previewKeyboard(lang) });
}

function adminProfileText(user, p) {
  const tgName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || '—';
  return [
    '🛡 <b>Yangi mijoz profili</b>',
    '',
    `🙍 <b>${escapeHtml(fullName(p))}</b>`,
    `🔐 Login/shartnoma: <code>${escapeHtml(p.login || '—')}</code>`,
    `📍 Manzil: ${escapeHtml(p.address || '—')}`,
    '',
    `Telegram: ${escapeHtml(tgName)}`,
    user?.username ? `🔗 @${escapeHtml(user.username)}` : null,
    `🆔 <code>${p.telegram_id}</code>`,
    '',
    'Tasdiqlansa, ushbu profil ma’lumotlari keyingi operator murojaatlariga avtomatik biriktiriladi.'
  ].filter(Boolean).join('\n');
}

function adminProfileKeyboard(id) {
  return inlineKeyboard([
    [{ text: '✅ Tasdiqlash', callback_data: `v18admin:approve:${id}` },
     { text: '❌ Qaytarish', callback_data: `v18admin:reject:${id}` }],
    [{ text: '👁 Profil', callback_data: `v18admin:view:${id}` }]
  ]);
}

async function notifyAdmins(env, telegramId) {
  const p = await getClientProfile(env, telegramId);
  const user = await getUser(env, telegramId);
  if (!p || p.status !== 'pending') return;
  const text = adminProfileText(user, p);
  let delivered = 0;
  for (const id of adminIds(env)) {
    try {
      await sendMessage(env, id, text, { reply_markup: adminProfileKeyboard(telegramId) });
      delivered++;
    } catch (e) {
      console.warn('v18 admin profile notification failed', { admin:id, error:String(e) });
    }
  }
  console.log('v18 profile submitted', { telegramId, admin_notifications: delivered });
}

async function submitProfile(env, q) {
  const user = await upsertUser(env, q.from);
  const lang = user.language || 'uz';
  const s = await getSession(env, user.telegram_id);
  const d = sessionData(s);
  await answerCallback(env, q.id);
  if (s?.state !== 'v18_profile_preview' || !d.givenName || !d.familyName) {
    await clearSession(env, user.telegram_id);
    return showProfileGate(env, q.message.chat.id, user);
  }
  await saveProfileState(env, user.telegram_id, d, 'pending');
  await clearLegacyIdentity(env, user.telegram_id);
  await clearSession(env, user.telegram_id);
  await notifyAdmins(env, user.telegram_id);
  return sendMessage(env, q.message.chat.id, [
    `⏳ <b>${L(lang, 'Profil admin tasdig‘iga yuborildi', 'Профиль отправлен на проверку')}</b>`,
    '',
    L(lang,
      'Tasdiq kelishini kutib turishingiz shart emas — botdan foydalanishingiz mumkin. Lekin tasdiqlanguncha operatorga murojaat qilganda ism-familiya va login/manzil alohida so‘raladi.',
      'Ждать подтверждения не обязательно — ботом можно пользоваться. Но до подтверждения при обращении к оператору имя, фамилия и логин/адрес будут запрошены отдельно.')
  ].join('\n'), {
    reply_markup: inlineKeyboard([
      [{ text: L(lang, '➡️ Botga kirish', '➡️ Перейти в бот'), callback_data: 'v18:continue' }],
      [{ text: L(lang, '👤 Profil holati', '👤 Статус профиля'), callback_data: 'v18:profile' }]
    ])
  });
}

async function skipProfile(env, q) {
  const user = await upsertUser(env, q.from);
  const lang = user.language || 'uz';
  await answerCallback(env, q.id);
  await saveProfileState(env, user.telegram_id, {}, 'skipped');
  await clearLegacyIdentity(env, user.telegram_id);
  await clearSession(env, user.telegram_id);
  await sendMessage(env, q.message.chat.id, L(lang,
    '⏭ Profil o‘tkazib yuborildi. Botdan foydalanishingiz mumkin. Operatorga murojaat qilganingizda kerakli identifikatsiya ma’lumotlari o‘sha paytda so‘raladi.',
    '⏭ Профиль пропущен. Ботом можно пользоваться. При обращении к оператору необходимые данные будут запрошены непосредственно перед созданием обращения.'));
  return showHome(env, q.message.chat.id, user);
}

async function approveProfile(env, q, telegramId) {
  if (!isAdmin(env, q.from.id)) {
    await answerCallback(env, q.id, 'Ruxsat yo‘q');
    return true;
  }
  const p = await getClientProfile(env, telegramId);
  if (!p || !p.given_name || !p.family_name) {
    await answerCallback(env, q.id, 'Profil topilmadi');
    return true;
  }
  const reviewer = [q.from.first_name, q.from.last_name].filter(Boolean).join(' ') || q.from.username || String(q.from.id);
  await env.DB.prepare(`UPDATE fn18_profiles SET status='approved',reviewed_by=?,reviewed_by_name=?,reviewed_at=?,updated_at=?
    WHERE telegram_id=?`).bind(q.from.id, reviewer, now(), now(), telegramId).run();
  await env.DB.prepare('UPDATE fn5_users SET account_login=?,address=?,updated_at=? WHERE telegram_id=?')
    .bind(p.login || null, p.address || null, now(), telegramId).run();
  await answerCallback(env, q.id, 'Profil tasdiqlandi');
  const user = await getUser(env, telegramId);
  try {
    await sendMessage(env, telegramId, L(user?.language || 'uz',
      `✅ <b>Profilingiz tasdiqlandi</b>\n\n🙍 ${escapeHtml(fullName(p))}\n\nEndi operatorga murojaatlarda tasdiqlangan profilingiz avtomatik biriktiriladi.`,
      `✅ <b>Ваш профиль подтверждён</b>\n\n🙍 ${escapeHtml(fullName(p))}\n\nТеперь подтверждённый профиль будет автоматически прикрепляться к обращениям оператору.`),
      { reply_markup: inlineKeyboard([[{ text: L(user?.language || 'uz','🏠 Bosh menyu','🏠 Главное меню'), callback_data:'v18:continue' }]]) });
  } catch {}
  await sendMessage(env, q.message.chat.id,
    `✅ <b>${escapeHtml(fullName(p))}</b> profili tasdiqlandi.`,
    q.message.message_thread_id ? { message_thread_id:q.message.message_thread_id } : {});
  return true;
}

async function rejectProfile(env, q, telegramId) {
  if (!isAdmin(env, q.from.id)) {
    await answerCallback(env, q.id, 'Ruxsat yo‘q');
    return true;
  }
  const p = await getClientProfile(env, telegramId);
  if (!p) { await answerCallback(env, q.id, 'Profil topilmadi'); return true; }
  const reviewer = [q.from.first_name, q.from.last_name].filter(Boolean).join(' ') || q.from.username || String(q.from.id);
  await env.DB.prepare(`UPDATE fn18_profiles SET status='rejected',reviewed_by=?,reviewed_by_name=?,reviewed_at=?,updated_at=?
    WHERE telegram_id=?`).bind(q.from.id, reviewer, now(), now(), telegramId).run();
  await clearLegacyIdentity(env, telegramId);
  await answerCallback(env, q.id, 'Profil qaytarildi');
  const user = await getUser(env, telegramId);
  try {
    await sendMessage(env, telegramId, L(user?.language || 'uz',
      '❌ <b>Profil tasdiqlanmadi</b>\n\nMa’lumotlarni tekshirib, profilni qayta yuboring. Botdan foydalanish davom etadi.',
      '❌ <b>Профиль не подтверждён</b>\n\nПроверьте данные и отправьте профиль повторно. Ботом можно продолжать пользоваться.'),
      { reply_markup:inlineKeyboard([[{ text:L(user?.language||'uz','✏️ Profilni qayta to‘ldirish','✏️ Заполнить профиль заново'),callback_data:'v18:fill' }]]) });
  } catch {}
  await sendMessage(env, q.message.chat.id,
    `❌ <b>${escapeHtml(fullName(p) || String(telegramId))}</b> profili qaytarildi.`,
    q.message.message_thread_id ? { message_thread_id:q.message.message_thread_id } : {});
  return true;
}

async function adminView(env, q, telegramId) {
  if (!isAdmin(env, q.from.id)) { await answerCallback(env, q.id, 'Ruxsat yo‘q'); return true; }
  const p = await getClientProfile(env, telegramId);
  const user = await getUser(env, telegramId);
  await answerCallback(env, q.id);
  if (!p) return true;
  await sendMessage(env, q.message.chat.id, [
    adminProfileText(user, p),
    '',
    `📌 Status: <b>${escapeHtml(p.status)}</b>`,
    p.reviewed_by_name ? `🛡 Reviewer: ${escapeHtml(p.reviewed_by_name)}` : null
  ].filter(Boolean).join('\n'), {
    ...(q.message.message_thread_id ? { message_thread_id:q.message.message_thread_id } : {}),
    reply_markup: p.status === 'pending' ? adminProfileKeyboard(telegramId) : undefined
  });
  return true;
}

async function listPending(env, msg) {
  if (!isAdmin(env, msg.from.id)) return false;
  const r = await env.DB.prepare(`SELECT p.*,u.username FROM fn18_profiles p
    LEFT JOIN fn5_users u ON u.telegram_id=p.telegram_id
    WHERE p.status='pending' ORDER BY p.submitted_at ASC LIMIT 20`).all();
  const rows = r.results || [];
  await sendMessage(env, msg.chat.id, [
    '🛡 <b>Tasdiq kutayotgan profillar</b>',
    '',
    ...(rows.length ? rows.map(x =>
      `⏳ <code>${x.telegram_id}</code> · <b>${escapeHtml(fullName(x))}</b>${x.username ? ` · @${escapeHtml(x.username)}` : ''}`
    ) : ['✅ Navbat bo‘sh']),
    '',
    rows.length ? 'Ko‘rish: <code>/client TELEGRAM_ID</code>' : null
  ].filter(Boolean).join('\n'));
  return true;
}

async function adminClientCommand(env, msg, telegramId) {
  if (!isAdmin(env, msg.from.id)) return false;
  const p = await getClientProfile(env, telegramId);
  const user = await getUser(env, telegramId);
  if (!p) {
    await sendMessage(env, msg.chat.id, '⚠️ Profil topilmadi.');
    return true;
  }
  await sendMessage(env, msg.chat.id, [
    adminProfileText(user, p),
    '',
    `📌 Status: <b>${escapeHtml(p.status)}</b>`
  ].join('\n'), {
    reply_markup: p.status === 'pending' ? adminProfileKeyboard(telegramId) : undefined
  });
  return true;
}

function ticketIdentifierKeyboard(lang, department) {
  const rows = [];
  if (department !== 'connection') {
    rows.push([{ text:L(lang,'🔐 Login / shartnoma','🔐 Логин / договор'),callback_data:'v18:ticketmode:login' }]);
  }
  rows.push([{ text:L(lang,'📍 Manzil','📍 Адрес'),callback_data:'v18:ticketmode:address' }]);
  rows.push([{ text:L(lang,'❌ Bekor qilish','❌ Отмена'),callback_data:'v18:cancel' }]);
  return inlineKeyboard(rows);
}

async function beginUnverifiedTicket(env, q) {
  const [, department, entityType='none', category='other'] = String(q.data || '').split(':');
  const user = await upsertUser(env, q.from);
  const lang = user.language || 'uz';
  await answerCallback(env, q.id);
  await setSession(env, user.telegram_id, 'v18_ticket_first', { department, entityType, category });
  return sendMessage(env, q.message.chat.id, [
    `👨‍💻 <b>${L(lang,'Operatorga murojaat','Обращение оператору')}</b>`,
    `${categoryMeta(category,lang).icon} ${escapeHtml(categoryMeta(category,lang).title)}`,
    '',
    L(lang,
      'Profil tasdiqlanmagan, shuning uchun ushbu murojaat uchun ma’lumotlarni kiritamiz. Avval <b>ismingizni</b> yozing:',
      'Профиль не подтверждён, поэтому введём данные для этого обращения. Сначала напишите <b>имя</b>:')
  ].join('\n'));
}

async function handleSessionMessage(env, msg, user, s) {
  const lang = user.language || 'uz';
  const d = sessionData(s);
  const text = String(msg.text || '').trim();

  if (s.state === 'v18_profile_first') {
    const name = validName(text);
    if (!name) {
      await sendMessage(env,msg.chat.id,L(lang,'⚠️ Ismni to‘g‘ri yozing. Raqam ishlatmang.','⚠️ Введите корректное имя без цифр.'));
      return true;
    }
    d.givenName=name;
    await setSession(env,user.telegram_id,'v18_profile_last',d);
    await sendMessage(env,msg.chat.id,L(lang,'2️⃣ <b>Familiyangizni yozing</b>','2️⃣ <b>Введите фамилию</b>'));
    return true;
  }
  if (s.state === 'v18_profile_last') {
    const name = validName(text);
    if (!name) {
      await sendMessage(env,msg.chat.id,L(lang,'⚠️ Familiyani to‘g‘ri yozing. Raqam ishlatmang.','⚠️ Введите корректную фамилию без цифр.'));
      return true;
    }
    d.familyName=name;
    await setSession(env,user.telegram_id,'v18_profile_login',d);
    await sendMessage(env,msg.chat.id,L(lang,
      '3️⃣ <b>Login yoki shartnoma raqami</b>\n\nIxtiyoriy. Bilmasangiz o‘tkazib yuboring.',
      '3️⃣ <b>Логин или номер договора</b>\n\nНеобязательно. Если не знаете — пропустите.'),
      {reply_markup:optionalKeyboard(lang,'login')});
    return true;
  }
  if (s.state === 'v18_profile_login') {
    d.login = text === '-' ? null : text.slice(0,100);
    await setSession(env,user.telegram_id,'v18_profile_address',d);
    await sendMessage(env,msg.chat.id,L(lang,
      '4️⃣ <b>Ulanish manzili</b>\n\nIxtiyoriy. Xohlasangiz o‘tkazib yuboring.',
      '4️⃣ <b>Адрес подключения</b>\n\nНеобязательно. Можно пропустить.'),
      {reply_markup:optionalKeyboard(lang,'address')});
    return true;
  }
  if (s.state === 'v18_profile_address') {
    d.address = text === '-' ? null : text.slice(0,350);
    await setSession(env,user.telegram_id,'v18_profile_preview',d);
    await profilePreview(env,msg.chat.id,user,d);
    return true;
  }

  if (s.state === 'v18_ticket_first') {
    const name=validName(text);
    if(!name){await sendMessage(env,msg.chat.id,L(lang,'⚠️ Ismni to‘g‘ri yozing.','⚠️ Введите корректное имя.'));return true;}
    d.givenName=name;
    await setSession(env,user.telegram_id,'v18_ticket_last',d);
    await sendMessage(env,msg.chat.id,L(lang,'Familiyangizni yozing:','Введите фамилию:'));
    return true;
  }
  if (s.state === 'v18_ticket_last') {
    const name=validName(text);
    if(!name){await sendMessage(env,msg.chat.id,L(lang,'⚠️ Familiyani to‘g‘ri yozing.','⚠️ Введите корректную фамилию.'));return true;}
    d.familyName=name;
    d.customerName=[d.givenName,d.familyName].join(' ');
    await setSession(env,user.telegram_id,'v18_ticket_mode',d);
    await sendMessage(env,msg.chat.id,L(lang,
      'Abonentni topish uchun bittasini tanlang:',
      'Выберите данные для поиска абонента:'),
      {reply_markup:ticketIdentifierKeyboard(lang,d.department)});
    return true;
  }
  if (s.state === 'v18_ticket_value') {
    if(!text){await sendMessage(env,msg.chat.id,L(lang,'✍️ Ma’lumotni matn bilan yuboring.','✍️ Отправьте данные текстом.'));return true;}
    if(d.identifierMode==='login'){d.accountLogin=text.slice(0,100);d.address=null;}
    else {d.address=text.slice(0,350);d.accountLogin=null;}
    if(d.category==='other'){
      await setSession(env,user.telegram_id,'v18_ticket_details',d);
      await sendMessage(env,msg.chat.id,L(lang,'📝 Muammoni 1–3 gapda yozing:','📝 Опишите проблему в 1–3 предложениях:'));
      return true;
    }
    await createExpressTicket(env,msg,user,d);
    return true;
  }
  if (s.state === 'v18_ticket_details') {
    if(!text){await sendMessage(env,msg.chat.id,L(lang,'📝 Muammoni matn bilan yozing.','📝 Опишите проблему текстом.'));return true;}
    d.details=text.slice(0,1600);
    await createExpressTicket(env,msg,user,d);
    return true;
  }
  return false;
}

async function fieldSkip(env,q,field) {
  const user=await upsertUser(env,q.from);
  const lang=user.language||'uz';
  const s=await getSession(env,user.telegram_id);
  const d=sessionData(s);
  await answerCallback(env,q.id);
  if(field==='login' && s?.state==='v18_profile_login'){
    d.login=null;
    await setSession(env,user.telegram_id,'v18_profile_address',d);
    await sendMessage(env,q.message.chat.id,L(lang,
      '4️⃣ <b>Ulanish manzili</b>\n\nIxtiyoriy. Xohlasangiz o‘tkazib yuboring.',
      '4️⃣ <b>Адрес подключения</b>\n\nНеобязательно. Можно пропустить.'),
      {reply_markup:optionalKeyboard(lang,'address')});
    return true;
  }
  if(field==='address' && s?.state==='v18_profile_address'){
    d.address=null;
    await setSession(env,user.telegram_id,'v18_profile_preview',d);
    await profilePreview(env,q.message.chat.id,user,d);
    return true;
  }
  return true;
}

async function ticketMode(env,q,mode) {
  const user=await upsertUser(env,q.from);
  const lang=user.language||'uz';
  const s=await getSession(env,user.telegram_id);
  const d=sessionData(s);
  await answerCallback(env,q.id);
  if(s?.state!=='v18_ticket_mode') return true;
  d.identifierMode=mode;
  await setSession(env,user.telegram_id,'v18_ticket_value',d);
  await sendMessage(env,q.message.chat.id,mode==='login'
    ? L(lang,'🔐 Login yoki shartnoma raqamini yuboring. <b>Parol yubormang.</b>','🔐 Отправьте логин или номер договора. <b>Пароль не отправляйте.</b>')
    : L(lang,'📍 Ulanish manzilini to‘liq yozing:','📍 Напишите полный адрес подключения:'));
  return true;
}

async function handleCallback(env,q,updateId) {
  const data=String(q.data||'');

  if(data.startsWith('v18admin:')){
    if(!await claimUpdate(env,updateId)) return true;
    const [,action,id]=data.split(':');
    if(action==='approve') return approveProfile(env,q,id);
    if(action==='reject') return rejectProfile(env,q,id);
    if(action==='view') return adminView(env,q,id);
    return true;
  }

  if(!isPrivate(q.message?.chat)) return false;

  if(data.startsWith('lang:')){
    if(!await claimUpdate(env,updateId)) return true;
    const user=await upsertUser(env,q.from);
    const lang=data==='lang:ru'?'ru':'uz';
    await setLanguage(env,user.telegram_id,lang);
    await clearSession(env,user.telegram_id);
    await answerCallback(env,q.id);
    const fresh=await getUser(env,user.telegram_id);
    return showProfileGate(env,q.message.chat.id,fresh);
  }

  if(data==='home:profile' || data==='v18:profile'){
    if(!await claimUpdate(env,updateId)) return true;
    const user=await upsertUser(env,q.from);
    await answerCallback(env,q.id);
    return showProfile(env,q.message.chat.id,user);
  }
  if(data==='v18:fill'){
    if(!await claimUpdate(env,updateId)) return true;
    await answerCallback(env,q.id);
    return startProfileForm(env,q);
  }
  if(data==='v18:skip'){
    if(!await claimUpdate(env,updateId)) return true;
    return skipProfile(env,q);
  }
  if(data==='v18:submit'){
    if(!await claimUpdate(env,updateId)) return true;
    return submitProfile(env,q);
  }
  if(data==='v18:continue'){
    if(!await claimUpdate(env,updateId)) return true;
    const user=await upsertUser(env,q.from);
    await clearSession(env,user.telegram_id);
    await answerCallback(env,q.id);
    return showHome(env,q.message.chat.id,user);
  }
  if(data==='v18:cancel'){
    if(!await claimUpdate(env,updateId)) return true;
    const user=await upsertUser(env,q.from);
    await clearSession(env,user.telegram_id);
    await answerCallback(env,q.id);
    return showHome(env,q.message.chat.id,user);
  }
  if(data.startsWith('v18:fieldskip:')){
    if(!await claimUpdate(env,updateId)) return true;
    return fieldSkip(env,q,data.split(':')[2]);
  }
  if(data.startsWith('v18:ticketmode:')){
    if(!await claimUpdate(env,updateId)) return true;
    return ticketMode(env,q,data.split(':')[2]);
  }
  if(data.startsWith('assist:')){
    const profile=await getClientProfile(env,q.from.id);
    if(profile?.status==='approved') return false;
    if(!await claimUpdate(env,updateId)) return true;
    return beginUnverifiedTicket(env,q);
  }
  return false;
}

async function handleMessage(env,msg,updateId) {
  if(msg.from?.is_bot) return false;

  const text=String(msg.text||'').trim();
  const start=text.match(/^\/start(?:@\w+)?(?:\s|$)/i);
  if(isPrivate(msg.chat) && start){
    if(!await claimUpdate(env,updateId)) return true;
    const user=await upsertUser(env,msg.from);
    await clearSession(env,user.telegram_id);
    await sendMessage(env,msg.chat.id,
      '🌐 <b>Tilni tanlang / Выберите язык</b>\n\n🇺🇿 O‘zbekcha yoki 🇷🇺 Русский',
      {reply_markup:languageKeyboard()});
    return true;
  }

  if(isPrivate(msg.chat) && /^\/profile(?:@\w+)?$/i.test(text)){
    if(!await claimUpdate(env,updateId)) return true;
    const user=await upsertUser(env,msg.from);
    return showProfile(env,msg.chat.id,user);
  }

  if((isGroup(msg.chat)||isPrivate(msg.chat)) && /^\/profiles(?:@\w+)?$/i.test(text)){
    if(!isAdmin(env,msg.from.id)) return false;
    if(!await claimUpdate(env,updateId)) return true;
    return listPending(env,msg);
  }
  const cm=text.match(/^\/client(?:@\w+)?\s+(\d+)$/i);
  if((isGroup(msg.chat)||isPrivate(msg.chat)) && cm && isAdmin(env,msg.from.id)){
    if(!await claimUpdate(env,updateId)) return true;
    return adminClientCommand(env,msg,cm[1]);
  }

  if(!isPrivate(msg.chat)) return false;
  const user=await upsertUser(env,msg.from);
  const s=await getSession(env,user.telegram_id);
  if(!s || !s.state?.startsWith('v18_')) return false;
  if(!await claimUpdate(env,updateId)) return true;
  return handleSessionMessage(env,msg,user,s);
}

export async function handleV18Update(env,update){
  await ensureV18Schema(env);
  const q=update?.callback_query;
  if(q?.message?.chat && await handleCallback(env,q,update.update_id)) return true;
  const msg=update?.message;
  if(msg && await handleMessage(env,msg,update.update_id)) return true;
  return false;
}

export async function runV18Maintenance(env){
  await ensureV18Schema(env);
  await env.DB.prepare("DELETE FROM fn18_processed WHERE created_at < datetime('now','-7 day')").run();
}

export async function v18Health(env){
  await ensureV18Schema(env);
  const r=await env.DB.prepare(`SELECT
    COUNT(*) total,
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved,
    SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) skipped,
    SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) rejected
    FROM fn18_profiles`).first();
  return {
    mode:'optional-profile-admin-approval-approved-ticket-autofill-unverified-ticket-intake',
    profiles:r||{}
  };
}

export const __test={validName,profileStatusText};
