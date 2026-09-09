import v8 from './index-v8.js';
import {
  deliveryDone, enqueueDelivery, ensureV5Schema, getTicket, getUser,
  listQueue, pendingDeliveries, setSupportMessage, stats
} from './v5-db.js';
import {
  bindDepartment, ensureV7Routing, getDepartmentByChat, getDepartmentChat,
  listDepartmentChats
} from './v7-routing.js';
import {
  categoryMeta, departmentMeta, L, operatorKeyboard
} from './v8-ui.js';
import {
  answerCallback, escapeHtml, inlineKeyboard, sendMessage, tg
} from './telegram.js';

const VERSION = '9.0.0';
const ENV_CHAT_KEYS = {
  tech: 'TECH_CHAT_ID',
  accounting: 'ACCOUNTING_CHAT_ID',
  subscriber: 'SUBSCRIBER_CHAT_ID',
  connection: 'CONNECTION_CHAT_ID'
};

function adminIds(env) {
  return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String);
}
function isGlobalAdmin(env, id) { return adminIds(env).includes(String(id)); }
function isGroup(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
function isPrivate(chat) { return chat?.type === 'private'; }

export function detectDepartment(title = '') {
  const s = String(title).toLowerCase();
  if (/\btech\b|texnik|техпод|техничес|support/.test(s)) return 'tech';
  if (/buxgal|бухгал|billing|accounting/.test(s)) return 'accounting';
  if (/abonent|абонент|subscriber/.test(s)) return 'subscriber';
  if (/ulanish|подключ|connection|connect/.test(s)) return 'connection';
  return null;
}

function setupKeyboard() {
  return inlineKeyboard([
    [{ text: '🛠 Texnik yordam', callback_data: 'bindhere:tech' }],
    [{ text: '👥 Abonent bo‘limi', callback_data: 'bindhere:subscriber' }],
    [{ text: '💳 Buxgalteriya', callback_data: 'bindhere:accounting' }],
    [{ text: '🔌 Ulanish bo‘limi', callback_data: 'bindhere:connection' }]
  ]);
}

async function binderAllowed(env, chatId, userId) {
  if (isGlobalAdmin(env, userId)) return true;
  try {
    const m = await tg(env, 'getChatMember', { chat_id: chatId, user_id: userId });
    return m?.status === 'creator' || m?.status === 'administrator';
  } catch { return false; }
}

async function botCanUseChat(env, chatId) {
  try {
    const me = await tg(env, 'getMe', {});
    const m = await tg(env, 'getChatMember', { chat_id: chatId, user_id: me.id });
    if (!m || m.status === 'left' || m.status === 'kicked') return false;
    if (m.status === 'restricted' && m.can_send_messages === false) return false;
    return true;
  } catch { return false; }
}

async function candidateChats(env, department) {
  const out = [];
  const bound = await getDepartmentChat(env, department);
  if (bound?.chat_id) out.push({ chatId: bound.chat_id, source: 'bound', title: bound.title || null });
  const key = ENV_CHAT_KEYS[department];
  if (key && env[key] && !out.some(x => String(x.chatId) === String(env[key]))) out.push({ chatId: env[key], source: key, title: key });
  if (env.SUPPORT_CHAT_ID && !out.some(x => String(x.chatId) === String(env.SUPPORT_CHAT_ID))) out.push({ chatId: env.SUPPORT_CHAT_ID, source: 'SUPPORT_CHAT_ID', title: 'SUPPORT_CHAT_ID' });
  return out;
}

function personName(u) {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : String(u?.telegram_id || '—'));
}

