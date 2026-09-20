import v15 from './index-v15.js';
import { __test as v10Test } from './index-v10.js';
import { handleV16Update, runV16Maintenance, v16Health } from './v16-ux.js';

const VERSION = '16.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v15.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v15.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status: 400 }); }

      try {
        if (await handleV16Update(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v16 UX gateway error', { error: String(e), stack: e?.stack });
        return new Response('Retry', { status: 500 });
      }

      return v15.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v15.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let ux = null;
        try { ux = await v16Health(env); } catch (e) { ux = { error: String(e) }; }
        return Response.json({
          ...data,
          ux_gateway_version: VERSION,
          customer_journey: 'problem-first-progressive-profile-express-intake',
          operator_copilot: 'summary-ask-macros-internal-notes-repair-alerts',
          ux
        }, { status: response.status });
      } catch {
        return response;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v15.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v15.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(runV16Maintenance(env).catch(e => console.error('v16 maintenance', String(e))));
    }
  }
};

export const __test = { version: VERSION };
