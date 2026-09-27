import v21 from './index-v21.js';
import { __test as v10Test } from './index-v10.js';
import {
  handleV22ContentUpdate, v22Health
} from './v22-content.js';

const VERSION = '22.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v21.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v21.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status: 400 }); }

      try {
        if (await handleV22ContentUpdate(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v22 premium content error', {
          error: String(e), stack: e?.stack
        });
        return new Response('Retry', { status: 500 });
      }

      return v21.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v21.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let content = null;
        try { content = await v22Health(env); }
        catch (e) { content = { error: String(e) }; }

        return Response.json({
          ...data,
          premium_content_version: VERSION,
          content_policy: 'official-fibernet-sources-premium-cards',
          content
        }, { status: response.status });
      } catch {
        return response;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v21.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return v21.scheduled(controller, env, ctx);
  }
};

export const __test = { version: VERSION };
