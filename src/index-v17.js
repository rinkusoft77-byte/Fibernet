import v16 from './index-v16.js';
import { __test as v10Test } from './index-v10.js';
import { handleV17Update, runV17Maintenance, v17Health } from './v17-operator.js';

const VERSION = '17.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v16.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v16.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status: 400 }); }

      try {
        if (await handleV17Update(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v17 operator gateway error', { error: String(e), stack: e?.stack });
        return new Response('Retry', { status: 500 });
      }

      return v16.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v16.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let operator = null;
        try { operator = await v17Health(env); } catch (e) { operator = { error: String(e) }; }
        return Response.json({
          ...data,
          operator_workspace_version: VERSION,
          operator_workspace: operator,
          operator_mode: 'topic-owner-live-reply-collaboration-drafts-assignment-snooze-sla-search'
        }, { status: response.status });
      } catch {
        return response;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v16.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v16.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(runV17Maintenance(env).catch(e => console.error('v17 maintenance', String(e))));
    }
  }
};

export const __test = { version: VERSION };
