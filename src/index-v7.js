import v6 from './index-v6.js';
import { syncOfficialSources } from './catalog.js';
import {
  addMessage, assignTicket, claimUpdate, cleanupUpdates, clearSession, closeTicket,
  createTicket, deliveryDone, deliveryFailed, enqueueDelivery, ensureV5Schema,
  getSession, getTicket, getTicketBySupportMessage, getUser, listQueue, pendingDeliveries,
  saveProfile, sessionData, setStage, setSupportMessage, stats, upsertUser
} from './v5-db.js';
import {
  categoryMeta, classifyText, departmentMeta, L, normalizePhone, operatorName, priorityFor
} from './v6-ui.js';
import {
  answerCallback, copyMessage, editReplyMarkup, escapeHtml, inlineKeyboard, sendMessage
} from './telegram.js';
import {
  bindDepartment, claimV7Update, cleanupOperatorReplySessions, cleanupV7Updates,
  clearOperatorReplySession, DEPARTMENTS, ensureV7Routing, getDepartmentByChat,
  getDepartmentChat, getOperatorReplySession, listDepartmentChats, releaseV7Update,
  setOperatorReplySession, unbindDepartment, validDepartment
} from './v7-routing.js';

const VERSION = '7.0.0';
const ENV_CHAT_KEYS = {
  general: 'SUPPORT_CHAT_ID',
  tech: 'TECH_CHAT_ID',
  accounting: 'ACCOUNTING_CHAT_ID',
  subscriber: 'SUBSCRIBER_CHAT_ID',
  connection: 'CONNECTION_CHAT_ID'
};

function adminIds(env) {
  return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String);
}
function isAdmin(env, id) { return adminIds(env).includes(String(id)); }
function isGroup(msg) { return msg?.chat?.type === 'group' || msg?.chat?.type === 'supergroup'; }
function isPrivate(msg) { return msg?.chat?.type === 'private'; }
function userName(u) {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : String(u?.telegram_id || '—'));
}
function operatorKeyboard(no) {
  return inlineKeyboard([
    [
      { text: '👨‍💻 Qabul qilish', callback_data: `op:claim:${no}` },
      { text: '💬 Javob berish', callback_data: `op:reply:${no}` }
    ],
    [
      { text: '⏳ Mijozni kutish', callback_data: `op:wait:${no}` },
      { text: '✅ Hal qilindi', callback_data: `op:resolve:${no}` }
    ],
    [{ text: '❌ Murojaatni yopish', callback_data: `op:close:${no}` }]
  ]);
}
function userTicketKeyboard(lang, no) {
  return inlineKeyboard([
    [{ text: L(lang, '💬 Javob yozish', '💬 Ответить'), callback_data: `ticket:reply:${no}` }],
    [{ text: L(lang, '📂 Murojaatlarim', '📂 Мои обращения'), callback_data: 'home:tickets' }]
  ]);
}
function resolvedKeyboard(lang, no) {
  return inlineKeyboard([
    [{ text: '👍', callback_data: `feedback:${no}:1` }, { text: '👎', callback_data: `feedback:${no}:0` }],
    [{ text: L(lang, '💬 Muammo davom etyapti', '💬 Проблема осталась'), callback_data: `ticket:reply:${no}` }]
  ]);
}

async function resolveDepartmentChat(env, department) {
  const bound = await getDepartmentChat(env, department);
  if (bound?.chat_id) return { chatId: bound.chat_id, source: 'bound', title: bound.title || null };
  const key = ENV_CHAT_KEYS[department] || 'SUPPORT_CHAT_ID';
  if (env[key]) return { chatId: env[key], source: 'env', title: key };
  if (env.SUPPORT_CHAT_ID) return { chatId: env.SUPPORT_CHAT_ID, source: 'fallback', title: 'SUPPORT_CHAT_ID' };
  return null;
}

