import v14 from './index-v14.js';
import { __test as v10Test } from './index-v10.js';
import {
  handleV15Update, observeV15After, runV15Maintenance, v15Health
} from './v15-helpdesk.js';

const VERSION = '15.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v14.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v14.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status: 400 }); }

      try {
        if (await handleV15Update(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v15 helpdesk gateway error', { error: String(e), stack: e?.stack });
        return new Response('Retry', { status: 500 });
      }

      const response = await v14.fetch(request, env, ctx);
      if (response.status < 500 && ctx?.waitUntil) {
        ctx.waitUntil(observeV15After(env, update).catch(e => console.warn('v15 observe', String(e))));
      }
      return response;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v14.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let helpdesk = null;
        try { helpdesk = await v15Health(env); } catch (e) { helpdesk = { error: String(e) }; }
        return Response.json({
          ...data,
          enterprise_gateway_version: VERSION,
          enterprise_helpdesk: helpdesk,
          operator_commands_v15: [
            '/agent', '/available', '/away', '/skills', '/capacity',
            '/smartnext', '/macros', '/v15help',
            'topic: /claim /release /resolve /close /note /priority /use /topichelp'
          ]
        }, { status: response.status });
      } catch {
        return response;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v14.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v14.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(runV15Maintenance(env).catch(e => console.error('v15 maintenance', String(e))));
    }
  }
};

export const __test = { version: VERSION };
