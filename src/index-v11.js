import v10, { __test as v10Test } from './index-v10.js';
import { handleV11Update, runV11Maintenance } from './v11-support.js';

const VERSION = '11.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v10.fetch(request, env, ctx); }
      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v10.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status: 400 }); }

      try {
        if (await handleV11Update(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v11 operator gateway error', { error: String(e), stack: e?.stack });
        return new Response('Retry', { status: 500 });
      }
      return v10.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v10.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        return Response.json({
          ...data,
          operator_gateway_version: VERSION,
          operator_mode: 'thread-bridge-claim-transfer-sla'
        }, { status: response.status });
      } catch { return response; }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v10.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v10.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) ctx.waitUntil(runV11Maintenance(env).catch(e => console.error('v11 maintenance', String(e))));
  }
};

export const __test = { version: VERSION };
