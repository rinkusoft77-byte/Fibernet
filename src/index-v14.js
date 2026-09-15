import v13 from './index-v13.js';
import { __test as v10Test } from './index-v10.js';
import { ensureV14Schema, handleV14Access, v14Health } from './v14-access.js';

const VERSION = '14.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v13.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v13.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status: 400 }); }

      try {
        if (await handleV14Access(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v14 access gateway error', { error: String(e), stack: e?.stack });
        return new Response('Retry', { status: 500 });
      }

      return v13.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v13.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let access = null;
        try { access = await v14Health(env); } catch (e) { access = { error: String(e) }; }
        return Response.json({
          ...data,
          access_gateway_version: VERSION,
          access_mode: 'ethernet-gpon-onu-aware',
          access
        }, { status: response.status });
      } catch { return response; }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v13.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v13.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) ctx.waitUntil(ensureV14Schema(env).catch(e => console.error('v14 schema', String(e))));
  }
};

export const __test = { version: VERSION };
