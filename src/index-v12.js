import v11 from './index-v11.js';
import { __test as v10Test } from './index-v10.js';
import { cleanupV12Media, handleV12Media } from './v12-media.js';

const VERSION = '12.0.0';
const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      let expected;
      try { expected = await v10Test.derivedWebhookSecret(env); }
      catch { return v11.fetch(request, env, ctx); }
      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== expected) return v11.fetch(request, env, ctx);

      let update;
      try { update = await request.clone().json(); }
      catch { return new Response('Bad Request', { status: 400 }); }

      try {
        if (await handleV12Media(env, update)) return new Response('ok');
      } catch (e) {
        console.error('FiberNet v12 media gateway error', { error: String(e), stack: e?.stack });
        return new Response('Retry', { status: 500 });
      }
      return v11.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const response = await v11.fetch(request, env, ctx);
      try {
        const data = await response.clone().json();
        return Response.json({
          ...data,
          media_gateway_version: VERSION,
          media_mode: 'bidirectional-copyMessage',
          media_types: ['sticker','photo','video','video_note','animation','voice','audio','document']
        }, { status: response.status });
      } catch { return response; }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(`FiberNet Assistant v${VERSION} is running.`);
    }

    return v11.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await v11.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) ctx.waitUntil(cleanupV12Media(env).catch(e => console.error('v12 media cleanup', String(e))));
  }
};

export const __test = { version: VERSION };
