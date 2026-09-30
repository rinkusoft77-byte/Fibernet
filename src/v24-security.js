import { __test as webhook } from './index-v10.js';
import { isBotAdmin } from './v23-admin.js';

const MAX_WEBHOOK_BYTES = 512 * 1024;
const RATE_WINDOW_SECONDS = 10;
const RATE_MAX_UPDATES = 30;
let ready = false;

function reply(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (!left || !right || left.length > 256 || right.length > 256) return false;
  let difference = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i++) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}

export function isValidUpdate(update) {
  return !!update && typeof update === 'object' && !Array.isArray(update) &&
    Number.isSafeInteger(update.update_id) && update.update_id >= 0;
}

export function updateActor(update) {
  const q = update?.callback_query;
  const msg = update?.message || update?.edited_message;
  const member = update?.my_chat_member;
  const from = q?.from || msg?.from || member?.from;
  const chat = q?.message?.chat || msg?.chat || member?.chat;
  if (!from?.id || !chat?.id || from.is_bot) return null;
  return { id: String(from.id), chatType: chat.type };
}

export async function ensureV24Schema(env) {
  if (ready) return;
  const sql = [
    `CREATE TABLE IF NOT EXISTS fn24_updates (
      update_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      locked_until TEXT,
      last_status INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn24_updates_cleanup ON fn24_updates(status,updated_at)`,
    `CREATE TABLE IF NOT EXISTS fn24_rate (
      subject TEXT PRIMARY KEY,
      window_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      hits INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fn24_rate_window ON fn24_rate(window_at)`
  ];
  for (const sqlLine of sql) await env.DB.prepare(sqlLine).run();
  ready = true;
}

async function claimUpdate(env, updateId) {
  await ensureV24Schema(env);
  const result = await env.DB.prepare(`INSERT INTO fn24_updates(
      update_id,status,attempts,locked_until,updated_at
    ) VALUES(?,'processing',1,datetime('now','+2 minutes'),CURRENT_TIMESTAMP)
    ON CONFLICT(update_id) DO UPDATE SET
      status='processing',
      attempts=fn24_updates.attempts+1,
      locked_until=datetime('now','+2 minutes'),
      updated_at=CURRENT_TIMESTAMP
    WHERE fn24_updates.status='retry'
       OR (fn24_updates.status='processing' AND datetime(fn24_updates.locked_until)<datetime('now'))`)
    .bind(updateId).run();
  if (Number(result.meta?.changes || 0) > 0) return 'claimed';
  const row = await env.DB.prepare('SELECT status FROM fn24_updates WHERE update_id=?')
    .bind(updateId).first();
  return row?.status === 'done' ? 'done' : 'busy';
}

async function finishUpdate(env, updateId, statusCode) {
  await env.DB.prepare(`UPDATE fn24_updates SET status='done',
    last_status=?,locked_until=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE update_id=? AND status='processing'`).bind(statusCode, updateId).run();
}

async function releaseUpdate(env, updateId, statusCode = 500) {
  await env.DB.prepare(`UPDATE fn24_updates SET status='retry',
    last_status=?,locked_until=datetime('now','-1 seconds'),updated_at=CURRENT_TIMESTAMP
    WHERE update_id=? AND status='processing'`).bind(statusCode, updateId).run();
}

async function rateLimited(env, update) {
  const actor = updateActor(update);
  if (!actor || actor.chatType !== 'private' || isBotAdmin(env, actor.id)) return false;
  const key = 'private:' + actor.id;
  await env.DB.prepare(`INSERT INTO fn24_rate(subject,window_at,hits)
    VALUES(?,CURRENT_TIMESTAMP,1)
    ON CONFLICT(subject) DO UPDATE SET
      hits=CASE WHEN datetime(fn24_rate.window_at)<=datetime('now','-10 seconds')
        THEN 1 ELSE fn24_rate.hits+1 END,
      window_at=CASE WHEN datetime(fn24_rate.window_at)<=datetime('now','-10 seconds')
        THEN CURRENT_TIMESTAMP ELSE fn24_rate.window_at END`).bind(key).run();
  const row = await env.DB.prepare('SELECT hits FROM fn24_rate WHERE subject=?').bind(key).first();
  return Number(row?.hits || 0) > RATE_MAX_UPDATES;
}

async function readBoundedBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > MAX_WEBHOOK_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_WEBHOOK_BYTES) return null;
  return text;
}

export async function secureWebhook(request, env, ctx, delegate) {
  let expected;
  try {
    expected = await webhook.derivedWebhookSecret(env);
  } catch {
    // Fail closed: never delegate to a legacy webhook when secrets are missing.
    return reply('Service Unavailable', 503);
  }
  if (!safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), expected)) {
    return reply('Forbidden', 403);
  }
  if (!String(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    return reply('JSON required', 415);
  }

  let body, update;
  try {
    body = await readBoundedBody(request);
    if (body === null) return reply('Payload too large', 413);
    update = JSON.parse(body);
  } catch {
    return reply('Bad Request', 400);
  }
  if (!isValidUpdate(update)) return reply('Invalid update', 400);

  let claimed = false;
  try {
    const claim = await claimUpdate(env, update.update_id);
    if (claim === 'done') return reply('ok');
    if (claim === 'busy') return reply('Retry', 503);
    claimed = true;

    if (await rateLimited(env, update)) {
      await finishUpdate(env, update.update_id, 200);
      return reply('ok');
    }

    const delegated = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body
    });
    const response = await delegate(delegated, env, ctx);
    if (response.status >= 500) {
      await releaseUpdate(env, update.update_id, response.status);
    } else {
      await finishUpdate(env, update.update_id, response.status);
    }
    return response;
  } catch (error) {
    if (claimed) {
      try { await releaseUpdate(env, update.update_id); } catch {}
    }
    console.error('v24 webhook processing failed', {
      update_id: update.update_id,
      error_type: error?.name || 'Error'
    });
    return reply('Retry', 503);
  }
}

export async function runV24Maintenance(env) {
  await ensureV24Schema(env);
  await env.DB.prepare(`DELETE FROM fn24_updates
    WHERE status='done' AND datetime(updated_at)<datetime('now','-14 days')`).run();
  await env.DB.prepare(`DELETE FROM fn24_rate
    WHERE datetime(window_at)<datetime('now','-1 day')`).run();
}

export async function v24Health(env) {
  await ensureV24Schema(env);
  const row = await env.DB.prepare(`SELECT
    SUM(CASE WHEN status='retry' THEN 1 ELSE 0 END) retry,
    SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) processing
    FROM fn24_updates`).first();
  return {
    ingress:'authenticated-size-limited-idempotent-rate-limited',
    retries:Number(row?.retry || 0),
    processing:Number(row?.processing || 0)
  };
}

export const __test = { MAX_WEBHOOK_BYTES, RATE_MAX_UPDATES, RATE_WINDOW_SECONDS };
