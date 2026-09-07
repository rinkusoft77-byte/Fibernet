export async function upsertUser(env, from) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      updated_at = excluded.updated_at
  `).bind(from.id, from.username || null, from.first_name || null, from.last_name || null, now).run();
  return getUser(env, from.id);
}

export async function getUser(env, telegramId) {
  return env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first();
}

export async function setLanguage(env, telegramId, language) {
  await env.DB.prepare("UPDATE users SET language = ?, updated_at = ? WHERE telegram_id = ?")
    .bind(language, new Date().toISOString(), telegramId).run();
}

export async function setState(env, telegramId, state, data = null) {
  await env.DB.prepare("UPDATE users SET state = ?, state_data = ?, updated_at = ? WHERE telegram_id = ?")
    .bind(state, data ? JSON.stringify(data) : null, new Date().toISOString(), telegramId).run();
}

export async function clearState(env, telegramId) { return setState(env, telegramId, null, null); }
export function parseStateData(user) { try { return user?.state_data ? JSON.parse(user.state_data) : {}; } catch { return {}; } }
export async function savePhone(env, telegramId, phone) { await env.DB.prepare("UPDATE users SET phone = ?, updated_at = ? WHERE telegram_id = ?").bind(phone, new Date().toISOString(), telegramId).run(); }
export function newTicketNo() { const d=new Date(); const yy=String(d.getUTCFullYear()).slice(-2), mm=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0"), rand=crypto.randomUUID().replaceAll("-","").slice(0,6).toUpperCase(); return `FN-${yy}${mm}${dd}-${rand}`; }
export async function createTicket(env,ticket){const ticketNo=newTicketNo(),now=new Date().toISOString();await env.DB.prepare(`INSERT INTO tickets (ticket_no, telegram_id, category, description, account_login, address, phone, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).bind(ticketNo,ticket.telegramId,ticket.category,ticket.description,ticket.accountLogin||null,ticket.address||null,ticket.phone||null,ticket.priority||"normal",now,now).run();await addTicketMessage(env,ticketNo,"user",ticket.telegramId,ticket.description,null);return ticketNo;}
export async function addTicketMessage(env,ticketNo,senderType,senderId,body,telegramMessageId){await env.DB.prepare(`INSERT INTO ticket_messages (ticket_no, sender_type, sender_telegram_id, body, telegram_message_id) VALUES (?, ?, ?, ?, ?)` ).bind(ticketNo,senderType,senderId||null,body||null,telegramMessageId||null).run();}
export async function setSupportMessageId(env,ticketNo,messageId){await env.DB.prepare("UPDATE tickets SET support_message_id = ?, updated_at = ? WHERE ticket_no = ?").bind(messageId,new Date().toISOString(),ticketNo).run();}
export async function getTicket(env,ticketNo){return env.DB.prepare("SELECT * FROM tickets WHERE ticket_no = ?").bind(ticketNo).first();}
export async function getTicketBySupportMessage(env,messageId){return env.DB.prepare("SELECT * FROM tickets WHERE support_message_id = ?").bind(messageId).first();}
export async function listUserTickets(env,telegramId,limit=8){const r=await env.DB.prepare(`SELECT ticket_no, category, status, created_at, description FROM tickets WHERE telegram_id = ? ORDER BY id DESC LIMIT ?`).bind(telegramId,limit).all();return r.results||[];}
export async function listOpenTickets(env,limit=10){const r=await env.DB.prepare(`SELECT ticket_no, telegram_id, category, priority, created_at, description FROM tickets WHERE status = 'open' ORDER BY id DESC LIMIT ?`).bind(limit).all();return r.results||[];}
export async function closeTicket(env,ticketNo,closedBy){const now=new Date().toISOString();const r=await env.DB.prepare(`UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, updated_at = ? WHERE ticket_no = ? AND status = 'open'`).bind(now,closedBy||null,now,ticketNo).run();return (r.meta?.changes||0)>0;}
export async function ticketStats(env){const row=await env.DB.prepare(`SELECT SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_count, SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed_count, COUNT(*) AS total_count FROM tickets`).first();return row||{open_count:0,closed_count:0,total_count:0};}
export async function claimUpdate(env,updateId){try{await env.DB.prepare("INSERT INTO processed_updates (update_id) VALUES (?)").bind(updateId).run();return true;}catch(err){if(String(err).toLowerCase().includes("unique")||String(err).toLowerCase().includes("constraint"))return false;throw err;}}
export async function releaseUpdate(env,updateId){await env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?").bind(updateId).run();}
export async function cleanupProcessedUpdates(env){await env.DB.prepare("DELETE FROM processed_updates WHERE created_at < datetime('now','-7 day')").run();}
