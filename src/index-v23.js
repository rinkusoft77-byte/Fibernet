import v22 from './index-v22.js';
import { __test as v10Test } from './index-v10.js';
import {
  handleV23AdminUpdate, maintenanceGate, runV23Maintenance, v23Health
} from './v23-admin.js';

const VERSION = '23.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v22.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v22.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status:400 }); }

      try {
        if (await handleV23AdminUpdate(env, update)) return new Response('ok');
        if (await maintenanceGate(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v23 admin gateway error', {
          error:String(e), stack:e?.stack
        });
        return new Response('Retry', { status:500 });
      }

      return v22.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v22.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let admin = null;
        try { admin = await v23Health(env); }
        catch (e) { admin = { error:String(e) }; }
        return Response.json({
          ...data,
          admin_panel_version: VERSION,
          admin_policy: 'private-admin-ids-only-d1-control-plane',
          admin
        }, { status:response.status });
      } catch {
        return response;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v22.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v22.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(runV23Maintenance(env)
        .catch(e => console.error('v23 admin maintenance', String(e))));
    }
  }
};

export const __test = { version:VERSION };
