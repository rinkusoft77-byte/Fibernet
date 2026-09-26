import v20 from './index-v20.js';
import { __test as v10Test } from './index-v10.js';
import {
  handleV21Update, runV21Maintenance, v21Health
} from './v21-conversation.js';

const VERSION = '21.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v20.fetch(request, env, ctx); }

      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v20.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status:400 }); }

      try {
        if (await handleV21Update(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v21 conversation gateway error', {
          error:String(e), stack:e?.stack
        });
        return new Response('Retry', { status:500 });
      }

      return v20.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v20.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        let conversation = null;
        try { conversation = await v21Health(env); }
        catch (e) { conversation = { error:String(e) }; }
        return Response.json({
          ...data,
          support_chat_version: VERSION,
          support_chat_policy: 'ticket-topic-live-chat-5-15m-no-main-chat',
          support_chat: conversation
        }, { status:response.status });
      } catch {
        return response;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v20.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v20.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(runV21Maintenance(env)
        .catch(e => console.error('v21 conversation maintenance', String(e))));
    }
  }
};

export const __test = { version:VERSION };
