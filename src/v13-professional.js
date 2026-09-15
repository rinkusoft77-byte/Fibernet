import {
  closeTicket, getTicket, getTicketBySupportMessage, getUser, listQueue, stats
} from './v5-db.js';
import { getDepartmentByChat, getDepartmentChat } from './v7-routing.js';
import { categoryMeta, departmentMeta, L, operatorName } from './v8-ui.js';
import { escapeHtml, sendMessage, tg } from './telegram.js';

const now = () => new Date().toISOString();
let ready = false;

const ENV_CHAT_KEYS = {
  tech: 'TECH_CHAT_ID',
  accounting: 'ACCOUNTING_CHAT_ID',
  subscriber: 'SUBSCRIBER_CHAT_ID',
  connection: 'CONNECTION_CHAT_ID',
  general: 'SUPPORT_CHAT_ID'
};

const SLA_MINUTES = {
  critical: 10,
  high: 20,
  normal: 45,
  low: 90
};

const STAGE_LABEL = {
  new: '🆕 Yangi',
  in_progress: '🟠 Jarayonda',
  waiting_customer: '⏳ Mijoz javobi kutilmoqda',
  resolved: '✅ Hal qilindi',
  closed: '⚫️ Yopildi'
};

function isPrivate(chat) { return chat?.type === 'private'; }
function isGroup(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
function adminIds(env) { return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(String); }
function isAdmin(env, id) { return adminIds(env).includes(String(id)); }
function bodyOf(msg) { return String(msg?.text || msg?.caption || '').trim(); }
function minutesSince(value) {
  const n = Date.now() - new Date(value || 0).getTime();
  return Number.isFinite(n) ? Math.max(0, Math.floor(n / 60000)) : 0;
}

export async function ensureV13Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn13_ticket_meta (
      ticket_no TEXT PRIMARY KEY,
      first_operator_reply_at TEXT,
      last_customer_at TEXT,
      last_operator_at TEXT,
      last_sla_alert_at TEXT,
      last_stale_alert_at TEXT,
      last_waiting_reminder_at TEXT,
      auto_closed_at TEXT,
      reopen_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fn13_internal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL,
      operator_id INTEGER,
      operator_name TEXT,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn13_notes_ticket ON fn13_internal_notes(ticket_no,id DESC)`,
    `CREATE TABLE IF NOT EXISTS fn13_agents (
      chat_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      operator_name TEXT,
      status TEXT NOT NULL DEFAULT 'online',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(chat_id,operator_id)
    )`,
    `CREATE TABLE IF NOT EXISTS fn13_processed (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  for (const q of sql) await env.DB.prepare(q).run();
  ready = true;
}

async function claimUpdate(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  await ensureV13Schema(env);
  try {
    await env.DB.prepare('INSERT INTO fn13_processed(update_id) VALUES(?)').bind(updateId).run();
    return true;
  } catch (e) {
    const s = String(e).toLowerCase();
    if (s.includes('unique') || s.includes('constraint')) return false;
    throw e;
  }
}

async function ensureMeta(env, ticketNo) {
  if (!ticketNo) return;
  await ensureV13Schema(env);
  await env.DB.prepare(`INSERT INTO fn13_ticket_meta(ticket_no,updated_at)
    VALUES(?,?) ON CONFLICT(ticket_no) DO NOTHING`).bind(ticketNo, now()).run();
}

async function routeChat(env, department) {
  const bound = await getDepartmentChat(env, department);
  if (bound?.chat_id) return bound.chat_id;
  const key = ENV_CHAT_KEYS[department] || 'SUPPORT_CHAT_ID';
  return env[key] || env.SUPPORT_CHAT_ID || null;
}

async function ticketFromGroupMessage(env, msg) {
  const replied = msg?.reply_to_message?.message_id;
  if (replied) {
    const b = await env.DB.prepare('SELECT ticket_no FROM fn11_bridge WHERE chat_id=? AND message_id=?')
      .bind(msg.chat.id, replied).first();
    if (b?.ticket_no) return getTicket(env, b.ticket_no);
    const legacy = await getTicketBySupportMessage(env, msg.chat.id, replied);
    if (legacy) return legacy;
  }

  const m = bodyOf(msg).match(/\b(FN-\d{6}-[A-Z0-9]{6})\b/i);
  if (m) return getTicket(env, m[1].toUpperCase());

  const compose = await env.DB.prepare(`SELECT ticket_no FROM fn11_operator_compose
    WHERE chat_id=? AND operator_id=? AND datetime(updated_at)>=datetime('now','-10 minutes')`)
    .bind(msg.chat.id, msg.from?.id || 0).first();
  if (compose?.ticket_no) return getTicket(env, compose.ticket_no);
  return null;
}

async function activeUserTicket(env, telegramId) {
  const live = await env.DB.prepare(`SELECT ticket_no FROM fn11_user_live
    WHERE telegram_id=? AND datetime(updated_at)>=datetime('now','-24 hours')`)
    .bind(telegramId).first();
  if (live?.ticket_no) {
    const t = await getTicket(env, live.ticket_no);
    if (t?.status === 'open') return t;
  }
  return env.DB.prepare(`SELECT * FROM fn5_tickets
    WHERE telegram_id=? AND status='open'
    ORDER BY id DESC LIMIT 1`).bind(telegramId).first();
}

function ticketShort(t, lang = 'uz') {
  const d = departmentMeta(t.department, lang);
  const c = categoryMeta(t.category, lang);
  const p = t.priority === 'critical' ? '🚨' : t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
  return `${p} <b>${escapeHtml(t.ticket_no)}</b> · ${d.icon} ${escapeHtml(d.title)}\n${c.icon} ${escapeHtml(c.title)} · ${STAGE_LABEL[t.stage] || escapeHtml(t.stage || '—')}${t.assigned_name ? `\n👨‍💻 ${escapeHtml(t.assigned_name)}` : ''}`;
}

async function showUserStatus(env, msg) {
  const u = await getUser(env, msg.from.id);
  const lang = u?.language || 'uz';
  const r = await env.DB.prepare(`SELECT * FROM fn5_tickets WHERE telegram_id=? AND status='open' ORDER BY id DESC LIMIT 8`)
    .bind(msg.from.id).all();
  const rows = r.results || [];
  if (!rows.length) {
    await sendMessage(env, msg.chat.id, L(lang,
      '✅ Hozir sizda ochiq murojaat yo‘q. Yangi murojaat uchun /start → Bo‘limlar.',
      '✅ Сейчас у вас нет открытых обращений. Для нового обращения: /start → Отделы.'));
    return true;
  }
  const body = rows.map(t => ticketShort(t, lang)).join('\n\n');
  await sendMessage(env, msg.chat.id, `${L(lang, '📂 <b>Ochiq murojaatlar</b>', '📂 <b>Открытые обращения</b>')}\n\n${body}`);
  return true;
}

async function showDashboard(env, msg) {
  const dep = await getDepartmentByChat(env, msg.chat.id);
  const department = dep?.department || null;
  const where = department ? ' AND department=?' : '';
  const bind = department ? [department] : [];
  const total = await env.DB.prepare(`SELECT
      COUNT(*) open_count,
      SUM(CASE WHEN assigned_to IS NULL THEN 1 ELSE 0 END) unassigned,
      SUM(CASE WHEN priority='critical' THEN 1 ELSE 0 END) critical,
      SUM(CASE WHEN priority='high' THEN 1 ELSE 0 END) high,
      SUM(CASE WHEN stage='waiting_customer' THEN 1 ELSE 0 END) waiting
    FROM fn5_tickets WHERE status='open'${where}`).bind(...bind).first();
  const overdue = await env.DB.prepare(`SELECT COUNT(*) n FROM fn5_tickets
    WHERE status='open' AND assigned_to IS NULL${where}
      AND ((priority='critical' AND datetime(created_at)<=datetime('now','-10 minutes'))
        OR (priority='high' AND datetime(created_at)<=datetime('now','-20 minutes'))
        OR (priority='normal' AND datetime(created_at)<=datetime('now','-45 minutes'))
        OR (priority='low' AND datetime(created_at)<=datetime('now','-90 minutes')))`)
    .bind(...bind).first();
  const agents = await env.DB.prepare(`SELECT COUNT(*) n FROM fn13_agents WHERE chat_id=? AND status='online'
    AND datetime(updated_at)>=datetime('now','-12 hours')`).bind(msg.chat.id).first();
  await sendMessage(env, msg.chat.id, [
    '📊 <b>FiberNet Support Control Center</b>',
    department ? `🏢 ${escapeHtml(departmentMeta(department, 'uz').title)}` : '🏢 Barcha bo‘limlar',
    '',
    `📥 Ochiq: <b>${total?.open_count || 0}</b>`,
    `⚪️ Qabul qilinmagan: <b>${total?.unassigned || 0}</b>`,
    `🚨 Critical: <b>${total?.critical || 0}</b>`,
    `🔴 High: <b>${total?.high || 0}</b>`,
    `⏳ Mijoz javobi: <b>${total?.waiting || 0}</b>`,
    `⏰ SLA o‘tgan: <b>${overdue?.n || 0}</b>`,
    `🟢 Online operator: <b>${agents?.n || 0}</b>`,
    '',
    '⚙️ /next · /my · /unassigned · /overdue · /agents'
  ].join('\n'));
  return true;
}

async function listTickets(env, msg, mode) {
  const dep = await getDepartmentByChat(env, msg.chat.id);
  const department = dep?.department || null;
  let sql = `SELECT * FROM fn5_tickets WHERE status='open'`;
  const args = [];
  if (department) { sql += ' AND department=?'; args.push(department); }
  if (mode === 'my') { sql += ' AND assigned_to=?'; args.push(msg.from.id); }
  if (mode === 'unassigned') sql += ' AND assigned_to IS NULL';
  if (mode === 'overdue') sql += ` AND assigned_to IS NULL AND (
    (priority='critical' AND datetime(created_at)<=datetime('now','-10 minutes')) OR
    (priority='high' AND datetime(created_at)<=datetime('now','-20 minutes')) OR
    (priority='normal' AND datetime(created_at)<=datetime('now','-45 minutes')) OR
    (priority='low' AND datetime(created_at)<=datetime('now','-90 minutes')))`;
  sql += ` ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, id ASC LIMIT 15`;
  const r = await env.DB.prepare(sql).bind(...args).all();
  const rows = r.results || [];
  const title = mode === 'my' ? '👨‍💻 Mening ticketlarim' : mode === 'overdue' ? '⏰ SLA o‘tgan' : '📥 Qabul qilinmagan';
  const body = rows.length ? rows.map(t => `${ticketShort(t)}\n🕒 ${minutesSince(t.created_at)} min`).join('\n\n') : '✅ Ticket yo‘q.';
  await sendMessage(env, msg.chat.id, `<b>${title}</b>\n\n${body}`);
  return true;
}

async function takeNext(env, msg) {
  const dep = await getDepartmentByChat(env, msg.chat.id);
  if (!dep?.department) {
    await sendMessage(env, msg.chat.id, '⚠️ Bu guruh bo‘limga ulanmagan. /setup orqali ulang.');
    return true;
  }
  const t = await env.DB.prepare(`SELECT * FROM fn5_tickets WHERE status='open' AND assigned_to IS NULL AND department=?
    ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,id ASC LIMIT 1`)
    .bind(dep.department).first();
  if (!t) {
    await sendMessage(env, msg.chat.id, '✅ Navbatda qabul qilinmagan ticket yo‘q.');
    return true;
  }
  const op = { id: msg.from.id, name: operatorName(msg.from) };
  const r = await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=?,assigned_name=?,stage='in_progress',updated_at=?
    WHERE ticket_no=? AND status='open' AND assigned_to IS NULL`).bind(op.id, op.name, now(), t.ticket_no).run();
  if ((r.meta?.changes || 0) === 0) return takeNext(env, msg);
  await ensureMeta(env, t.ticket_no);
  await env.DB.prepare(`INSERT INTO fn11_events(ticket_no,actor_type,actor_id,event,data) VALUES(?,?,?,?,?)`)
    .bind(t.ticket_no, 'operator', op.id, 'claimed_via_next', null).run();
  await sendMessage(env, msg.chat.id, `✅ <b>Sizga biriktirildi</b>\n\n${ticketShort({ ...t, assigned_name: op.name, stage: 'in_progress' })}`);
  const u = await getUser(env, t.telegram_id);
  try {
    await sendMessage(env, t.telegram_id, L(u?.language || 'uz',
      `👨‍💻 Operator murojaatingizni qabul qildi.\n🎫 <code>${escapeHtml(t.ticket_no)}</code>`,
      `👨‍💻 Оператор принял ваше обращение.\n🎫 <code>${escapeHtml(t.ticket_no)}</code>`));
  } catch {}
  return true;
}

async function setAgent(env, msg, status) {
  const name = operatorName(msg.from);
  await env.DB.prepare(`INSERT INTO fn13_agents(chat_id,operator_id,operator_name,status,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(chat_id,operator_id) DO UPDATE SET operator_name=excluded.operator_name,status=excluded.status,updated_at=excluded.updated_at`)
    .bind(msg.chat.id, msg.from.id, name, status, now()).run();
  await sendMessage(env, msg.chat.id, status === 'online' ? `🟢 <b>${escapeHtml(name)}</b> online` : `⚫️ <b>${escapeHtml(name)}</b> offline`);
  return true;
}

async function showAgents(env, msg) {
  const r = await env.DB.prepare(`SELECT * FROM fn13_agents WHERE chat_id=? ORDER BY status DESC,updated_at DESC LIMIT 30`)
    .bind(msg.chat.id).all();
  const rows = r.results || [];
  const body = rows.length ? rows.map(a => `${a.status === 'online' ? '🟢' : '⚫️'} ${escapeHtml(a.operator_name || String(a.operator_id))}`).join('\n') : 'Operator holatlari hali yo‘q.';
  await sendMessage(env, msg.chat.id, `👥 <b>Operatorlar</b>\n\n${body}\n\n/online · /offline`);
  return true;
}

async function addInternalNote(env, msg, note) {
  const t = await ticketFromGroupMessage(env, msg);
  if (!t) {
    await sendMessage(env, msg.chat.id, '⚠️ /note ni ticket yoki mijoz xabariga Reply qilib yuboring.');
    return true;
  }
  if (!note) {
    await sendMessage(env, msg.chat.id, '✍️ Masalan: <code>/note ONU LOS qizil, liniya tekshirilsin</code>');
    return true;
  }
  const name = operatorName(msg.from);
  await env.DB.prepare(`INSERT INTO fn13_internal_notes(ticket_no,operator_id,operator_name,note) VALUES(?,?,?,?)`)
    .bind(t.ticket_no, msg.from.id, name, note.slice(0,1800)).run();
  await env.DB.prepare(`INSERT INTO fn11_events(ticket_no,actor_type,actor_id,event,data) VALUES(?,?,?,?,?)`)
    .bind(t.ticket_no, 'operator', msg.from.id, 'internal_note', JSON.stringify({ note: note.slice(0,500) })).run();
  await sendMessage(env, msg.chat.id,
    `📝 <b>Ichki izoh saqlandi</b> · <code>${escapeHtml(t.ticket_no)}</code>\n${escapeHtml(note.slice(0,1200))}`,
    { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
  return true;
}

async function setPriority(env, msg, priority) {
  const t = await ticketFromGroupMessage(env, msg);
  if (!t) {
    await sendMessage(env, msg.chat.id, '⚠️ /priority ni ticketga Reply qilib yuboring.');
    return true;
  }
  const allowed = ['critical', 'high', 'normal', 'low'];
  if (!allowed.includes(priority)) {
    await sendMessage(env, msg.chat.id, '⚙️ <code>/priority critical|high|normal|low</code>');
    return true;
  }
  if (t.assigned_to && String(t.assigned_to) !== String(msg.from.id) && !isAdmin(env, msg.from.id)) {
    await sendMessage(env, msg.chat.id, '⛔ Ticket boshqa operatorga biriktirilgan.');
    return true;
  }
  await env.DB.prepare('UPDATE fn5_tickets SET priority=?,updated_at=? WHERE ticket_no=? AND status=\'open\'')
    .bind(priority, now(), t.ticket_no).run();
  await ensureMeta(env, t.ticket_no);
  await env.DB.prepare(`INSERT INTO fn11_events(ticket_no,actor_type,actor_id,event,data) VALUES(?,?,?,?,?)`)
    .bind(t.ticket_no, 'operator', msg.from.id, 'priority_changed', JSON.stringify({ priority })).run();
  await sendMessage(env, msg.chat.id, `✅ <code>${escapeHtml(t.ticket_no)}</code> priority → <b>${escapeHtml(priority.toUpperCase())}</b>`);
  return true;
}

async function releaseTicket(env, msg) {
  const t = await ticketFromGroupMessage(env, msg);
  if (!t) { await sendMessage(env, msg.chat.id, '⚠️ /release ni ticketga Reply qiling.'); return true; }
  if (t.assigned_to && String(t.assigned_to) !== String(msg.from.id) && !isAdmin(env, msg.from.id)) {
    await sendMessage(env, msg.chat.id, '⛔ Faqat ticket egasi yoki admin qayta navbatga qo‘ya oladi.');
    return true;
  }
  await env.DB.prepare(`UPDATE fn5_tickets SET assigned_to=NULL,assigned_name=NULL,stage='new',updated_at=? WHERE ticket_no=? AND status='open'`)
    .bind(now(), t.ticket_no).run();
  await env.DB.prepare(`INSERT INTO fn11_events(ticket_no,actor_type,actor_id,event,data) VALUES(?,?,?,?,?)`)
    .bind(t.ticket_no, 'operator', msg.from.id, 'released_to_queue', null).run();
  await sendMessage(env, msg.chat.id, `↩️ <code>${escapeHtml(t.ticket_no)}</code> qayta umumiy navbatga qo‘yildi.`);
  return true;
}

async function showTimeline(env, msg) {
  const t = await ticketFromGroupMessage(env, msg);
  if (!t) { await sendMessage(env, msg.chat.id, '⚠️ /timeline ni ticketga Reply qiling.'); return true; }
  const m = await env.DB.prepare(`SELECT sender_type,body,created_at FROM fn5_messages WHERE ticket_no=? ORDER BY id DESC LIMIT 8`)
    .bind(t.ticket_no).all();
  const n = await env.DB.prepare(`SELECT operator_name,note,created_at FROM fn13_internal_notes WHERE ticket_no=? ORDER BY id DESC LIMIT 5`)
    .bind(t.ticket_no).all();
  const messages = (m.results || []).reverse().map(x => `${x.sender_type === 'operator' ? '👨‍💻' : '👤'} ${escapeHtml((x.body || '[media]').slice(0,350))}`);
  const notes = (n.results || []).reverse().map(x => `📝 <i>${escapeHtml(x.operator_name || 'operator')}:</i> ${escapeHtml((x.note || '').slice(0,350))}`);
  await sendMessage(env, msg.chat.id, `🧾 <b>${escapeHtml(t.ticket_no)} timeline</b>\n\n${[...messages, ...notes].join('\n\n') || 'Tarix bo‘sh.'}`);
  return true;
}

async function proHelp(env, msg) {
  await sendMessage(env, msg.chat.id, [
    '🧠 <b>FiberNet Professional Helpdesk</b>',
    '',
    '/dashboard — support holati',
    '/next — navbatdagi ticketni olish',
    '/my — mening ticketlarim',
    '/unassigned — qabul qilinmaganlar',
    '/overdue — SLA o‘tganlar',
    '/online /offline — operator holati',
    '/agents — operatorlar',
    '',
    'Ticketga Reply qilib:',
    '<code>/note matn</code> — faqat operatorlar ko‘radigan izoh',
    '<code>/priority high</code> — priority o‘zgartirish',
    '/release — ticketni navbatga qaytarish',
    '/timeline — suhbat va ichki izohlar tarixi',
    '',
    '💬 Oddiy Reply, rasm, video, sticker, voice va fayllar mijozga yuboriladi.'
  ].join('\n'));
  return true;
}

export async function handleV13Command(env, update) {
  const msg = update?.message;
  if (!msg || msg.from?.is_bot) return false;
  const text = String(msg.text || '').trim();

  if (isPrivate(msg.chat) && /^\/(status|mystatus)(?:@\w+)?$/i.test(text)) {
    if (!await claimUpdate(env, update.update_id)) return true;
    return showUserStatus(env, msg);
  }

  if (!isGroup(msg.chat) || !text.startsWith('/')) return false;
  const professional = /^\/(dashboard|dash|next|my|unassigned|overdue|online|offline|agents|note|priority|release|timeline|prohelp)(?:@\w+)?(?:\s|$)/i;
  if (!professional.test(text)) return false;
  if (!await claimUpdate(env, update.update_id)) return true;
  await ensureV13Schema(env);

  if (/^\/(dashboard|dash)(?:@\w+)?$/i.test(text)) return showDashboard(env, msg);
  if (/^\/next(?:@\w+)?$/i.test(text)) return takeNext(env, msg);
  if (/^\/my(?:@\w+)?$/i.test(text)) return listTickets(env, msg, 'my');
  if (/^\/unassigned(?:@\w+)?$/i.test(text)) return listTickets(env, msg, 'unassigned');
  if (/^\/overdue(?:@\w+)?$/i.test(text)) return listTickets(env, msg, 'overdue');
  if (/^\/online(?:@\w+)?$/i.test(text)) return setAgent(env, msg, 'online');
  if (/^\/offline(?:@\w+)?$/i.test(text)) return setAgent(env, msg, 'offline');
  if (/^\/agents(?:@\w+)?$/i.test(text)) return showAgents(env, msg);
  if (/^\/prohelp(?:@\w+)?$/i.test(text)) return proHelp(env, msg);

  const note = text.match(/^\/note(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (note) return addInternalNote(env, msg, String(note[1] || '').trim());
  const priority = text.match(/^\/priority(?:@\w+)?(?:\s+(critical|high|normal|low))?$/i);
  if (priority) return setPriority(env, msg, String(priority[1] || '').toLowerCase());
  if (/^\/release(?:@\w+)?$/i.test(text)) return releaseTicket(env, msg);
  if (/^\/timeline(?:@\w+)?$/i.test(text)) return showTimeline(env, msg);
  return false;
}

export async function observeV13Activity(env, update) {
  const msg = update?.message;
  if (!msg || msg.from?.is_bot) return;
  await ensureV13Schema(env);
  try {
    if (isPrivate(msg.chat)) {
      const t = await activeUserTicket(env, msg.from.id);
      if (!t) return;
      await ensureMeta(env, t.ticket_no);
      await env.DB.prepare(`UPDATE fn13_ticket_meta SET last_customer_at=?,updated_at=? WHERE ticket_no=?`)
        .bind(now(), now(), t.ticket_no).run();
      return;
    }
    if (isGroup(msg.chat)) {
      const t = await ticketFromGroupMessage(env, msg);
      if (!t) return;
      await ensureMeta(env, t.ticket_no);
      await env.DB.prepare(`UPDATE fn13_ticket_meta SET
        first_operator_reply_at=COALESCE(first_operator_reply_at,?),last_operator_at=?,updated_at=? WHERE ticket_no=?`)
        .bind(now(), now(), now(), t.ticket_no).run();
    }
  } catch (e) {
    console.warn('v13 activity observation ignored', String(e));
  }
}

async function sendSlaAlerts(env) {
  const r = await env.DB.prepare(`SELECT t.*,m.last_sla_alert_at FROM fn5_tickets t
    LEFT JOIN fn13_ticket_meta m ON m.ticket_no=t.ticket_no
    WHERE t.status='open' AND t.assigned_to IS NULL
    ORDER BY t.id ASC LIMIT 100`).all();
  for (const t of r.results || []) {
    const age = minutesSince(t.created_at);
    const threshold = SLA_MINUTES[t.priority] ?? SLA_MINUTES.normal;
    if (age < threshold) continue;
    if (t.last_sla_alert_at && minutesSince(t.last_sla_alert_at) < Math.max(30, threshold)) continue;
    const chatId = await routeChat(env, t.department);
    if (!chatId) continue;
    try {
      await sendMessage(env, chatId,
        `⏰ <b>SLA ogohlantirish</b>\n${ticketShort(t)}\n🕒 <b>${age} min</b> qabul qilinmagan.\n\n👨‍💻 /next orqali navbatdagi ticketni oling.`);
      await ensureMeta(env, t.ticket_no);
      await env.DB.prepare('UPDATE fn13_ticket_meta SET last_sla_alert_at=?,updated_at=? WHERE ticket_no=?')
        .bind(now(), now(), t.ticket_no).run();
      if ((t.priority === 'critical' || t.priority === 'high') && age < threshold + 6) {
        const u = await getUser(env, t.telegram_id);
        await sendMessage(env, t.telegram_id, L(u?.language || 'uz',
          `⏳ <b>Murojaatingiz navbatda</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\nMurojaat ustuvor navbatga ko‘tarildi. Operator qabul qilishi bilan sizga xabar keladi.`,
          `⏳ <b>Ваше обращение в очереди</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\nОбращение повышено в приоритетной очереди. Мы сообщим, когда оператор его примет.`));
      }
    } catch (e) { console.warn('v13 SLA alert', String(e)); }
  }
}

async function remindWaitingCustomers(env) {
  const r = await env.DB.prepare(`SELECT t.*,m.last_waiting_reminder_at FROM fn5_tickets t
    LEFT JOIN fn13_ticket_meta m ON m.ticket_no=t.ticket_no
    WHERE t.status='open' AND t.stage='waiting_customer' AND datetime(t.updated_at)<=datetime('now','-2 hours')
    LIMIT 60`).all();
  for (const t of r.results || []) {
    if (t.last_waiting_reminder_at && minutesSince(t.last_waiting_reminder_at) < 360) continue;
    try {
      const u = await getUser(env, t.telegram_id);
      await sendMessage(env, t.telegram_id, L(u?.language || 'uz',
        `⏳ <b>Operator javobingizni kutmoqda</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\nAgar muammo davom etsa, shu botga oddiy xabar, rasm, video, voice yoki sticker yuboring.`,
        `⏳ <b>Оператор ждёт ваш ответ</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\nЕсли проблема осталась, отправьте сюда сообщение, фото, видео, голосовое или стикер.`));
      await ensureMeta(env, t.ticket_no);
      await env.DB.prepare('UPDATE fn13_ticket_meta SET last_waiting_reminder_at=?,updated_at=? WHERE ticket_no=?')
        .bind(now(), now(), t.ticket_no).run();
    } catch (e) { console.warn('v13 waiting reminder', String(e)); }
  }
}

async function staleOperatorAlerts(env) {
  const r = await env.DB.prepare(`SELECT t.*,m.last_stale_alert_at FROM fn5_tickets t
    LEFT JOIN fn13_ticket_meta m ON m.ticket_no=t.ticket_no
    WHERE t.status='open' AND t.stage='in_progress' AND t.assigned_to IS NOT NULL
      AND datetime(t.updated_at)<=datetime('now','-60 minutes') LIMIT 60`).all();
  for (const t of r.results || []) {
    if (t.last_stale_alert_at && minutesSince(t.last_stale_alert_at) < 120) continue;
    const chatId = await routeChat(env, t.department);
    if (!chatId) continue;
    try {
      await sendMessage(env, chatId,
        `🔔 <b>Ticket uzoq vaqt javobsiz</b>\n${ticketShort(t)}\n🕒 Oxirgi faollik: <b>${minutesSince(t.updated_at)} min</b> oldin.`);
      await ensureMeta(env, t.ticket_no);
      await env.DB.prepare('UPDATE fn13_ticket_meta SET last_stale_alert_at=?,updated_at=? WHERE ticket_no=?')
        .bind(now(), now(), t.ticket_no).run();
    } catch (e) { console.warn('v13 stale alert', String(e)); }
  }
}

async function autoCloseResolved(env) {
  const r = await env.DB.prepare(`SELECT * FROM fn5_tickets WHERE status='open' AND stage='resolved'
    AND datetime(updated_at)<=datetime('now','-24 hours') LIMIT 40`).all();
  for (const t of r.results || []) {
    try {
      const closed = await closeTicket(env, t.ticket_no);
      if (!closed) continue;
      await ensureMeta(env, t.ticket_no);
      await env.DB.prepare('UPDATE fn13_ticket_meta SET auto_closed_at=?,updated_at=? WHERE ticket_no=?')
        .bind(now(), now(), t.ticket_no).run();
      const u = await getUser(env, t.telegram_id);
      await sendMessage(env, t.telegram_id, L(u?.language || 'uz',
        `✅ <b>Murojaat avtomatik yopildi</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\n24 soat davomida qo‘shimcha muammo bo‘lmagani uchun ticket yopildi. Yangi muammo uchun /start.`,
        `✅ <b>Обращение автоматически закрыто</b>\n🎫 <code>${escapeHtml(t.ticket_no)}</code>\n\nЗа 24 часа новых сообщений не было. Для нового вопроса используйте /start.`));
      if (t.support_chat_id) {
        await sendMessage(env, t.support_chat_id, `🤖 <code>${escapeHtml(t.ticket_no)}</code> 24 soatdan keyin avtomatik yopildi.`);
      }
      if (t.support_chat_id && t.support_message_id) {
        try { await tg(env, 'editMessageReplyMarkup', { chat_id: t.support_chat_id, message_id: t.support_message_id, reply_markup: { inline_keyboard: [] } }); } catch {}
      }
    } catch (e) { console.warn('v13 auto close', String(e)); }
  }
}

export async function runV13Maintenance(env) {
  await ensureV13Schema(env);
  await sendSlaAlerts(env);
  await remindWaitingCustomers(env);
  await staleOperatorAlerts(env);
  await autoCloseResolved(env);
  await env.DB.prepare("DELETE FROM fn13_processed WHERE created_at<datetime('now','-7 day')").run();
  await env.DB.prepare("DELETE FROM fn13_agents WHERE status='offline' AND datetime(updated_at)<datetime('now','-30 day')").run();
}

export async function v13Health(env) {
  await ensureV13Schema(env);
  const s = await stats(env);
  const meta = await env.DB.prepare(`SELECT
    SUM(CASE WHEN first_operator_reply_at IS NOT NULL THEN 1 ELSE 0 END) tracked_replies,
    SUM(CASE WHEN auto_closed_at IS NOT NULL THEN 1 ELSE 0 END) auto_closed
    FROM fn13_ticket_meta`).first();
  return { ...s, pro_tracking: meta || {} };
}

export const __test = { SLA_MINUTES, minutesSince };
