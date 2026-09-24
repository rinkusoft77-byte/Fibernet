import v19 from './index-v19.js';
import { __test as v10Test } from './index-v10.js';
import { runV20Maintenance, v20Health } from './v20-topic-only.js';

const VERSION = '20.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v19.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v19.fetch(request, env, ctx);

      return v19.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v19.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let topicOnly = null;
        try { topicOnly = await v20Health(env); } catch (e) { topicOnly = { error:String(e) }; }
        return Response.json({
          ...data,
          conversation_gateway_version: VERSION,
          conversation_policy: 'one-ticket-one-topic-main-chat-clean',
          topic_only: topicOnly
        }, { status:response.status });
      } catch {
        return response;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v19.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v19.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(runV20Maintenance(env).catch(e => console.error('v20 topic-only maintenance', String(e))));
    }
  }
};

export const __test = { version:VERSION };
