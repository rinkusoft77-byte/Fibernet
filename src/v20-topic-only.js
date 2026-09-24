import { getTicket } from './v5-db.js';
import { ensureTopicForTicket } from './v15-helpdesk.js';
import { tg } from './telegram.js';

export async function runV20Maintenance(env) {
  // Every open customer ticket must live in a dedicated forum topic.
  const rows = await env.DB.prepare(`SELECT t.ticket_no,t.support_chat_id,t.support_message_id,
      p.thread_id,p.state,p.updated_at AS topic_updated_at
    FROM fn5_tickets t
    LEFT JOIN fn15_topics p ON p.ticket_no=t.ticket_no
    WHERE t.status='open'
    ORDER BY t.id DESC LIMIT 80`).all();

  for (const row of rows.results || []) {
    let topic = row.thread_id && row.state === 'open' ? row : null;

    if (!topic) {
      // Retry unsupported topic creation after a short cooldown instead of
      // ever falling back to the group's main chat.
      if (row.state === 'unsupported' && row.topic_updated_at) {
        const age = Date.now() - new Date(row.topic_updated_at).getTime();
        if (Number.isFinite(age) && age >= 30 * 60 * 1000) {
          try { await env.DB.prepare('DELETE FROM fn15_topics WHERE ticket_no=?').bind(row.ticket_no).run(); } catch {}
        } else {
          continue;
        }
      }
      try {
        topic = await ensureTopicForTicket(env, row.ticket_no);
      } catch (e) {
        console.warn('v20 topic retry', row.ticket_no, String(e));
        continue;
      }
    }

    if (!topic?.thread_id) continue;

    // If an older version posted the ticket card in the main group, remove it
    // after the dedicated topic exists. New versions never create such cards.
    if (row.support_message_id && row.support_chat_id) {
      try {
        await tg(env, 'deleteMessage', {
          chat_id: row.support_chat_id,
          message_id: row.support_message_id
        });
      } catch {}
    }

    try {
      await env.DB.prepare(`UPDATE fn5_tickets
        SET support_chat_id=?,support_message_id=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE ticket_no=?`).bind(topic.chat_id, row.ticket_no).run();
    } catch {}
  }

  // Legacy delivery queue must not re-post tickets to the main group.
  try {
    await env.DB.prepare(`DELETE FROM fn5_delivery
      WHERE ticket_no IN (
        SELECT ticket_no FROM fn5_tickets WHERE status!='open'
        UNION
        SELECT ticket_no FROM fn15_topics WHERE state='open' AND thread_id IS NOT NULL
      )`).run();
  } catch {}
}

export async function v20Health(env) {
  let row = { total:0, topic_ready:0, topic_pending:0 };
  try {
    row = await env.DB.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN p.state='open' AND p.thread_id IS NOT NULL THEN 1 ELSE 0 END) topic_ready,
      SUM(CASE WHEN p.thread_id IS NULL OR p.state!='open' OR p.state IS NULL THEN 1 ELSE 0 END) topic_pending
      FROM fn5_tickets t
      LEFT JOIN fn15_topics p ON p.ticket_no=t.ticket_no
      WHERE t.status='open'`).first() || row;
  } catch {}
  return {
    mode: 'strict-topic-only-customer-conversations',
    open_tickets: Number(row.total || 0),
    topic_ready: Number(row.topic_ready || 0),
    topic_pending: Number(row.topic_pending || 0),
    main_chat_ticket_delivery: false,
    repeated_stale_alerts: false
  };
}

export const __test = {
  TOPIC_POLICY: 'strict-topic-only-customer-conversations'
};
