import v9 from './index-v9.js';
import { clearSession, ensureV5Schema, upsertUser } from './v5-db.js';
import { claimV7Update, releaseV7Update } from './v7-routing.js';
import { languageKeyboard } from './v8-ui.js';
import { sendMessage, tg } from './telegram.js';

const VERSION = '10.1.0';
const WEBHOOK_PATH = '/telegram/webhook';

async function derivedWebhookSecret(env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const bytes = new TextEncoder().encode(`fibernet-webhook:${token}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

function webhookUrl(env) {
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('PUBLIC_BASE_URL is missing');
  return `${base}${WEBHOOK_PATH}`;
}

async function ensureCurrentWebhook(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.PUBLIC_BASE_URL) return false;
  const secret = await derivedWebhookSecret(env);
  await tg(env, 'setWebhook', {
    url: webhookUrl(env),
    secret_token: secret,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    drop_pending_updates: false
  });
  return true;
}

function delegateWithLegacySecret(request, env) {
  const headers = new Headers(request.headers);
  // v9/v8 still use the legacy internal secret check. v10 validates Telegram with
  // the token-derived secret first, then rewrites only the internal delegate.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    headers.set('X-Telegram-Bot-Api-Secret-Token', env.TELEGRAM_WEBHOOK_SECRET);
  }
  return new Request(request, { headers });
}

function isStartCommand(update) {
  const msg = update?.message;
  if (!msg || msg.chat?.type !== 'private') return false;
  return /^\/start(?:@\w+)?(?:\s|$)/i.test(String(msg.text || '').trim());
}

async function forceLanguageChoice(env, update) {
  const msg = update.message;
  await ensureV5Schema(env);
  if (!await claimV7Update(env, update.update_id)) return;
  try {
    const user = await upsertUser(env, msg.from);
    await clearSession(env, user.telegram_id);
    await sendMessage(
      env,
      msg.chat.id,
      '🌐 <b>Tilni tanlang / Выберите язык</b>\n\n🇺🇿 O‘zbek tilini tanlang yoki 🇷🇺 Русский язык.',
      { reply_markup: languageKeyboard() }
    );
  } catch (e) {
    await releaseV7Update(env, update.update_id);
    throw e;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await derivedWebhookSecret(env); }
      catch (e) { return new Response(String(e), { status: 503 }); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) {
        // If the token was just changed, an old bot may still be calling this URL.
        // Reject that update and self-heal the webhook for the CURRENT token.
        if (ctx?.waitUntil) ctx.waitUntil(ensureCurrentWebhook(env).catch(e => console.error('webhook self-heal', String(e))));
        return new Response('Unauthorized', { status: 401 });
      }

      const delegate = request.clone();
      try {
        const update = await request.json();
        if (Number.isInteger(update?.update_id) && isStartCommand(update)) {
          await forceLanguageChoice(env, update);
          return new Response('ok');
        }
      } catch (e) {
        console.error('v10 start interceptor', String(e));
      }

      return v9.fetch(delegateWithLegacySecret(delegate, env), env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      if (ctx?.waitUntil) ctx.waitUntil(ensureCurrentWebhook(env).catch(e => console.error('webhook health self-heal', String(e))));
      const response = await v9.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        return Response.json({ ...data, gateway_version: VERSION, webhook_mode: 'auto-token-bound', start_language_required: true }, { status: response.status });
      } catch {
        return response;
      }
    }

    return v9.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    // Every scheduled run re-applies the webhook for the CURRENT bot token.
    // Changing TELEGRAM_BOT_TOKEN in Cloudflare is therefore enough; no manual
    // setWebhook command is needed. Old bot webhooks are rejected because their
    // secret no longer matches the token-derived secret.
    if (ctx?.waitUntil) ctx.waitUntil(ensureCurrentWebhook(env).catch(e => console.error('automatic webhook sync', String(e))));
    return v9.scheduled(controller, env, ctx);
  }
};

export const __test = { derivedWebhookSecret, webhookUrl, isStartCommand };