async function routeStatus(env) {
  const bound = await listDepartmentChats(env);
  const byDept = Object.fromEntries(bound.map(x => [x.department, x]));
  const result = {};
  for (const d of DEPARTMENTS) {
    if (byDept[d]) result[d] = { configured: true, source: 'bound', title: byDept[d].title || null };
    else {
      const key = ENV_CHAT_KEYS[d];
      result[d] = { configured: Boolean(env[key] || env.SUPPORT_CHAT_ID), source: env[key] ? 'env' : env.SUPPORT_CHAT_ID ? 'fallback' : 'missing' };
    }
  }
  return result;
}

async function deliverTicket(env, no) {
  const t = await getTicket(env, no);
  if (!t) throw new Error(`Ticket ${no} not found`);
  const u = await getUser(env, t.telegram_id);
  const lang = u?.language || 'uz';
  const d = departmentMeta(t.department, lang);
  const c = categoryMeta(t.category, lang);
  const route = await resolveDepartmentChat(env, t.department);
  if (!route?.chatId) throw new Error(`No operator group configured for ${t.department}`);

  const text = [
    `${t.priority === 'critical' ? '🚨' : t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡'} <b>${escapeHtml(t.priority.toUpperCase())} · ${escapeHtml(no)}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    `${d.icon} <b>${escapeHtml(d.title)}</b>`,
    `${c.icon} ${escapeHtml(c.title)}`,
    '',
    `👤 <b>${escapeHtml(userName(u))}</b>`,
    u?.username ? `🔗 @${escapeHtml(u.username)}` : null,
    `🆔 Telegram: <code>${t.telegram_id}</code>`,
    `🔐 Login/shartnoma: <code>${escapeHtml(t.account_login || '—')}</code>`,
    `📍 Manzil: ${escapeHtml(t.address || '—')}`,
    `📞 Telefon: <b>${escapeHtml(t.phone || '—')}</b>`,
    '',
    `📝 <b>${L(lang, 'Mijoz murojaati', 'Обращение клиента')}:</b>`,
    escapeHtml(t.description || '—'),
    '',
    '👨‍💻 <b>Operator tartibi:</b>',
    '1️⃣ Qabul qilish',
    '2️⃣ Javob berish tugmasini bosish',
    '3️⃣ Guruhga javobni yozish — bot mijozga yuboradi'
  ].filter(Boolean).join('\n');

  const candidates = [route.chatId];
  if (env.SUPPORT_CHAT_ID && String(env.SUPPORT_CHAT_ID) !== String(route.chatId)) candidates.push(env.SUPPORT_CHAT_ID);
  let lastError;
  for (const chatId of candidates) {
    try {
      const sent = await sendMessage(env, chatId, text, { reply_markup: operatorKeyboard(no) });
      await setSupportMessage(env, no, chatId, sent.message_id);
      await deliveryDone(env, no);
      return { chatId, messageId: sent.message_id };
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error('Ticket delivery failed');
}

async function safeDeliver(env, no) {
  try { await deliverTicket(env, no); return true; }
  catch (e) {
    await enqueueDelivery(env, no, e);
    console.error('v7 ticket queued', { no, error: String(e) });
    return false;
  }
}

async function clientTicket(env, msg, user, department, category, forcedText = null) {
  const lang = user.language || 'uz';
  const text = String(forcedText ?? msg.text ?? msg.caption ?? '').trim();
  const hasMedia = Boolean(msg.photo || msg.document || msg.video || msg.voice || msg.audio);
  if (!text && !hasMedia) {
    await sendMessage(env, msg.chat.id, L(lang, '✍️ Muammo yoki savolingizni matn, rasm, fayl yoki voice bilan yuboring.', '✍️ Отправьте вопрос текстом, фото, файлом или voice.'));
    return null;
  }
  const description = (text || L(lang, 'Rasm/fayl/voice yuborildi', 'Отправлено фото/файл/voice')).slice(0, 2500);
  const no = await createTicket(env, {
    telegramId: user.telegram_id,
    department: department || 'general',
    category: category || 'other',
    description,
    accountLogin: user.account_login,
    address: user.address,
    phone: user.phone,
    priority: priorityFor(category, description),
    telegramMessageId: msg.message_id
  });
  await clearSession(env, user.telegram_id);
  const delivered = await safeDeliver(env, no);
  const t = await getTicket(env, no);
  if (delivered && !msg.text && hasMedia && t?.support_chat_id) {
    try { await copyMessage(env, t.support_chat_id, msg.chat.id, msg.message_id); } catch {}
  }
  await sendMessage(env, msg.chat.id, L(lang,
    `✅ <b>Murojaat qabul qilindi</b>\n\n🎫 ID: <code>${no}</code>\n${delivered ? '👨‍💻 Murojaat tegishli operator guruhiga yuborildi.' : '⏳ Murojaat saqlandi va operator guruhiga qayta yuborish navbatiga qo‘yildi.'}\n\nOperator javobi shu botga keladi.`,
    `✅ <b>Обращение принято</b>\n\n🎫 ID: <code>${no}</code>\n${delivered ? '👨‍💻 Обращение отправлено в группу нужного отдела.' : '⏳ Обращение сохранено и поставлено в очередь повторной отправки.'}\n\nОтвет оператора придёт в этот бот.`
  ), { reply_markup: userTicketKeyboard(lang, no) });
  return no;
}

async function startCompose(env, q, department, category) {
  const user = await upsertUser(env, q.from);
  const lang = user.language || 'uz';
  await setSession(env, user.telegram_id, 'compose', { department, category });
  const d = departmentMeta(department, lang);
  const c = categoryMeta(category, lang);
  await answerCallback(env, q.id, L(lang, 'Xabaringizni yozing', 'Напишите сообщение'));
  return sendMessage(env, q.message.chat.id, [
    `${d.icon} <b>${escapeHtml(d.title)}</b>`,
    `${c.icon} ${escapeHtml(c.title)}`,
    '',
    L(lang, '✍️ Endi muammo yoki savolingizni yozing. Keyingi xabaringiz shu bo‘limga yuboriladi.', '✍️ Теперь напишите проблему или вопрос. Следующее сообщение уйдёт в этот отдел.'),
    L(lang, '📎 Rasm, fayl va voice ham mumkin.  ❌ Bekor qilish: /cancel', '📎 Можно фото, файл и voice.  ❌ Отмена: /cancel')
  ].join('\n'));
}

async function handlePrivateIntercept(env, update) {
  if (update.callback_query) {
    const q = update.callback_query;
    const data = q.data || '';
    if (data.startsWith('quick:')) {
      const [, department, category = 'other'] = data.split(':');
      await startCompose(env, q, department, category);
      return true;
    }
    return false;
  }
  const msg = update.message;
  if (!isPrivate(msg)) return false;
  const user = await upsertUser(env, msg.from);
  const session = await getSession(env, user.telegram_id);
  const text = String(msg.text || '').trim();

  if (session?.state === 'compose') {
    const d = sessionData(session);
    if (msg.contact && !msg.text && !msg.caption) {
      await sendMessage(env, msg.chat.id, L(user.language || 'uz', '📱 Kontakt qabul qilindi. Endi muammo yoki savolingizni yozing.', '📱 Контакт получен. Теперь напишите проблему или вопрос.'));
      return true;
    }
    await clientTicket(env, msg, user, d.department, d.category);
    return true;
  }
  if (session) return false;
  if (!text || text.startsWith('/')) return false;
  const intent = classifyText(text);
  if (intent.action !== 'ticket') return false;
  await clientTicket(env, msg, user, intent.department, intent.category, text);
  return true;
}

function canTake(ticket, operatorId) {
  return !ticket.assigned_to || String(ticket.assigned_to) === String(operatorId);
}

async function sendOperatorReply(env, msg, ticket, fromButton = false) {
  if (!ticket || ticket.status !== 'open') return false;
  if (!canTake(ticket, msg.from.id)) {
    await sendMessage(env, msg.chat.id, `⚠️ <code>${escapeHtml(ticket.ticket_no)}</code> boshqa operator tomonidan qabul qilingan.`);
    return true;
  }
  if (!ticket.assigned_to) await assignTicket(env, ticket.ticket_no, { id: msg.from.id, name: operatorName(msg.from) });
  const user = await getUser(env, ticket.telegram_id);
  const lang = user?.language || 'uz';
  const body = String(msg.text || msg.caption || '').trim();
  const hasMedia = Boolean(msg.photo || msg.document || msg.video || msg.voice || msg.audio);
  if (!body && !hasMedia) return true;

  try {
    if (body && !hasMedia) {
      await sendMessage(env, ticket.telegram_id,
        `👨‍💻 <b>FiberNet ${L(lang, 'operatori', 'оператор')}</b>\n🎫 <code>${escapeHtml(ticket.ticket_no)}</code>\n\n${escapeHtml(body)}`,
        { reply_markup: userTicketKeyboard(lang, ticket.ticket_no) });
    } else {
      await sendMessage(env, ticket.telegram_id,
        `👨‍💻 <b>FiberNet ${L(lang, 'operatori', 'оператор')}</b> · <code>${escapeHtml(ticket.ticket_no)}</code>`);
      await copyMessage(env, ticket.telegram_id, msg.chat.id, msg.message_id);
    }
    await addMessage(env, ticket.ticket_no, 'operator', msg.from.id, body || '[attachment]', msg.message_id);
    await setStage(env, ticket.ticket_no, 'in_progress', { id: msg.from.id, name: operatorName(msg.from) });
    await clearOperatorReplySession(env, msg.chat.id, msg.from.id);
    await sendMessage(env, msg.chat.id,
      `✅ <b>Javob mijozga yuborildi</b>\n🎫 <code>${escapeHtml(ticket.ticket_no)}</code> · 👨‍💻 ${escapeHtml(operatorName(msg.from))}`,
      { reply_to_message_id: msg.message_id });
  } catch (e) {
    await sendMessage(env, msg.chat.id, `⚠️ Javobni mijozga yuborib bo‘lmadi: <code>${escapeHtml(String(e).slice(0, 220))}</code>`);
  }
  return true;
}

async function groupCommand(env, msg) {
  const text = String(msg.text || '').trim();
  const bind = text.match(/^\/bind(?:@\w+)?\s+(general|tech|accounting|subscriber|connection)$/i);
  if (bind) {
    if (!isAdmin(env, msg.from.id)) {
      await sendMessage(env, msg.chat.id, '⛔ Bu buyruq faqat bot administratoriga ruxsat etilgan.');
      return true;
    }
    const department = bind[1].toLowerCase();
    await bindDepartment(env, department, msg.chat.id, msg.chat.title || null, msg.from.id);
    const d = departmentMeta(department, 'uz');
    await sendMessage(env, msg.chat.id,
      `✅ <b>Guruh FiberNet bo‘limiga biriktirildi</b>\n\n${d.icon} ${escapeHtml(d.title)}\n🆔 <code>${msg.chat.id}</code>\n\nEndi shu bo‘lim mijozlarining yangi murojaatlari aynan shu guruhga keladi.`);
    return true;
  }
  const unbind = text.match(/^\/unbind(?:@\w+)?\s+(general|tech|accounting|subscriber|connection)$/i);
  if (unbind) {
    if (!isAdmin(env, msg.from.id)) return true;
    await unbindDepartment(env, unbind[1].toLowerCase());
    await sendMessage(env, msg.chat.id, `✅ ${escapeHtml(unbind[1])} binding olib tashlandi.`);
    return true;
  }
  if (/^\/where(?:@\w+)?$/i.test(text)) {
    const bound = await getDepartmentByChat(env, msg.chat.id);
    await sendMessage(env, msg.chat.id,
      `📍 <b>Operator guruhi</b>\n🆔 <code>${msg.chat.id}</code>\n🏷 ${escapeHtml(msg.chat.title || '—')}\n🎯 Bo‘lim: <b>${escapeHtml(bound?.department || 'biriktirilmagan')}</b>`);
    return true;
  }
  if (/^\/routes(?:@\w+)?$/i.test(text)) {
    if (!isAdmin(env, msg.from.id)) return true;
    const routes = await listDepartmentChats(env);
    const lines = DEPARTMENTS.map(d => {
      const x = routes.find(r => r.department === d);
      return `${x ? '✅' : '⚪️'} <b>${d}</b>${x ? ` → ${escapeHtml(x.title || String(x.chat_id))} · <code>${x.chat_id}</code>` : ''}`;
    });
    await sendMessage(env, msg.chat.id, `🗂 <b>FiberNet bo‘lim guruhlari</b>\n\n${lines.join('\n')}\n\nBiriktirish: <code>/bind tech</code>`);
    return true;
  }
  if (/^\/cancelreply(?:@\w+)?$/i.test(text)) {
    await clearOperatorReplySession(env, msg.chat.id, msg.from.id);
    await sendMessage(env, msg.chat.id, '❎ Javob yozish rejimi bekor qilindi.');
    return true;
  }
  if (/^\/(queue|tickets)(?:@\w+)?$/i.test(text)) {
    const bound = await getDepartmentByChat(env, msg.chat.id);
    const rows = await listQueue(env, 40);
    const filtered = bound ? rows.filter(x => x.department === bound.department) : rows;
    const body = filtered.length ? filtered.map(x =>
      `${x.priority === 'critical' ? '🚨' : x.priority === 'high' ? '🔴' : '🟡'} <b>${escapeHtml(x.ticket_no)}</b> · ${escapeHtml(x.stage)}\n${escapeHtml((x.description || '').slice(0, 140))}`
    ).join('\n\n') : '✅ Ochiq murojaat yo‘q.';
    await sendMessage(env, msg.chat.id, `📥 <b>FiberNet Queue${bound ? ` · ${escapeHtml(bound.department)}` : ''}</b>\n\n${body}`);
    return true;
  }
  if (/^\/stats(?:@\w+)?$/i.test(text)) {
    const s = await stats(env);
    await sendMessage(env, msg.chat.id, `📊 <b>FiberNet v7</b>\n\n📚 Jami: <b>${s.total || 0}</b>\n🟡 Ochiq: <b>${s.open_count || 0}</b>\n✅ Yopilgan: <b>${s.closed_count || 0}</b>`);
    return true;
  }
  if (/^\/ophelp(?:@\w+)?$/i.test(text)) {
    await sendMessage(env, msg.chat.id,
      `👨‍💻 <b>Operator qo‘llanma</b>\n\n1️⃣ Ticketda <b>Qabul qilish</b>\n2️⃣ <b>Javob berish</b>\n3️⃣ Guruhga xabar yozing — bot mijozga yuboradi\n\n/queue — navbat\n/stats — statistika\n/cancelreply — javob rejimini bekor qilish\n/where — guruh ID\n/bind tech — guruhni bo‘limga biriktirish (admin)`);
    return true;
  }
  return false;
}

async function operatorCallback(env, q) {
  const data = q.data || '';
  if (!data.startsWith('op:')) return false;
  const [, action, no] = data.split(':');
  const ticket = await getTicket(env, no);
  if (!ticket || ticket.status !== 'open') {
    await answerCallback(env, q.id, 'Murojaat yopilgan yoki topilmadi');
    return true;
  }
  if (String(ticket.support_chat_id || '') && String(ticket.support_chat_id) !== String(q.message.chat.id)) {
    await answerCallback(env, q.id, 'Bu ticket boshqa guruhga tegishli');
    return true;
  }
  const op = { id: q.from.id, name: operatorName(q.from) };
  if (!canTake(ticket, op.id) && action !== 'close') {
    await answerCallback(env, q.id, `Boshqa operator: ${ticket.assigned_name || ticket.assigned_to}`);
    return true;
  }

  if (action === 'claim') {
    await assignTicket(env, no, op);
    await answerCallback(env, q.id, 'Murojaat sizga biriktirildi');
    const u = await getUser(env, ticket.telegram_id);
    await sendMessage(env, ticket.telegram_id,
      L(u?.language || 'uz', `👨‍💻 Operator <code>${no}</code> murojaatingizni qabul qildi.`, `👨‍💻 Оператор принял ваше обращение <code>${no}</code>.`),
      { reply_markup: userTicketKeyboard(u?.language || 'uz', no) });
    await sendMessage(env, q.message.chat.id, `👨‍💻 <b>${escapeHtml(op.name)}</b> · <code>${escapeHtml(no)}</code> ni qabul qildi.`);
    return true;
  }
  if (action === 'reply') {
    if (!ticket.assigned_to) await assignTicket(env, no, op);
    await setOperatorReplySession(env, q.message.chat.id, q.from.id, no);
    await setStage(env, no, 'in_progress', op);
    await answerCallback(env, q.id, 'Endi guruhga javobingizni yozing');
    await sendMessage(env, q.message.chat.id,
      `✍️ <b>${escapeHtml(op.name)}</b>, <code>${escapeHtml(no)}</code> uchun javobingizni yozing.\n\nKeyingi yuborgan matn/rasm/fayl/voice mijozga bot orqali boradi.\n❌ Bekor qilish: /cancelreply`,
      { reply_to_message_id: q.message.message_id });
    return true;
  }
  if (action === 'wait') {
    if (!ticket.assigned_to) await assignTicket(env, no, op);
    await setStage(env, no, 'waiting_customer', op);
    await answerCallback(env, q.id, 'Mijoz javobi kutilmoqda');
    const u = await getUser(env, ticket.telegram_id);
    await sendMessage(env, ticket.telegram_id,
      L(u?.language || 'uz', `⏳ Operator <code>${no}</code> bo‘yicha javobingizni kutmoqda.`, `⏳ Оператор ждёт ваш ответ по <code>${no}</code>.`),
      { reply_markup: userTicketKeyboard(u?.language || 'uz', no) });
    return true;
  }
  if (action === 'resolve') {
    if (!ticket.assigned_to) await assignTicket(env, no, op);
    await setStage(env, no, 'resolved', op);
    await answerCallback(env, q.id, 'Hal qilindi deb belgilandi');
    const u = await getUser(env, ticket.telegram_id);
    await sendMessage(env, ticket.telegram_id,
      L(u?.language || 'uz', `✅ <b>Murojaat hal qilindi deb belgilandi</b>\n🎫 <code>${no}</code>\n\nNatijani baholang:`, `✅ <b>Обращение отмечено как решённое</b>\n🎫 <code>${no}</code>\n\nОцените результат:`),
      { reply_markup: resolvedKeyboard(u?.language || 'uz', no) });
    return true;
  }
  if (action === 'close') {
    if (ticket.assigned_to && String(ticket.assigned_to) !== String(op.id) && !isAdmin(env, op.id)) {
      await answerCallback(env, q.id, 'Faqat qabul qilgan operator yoki admin yopishi mumkin');
      return true;
    }
    await closeTicket(env, no);
    await clearOperatorReplySession(env, q.message.chat.id, q.from.id);
    await answerCallback(env, q.id, 'Murojaat yopildi');
    const u = await getUser(env, ticket.telegram_id);
    await sendMessage(env, ticket.telegram_id,
      L(u?.language || 'uz', `✅ Murojaat yopildi: <code>${no}</code>`, `✅ Обращение закрыто: <code>${no}</code>`));
    try { await editReplyMarkup(env, q.message.chat.id, q.message.message_id); } catch {}
    return true;
  }
  return true;
}

async function handleGroupIntercept(env, update) {
  if (update.callback_query) return operatorCallback(env, update.callback_query);
  const msg = update.message;
  if (!isGroup(msg)) return false;
  if (await groupCommand(env, msg)) return true;

  const opSession = await getOperatorReplySession(env, msg.chat.id, msg.from.id);
  if (opSession) {
    const ticket = await getTicket(env, opSession.ticket_no);
    await sendOperatorReply(env, msg, ticket, true);
    return true;
  }
  if (msg.reply_to_message?.message_id) {
    const ticket = await getTicketBySupportMessage(env, msg.chat.id, msg.reply_to_message.message_id);
    if (ticket) {
      await sendOperatorReply(env, msg, ticket, false);
      return true;
    }
  }
  const bound = await getDepartmentByChat(env, msg.chat.id);
  return Boolean(bound);
}

async function shouldIntercept(env, update) {
  if (update.callback_query) {
    const data = update.callback_query.data || '';
    if (data.startsWith('quick:') || data.startsWith('op:')) return true;
    return false;
  }
  const msg = update.message;
  if (!msg) return false;
  if (isGroup(msg)) {
    const text = String(msg.text || '').trim();
    if (/^\/(bind|unbind|where|routes|cancelreply|queue|tickets|stats|ophelp)(?:@\w+)?(?:\s|$)/i.test(text)) return true;
    if (await getOperatorReplySession(env, msg.chat.id, msg.from.id)) return true;
    if (msg.reply_to_message?.message_id && await getTicketBySupportMessage(env, msg.chat.id, msg.reply_to_message.message_id)) return true;
    return Boolean(await getDepartmentByChat(env, msg.chat.id));
  }
  if (isPrivate(msg)) {
    const user = await upsertUser(env, msg.from);
    const session = await getSession(env, user.telegram_id);
    if (session?.state === 'compose') return true;
    if (session) return false;
    const text = String(msg.text || '').trim();
    if (!text || text.startsWith('/')) return false;
    return classifyText(text).action === 'ticket';
  }
  return false;
}

async function processIntercept(env, update) {
  if (!await claimV7Update(env, update.update_id)) return;
  try {
    if (update.callback_query) {
      if (update.callback_query.data?.startsWith('op:')) await operatorCallback(env, update.callback_query);
      else await handlePrivateIntercept(env, update);
    } else if (update.message) {
      if (isGroup(update.message)) await handleGroupIntercept(env, update);
      else await handlePrivateIntercept(env, update);
    }
  } catch (e) {
    await releaseV7Update(env, update.update_id);
    throw e;
  }
}

async function retryDeliveries(env) {
  const rows = await pendingDeliveries(env, 30);
  for (const x of rows) {
    try { await deliverTicket(env, x.ticket_no); await deliveryDone(env, x.ticket_no); }
    catch (e) { await deliveryFailed(env, x.ticket_no, e); }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        await ensureV5Schema(env); await ensureV7Routing(env);
        return Response.json({ ok: true, service: 'fibernet-bot', version: VERSION, architecture: 'department-groups', stats: await stats(env), routes: await routeStatus(env) });
      } catch (e) {
        return Response.json({ ok: false, version: VERSION, error: String(e) }, { status: 503 });
      }
    }
    if (url.pathname === '/' && request.method === 'GET') return new Response(`FiberNet Assistant v${VERSION} is running.`);
    if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
      const delegate = request.clone();
      let update;
      try { update = await request.json(); } catch { return new Response('Bad Request', { status: 400 }); }
      if (!Number.isInteger(update.update_id)) return new Response('ok');
      await ensureV5Schema(env); await ensureV7Routing(env);
      try {
        if (await shouldIntercept(env, update)) {
          await processIntercept(env, update);
          return new Response('ok');
        }
        return v6.fetch(delegate, env, ctx);
      } catch (e) {
        console.error('FiberNet v7 webhook error', { error: String(e), stack: e?.stack });
        return new Response('Retry', { status: 500 });
      }
    }
    return v6.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await ensureV5Schema(env); await ensureV7Routing(env);
        await cleanupUpdates(env); await cleanupV7Updates(env); await cleanupOperatorReplySessions(env);
        await retryDeliveries(env);
      } catch (e) { console.error('v7 maintenance', String(e)); }
      if (controller?.cron === '15 23 * * *') {
        try { await syncOfficialSources(env); } catch (e) { console.error('v7 source sync', String(e)); }
      }
    })());
  }
};

export const __test = { classifyText, normalizePhone, priorityFor, validDepartment, ENV_CHAT_KEYS };
