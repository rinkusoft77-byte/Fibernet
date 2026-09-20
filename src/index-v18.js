import v17 from './index-v17.js';
import { __test as v10Test } from './index-v10.js';
import { handleV18Update, runV18Maintenance, v18Health } from './v18-profile.js';

const VERSION = '18.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v17.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v17.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status: 400 }); }

      try {
        if (await handleV18Update(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v18 profile gateway error', { error: String(e), stack: e?.stack });
        return new Response('Retry', { status: 500 });
      }

      return v17.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v17.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let profile = null;
        try { profile = await v18Health(env); } catch (e) { profile = { error: String(e) }; }
        return Response.json({
          ...data,
          profile_gateway_version: VERSION,
          profile_mode: 'optional-onboarding-admin-approval-approved-autofill',
          client_profiles: profile
        }, { status: response.status });
      } catch {
        return response;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v17.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v17.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(runV18Maintenance(env).catch(e => console.error('v18 maintenance', String(e))));
    }
  }
};

export const __test = { version: VERSION };
