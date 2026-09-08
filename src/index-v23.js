import app from "./index-v21.js";
import { getUser, parseStateData, setState } from "./db.js";

const VERSION = "2.3.0";
const DESCRIPTION_STATES = new Set(["ticket_description", "dept_description"]);

async function ensurePendingTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS pending_flows (
      telegram_id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      state_data TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function getPending(env, telegramId) {
  await ensurePendingTable(env);
  return env.DB.prepare("SELECT telegram_id, state, state_data, updated_at FROM pending_flows WHERE telegram_id = ?")
    .bind(telegramId).first();
}

async function savePending(env, telegramId, state, data) {
  await ensurePendingTable(env);
  await env.DB.prepare(`
    INSERT INTO pending_flows (telegram_id, state, state_data, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      state = excluded.state,
      state_data = excluded.state_data,
      updated_at = CURRENT_TIMESTAMP
  `).bind(telegramId, state, data ? JSON.stringify(data) : null).run();
}

async function deletePending(env, telegramId) {
  await ensurePendingTable(env);
  await env.DB.prepare("DELETE FROM pending_flows WHERE telegram_id = ?").bind(telegramId).run();
}

function parsePendingData(row) {
  try { return row?.state_data ? JSON.parse(row.state_data) : {}; }
  catch { return {}; }
}

async function repairPendingState(env, telegramId, currentUser) {
  const pending = await getPending(env, telegramId);
  if (!pending) return null;

  const ageMs = Date.now() - Date.parse(pending.updated_at || 0);
  if (!Number.isFinite(ageMs) || ageMs > 15 * 60 * 1000) {
    await deletePending(env, telegramId);
    return null;
  }

  if (!DESCRIPTION_STATES.has(currentUser?.state) && DESCRIPTION_STATES.has(pending.state)) {
    await setState(env, telegramId, pending.state, parsePendingData(pending));
  }
  return pending;
}

async function processWebhook(request, env, ctx) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;
  try { update = await request.clone().json(); }
  catch { return app.fetch(request, env, ctx); }

  const msg = update?.message;
  const telegramId = msg?.from?.id;
  const isPrivate = msg?.chat?.type === "private";

  if (!isPrivate || !telegramId) return app.fetch(request, env, ctx);

  let before = await getUser(env, telegramId);
  const pending = await repairPendingState(env, telegramId, before);
  if (pending) before = await getUser(env, telegramId);

  const response = await app.fetch(request, env, ctx);

  const after = await getUser(env, telegramId);
  if (DESCRIPTION_STATES.has(after?.state)) {
    await savePending(env, telegramId, after.state, parseStateData(after));
  } else if (pending) {
    await deletePending(env, telegramId);
  }

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return processWebhook(request, env, ctx);
    }
    if (url.pathname === "/") return new Response(`FiberNet Support Bot v${VERSION} is running.`);
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return app.scheduled(controller, env, ctx);
  }
};
