import v18 from './index-v18.js';
import { __test as v10Test } from './index-v10.js';
import {
  handleV19GroupGuard, runV19Maintenance, v19Health
} from './v19-group-guard.js';

const VERSION = '19.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v18.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v18.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status: 400 }); }

      try {
        if (await handleV19GroupGuard(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v19 group guard error', { error:String(e), stack:e?.stack });
        return new Response('Retry', { status:500 });
      }

      return v18.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v18.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let guard = null;
        try { guard = await v19Health(env); } catch (e) { guard = { error:String(e) }; }
        return Response.json({
          ...data,
          group_guard_version: VERSION,
          group_guard: guard,
          group_invariant: 'only-approved-operators-can-touch-customer-tickets'
        }, { status:response.status });
      } catch {
        return response;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v18.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v18.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(runV19Maintenance(env).catch(e => console.error('v19 maintenance', String(e))));
    }
  }
};

export const __test = { version:VERSION };