async function deliverExistingTicket(env, ticketNo) {
  const t = await getTicket(env, ticketNo);
  if (!t || t.status !== 'open') return false;
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  const d = departmentMeta(t.department, lang);
  const c = categoryMeta(t.category, lang);
  const p = t.priority === 'critical' ? '🚨' : t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
  const text = [
    `${p} <b>${escapeHtml(String(t.priority || 'normal').toUpperCase())} · ${escapeHtml(ticketNo)}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    `${d.icon} <b>${escapeHtml(d.title)}</b>`,
    `${c.icon} ${escapeHtml(c.title)}`,
    '',
    `👤 <b>${escapeHtml(personName(u))}</b>`,
    u?.username ? `🔗 @${escapeHtml(u.username)}` : null,
    `🆔 Telegram: <code>${t.telegram_id}</code>`,
    `🔐 Login/shartnoma: <code>${escapeHtml(t.account_login || '—')}</code>`,
    `📍 Manzil: ${escapeHtml(t.address || '—')}`,
    `📞 Telefon: <b>${escapeHtml(t.phone || '—')}</b>`,
    '',
    `📝 <b>${L(lang, 'Murojaat', 'Обращение')}:</b>`,
    escapeHtml(t.description || '—')
  ].filter(Boolean).join('\n');

  let lastError = null;
  for (const route of await candidateChats(env, t.department)) {
    try {
      if (!await botCanUseChat(env, route.chatId)) throw new Error(`Bot has no access to ${route.chatId}`);
      const sent = await sendMessage(env, route.chatId, text, { reply_markup: operatorKeyboard(ticketNo) });
      await setSupportMessage(env, ticketNo, route.chatId, sent.message_id);
      await deliveryDone(env, ticketNo);
      return true;
    } catch (e) { lastError = e; }
  }
  await enqueueDelivery(env, ticketNo, lastError || `No operator group configured for ${t.department}`);
  return false;
}

async function flushDepartment(env, department) {
  const seen = new Set();
  const rows = await pendingDeliveries(env, 50);
  for (const row of rows) {
    const t = await getTicket(env, row.ticket_no);
    if (t?.department === department && !t.support_chat_id) {
      seen.add(t.ticket_no);
      await deliverExistingTicket(env, t.ticket_no);
    }
  }
  const queue = await listQueue(env, 100);
  for (const t of queue) {
    if (t.department === department && !t.support_chat_id && !seen.has(t.ticket_no)) await deliverExistingTicket(env, t.ticket_no);
  }
}

async function setupGroup(env, chat, department, userId) {
  await bindDepartment(env, department, chat.id, chat.title || null, userId || null);
  await sendMessage(env, chat.id,
    `✅ <b>FiberNet bo‘lim guruhi ulandi</b>\n\n🎯 <b>${escapeHtml(departmentMeta(department, 'uz').title)}</b>\n🆔 <code>${chat.id}</code>\n\n⏳ Navbatdagi eski murojaatlar ham shu guruhga qayta yuboriladi.`);
  await flushDepartment(env, department);
}

async function handleSetupMessage(env, msg) {
  const text = String(msg.text || '').trim();
  if (!isGroup(msg.chat) || !/^\/setup(?:@\w+)?$/i.test(text)) return false;
  const current = await getDepartmentByChat(env, msg.chat.id);
  await sendMessage(env, msg.chat.id,
    `⚙️ <b>FiberNet operator guruhi</b>\n\n${current ? `Hozirgi bo‘lim: <b>${escapeHtml(departmentMeta(current.department, 'uz').title)}</b>\n\n` : ''}Bu guruh qaysi bo‘lim uchun ishlashini tanlang:`,
    { reply_markup: setupKeyboard() });
  return true;
}

async function handleBindCallback(env, q) {
  const data = String(q.data || '');
  if (!data.startsWith('bindhere:') || !isGroup(q.message?.chat)) return false;
  const department = data.slice('bindhere:'.length);
  if (!ENV_CHAT_KEYS[department]) {
    await answerCallback(env, q.id, 'Noto‘g‘ri bo‘lim');
    return true;
  }
  if (!await binderAllowed(env, q.message.chat.id, q.from.id)) {
    await answerCallback(env, q.id, 'Faqat guruh admini');
    return true;
  }
  await answerCallback(env, q.id, 'Guruh ulanmoqda…');
  await setupGroup(env, q.message.chat, department, q.from.id);
  return true;
}

async function handleMyChatMember(env, update) {
  const m = update.my_chat_member;
  if (!m || !isGroup(m.chat)) return false;
  const status = m.new_chat_member?.status;
  if (!['member', 'administrator', 'creator'].includes(status)) return false;
  const detected = detectDepartment(m.chat.title || '');
  if (detected) await setupGroup(env, m.chat, detected, m.from?.id || null);
  else await sendMessage(env, m.chat.id,
    '👋 <b>FiberNet Assistant operator guruhiga qo‘shildi.</b>\n\nBu guruhni bo‘limga ulash uchun <code>/setup</code> yuboring.');
  return true;
}

async function interceptQueuedReply(env, q) {
  const data = String(q.data || '');
  if (!data.startsWith('ticket:reply:') || !isPrivate(q.message?.chat)) return false;
  const no = data.slice('ticket:reply:'.length);
  const t = await getTicket(env, no);
  if (!t || String(t.telegram_id) !== String(q.from.id) || t.status !== 'open') return false;
  if (t.support_chat_id && await botCanUseChat(env, t.support_chat_id)) return false;

  const delivered = await deliverExistingTicket(env, no);
  if (delivered) return false;

  await answerCallback(env, q.id, 'Operator guruhi hali ulanmagan');
  const u = await getUser(env, q.from.id);
  await sendMessage(env, q.message.chat.id,
    L(u?.language || 'uz',
      `⚠️ <b>Operator guruhi ulanmagan</b>\n\n🎫 <code>${escapeHtml(no)}</code> saqlangan. Admin tegishli operator guruhida <code>/setup</code> qilib bo‘limni ulashi kerak. Ulangach murojaat avtomatik qayta yuboriladi.`,
      `⚠️ <b>Группа операторов ещё не подключена</b>\n\n🎫 <code>${escapeHtml(no)}</code> сохранено. Администратор должен открыть нужную группу операторов, отправить <code>/setup</code> и выбрать отдел. После подключения обращение будет отправлено автоматически.`));
  return true;
}

async function routesHealth(env) {
  const rows = await listDepartmentChats(env);
  const result = [];
  for (const d of ['tech', 'subscriber', 'accounting', 'connection']) {
    const x = rows.find(r => r.department === d);
    result.push({ department: d, chat_id: x?.chat_id || null, title: x?.title || null, reachable: x?.chat_id ? await botCanUseChat(env, x.chat_id) : false });
  }
  return result;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        await ensureV5Schema(env); await ensureV7Routing(env);
        return Response.json({ ok: true, service: 'fibernet-bot', version: VERSION, architecture: 'guided-department-groups', stats: await stats(env), routes: await routesHealth(env) });
      } catch (e) { return Response.json({ ok: false, version: VERSION, error: String(e) }, { status: 503 }); }
    }
    if (request.method === 'GET' && url.pathname === '/') return new Response(`FiberNet Assistant v${VERSION} is running.`);
    if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
      const delegate = request.clone();
      let update;
      try { update = await request.json(); } catch { return new Response('Bad Request', { status: 400 }); }
      try {
        await ensureV5Schema(env); await ensureV7Routing(env);
        if (update.my_chat_member && await handleMyChatMember(env, update)) return new Response('ok');
        if (update.message && await handleSetupMessage(env, update.message)) return new Response('ok');
        if (update.callback_query && await handleBindCallback(env, update.callback_query)) return new Response('ok');
        if (update.callback_query && await interceptQueuedReply(env, update.callback_query)) return new Response('ok');
        return v8.fetch(delegate, env, ctx);
      } catch (e) {
        console.error('FiberNet v9 wrapper error', { error: String(e), stack: e?.stack });
        return new Response('Retry', { status: 500 });
      }
    }
    return v8.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) { return v8.scheduled(controller, env, ctx); }
};
