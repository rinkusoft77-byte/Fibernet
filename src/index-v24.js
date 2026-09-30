import v23 from './index-v23.js';
import {
  safeEqual, secureWebhook, runV24Maintenance, v24Health
} from './v24-security.js';

const VERSION = '24.0.0';
const HEADERS = {
  'cache-control':'no-store',
  'x-content-type-options':'nosniff'
};

function response(body, status = 200) {
  return new Response(body, { status, headers:HEADERS });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/telegram/webhook') {
      if (request.method !== 'POST') return response('Method Not Allowed',405);
      return secureWebhook(request, env, ctx, v23.fetch.bind(v23));
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return response(`FiberNet Assistant v${VERSION} is running.`);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      if (url.searchParams.get('details') === '1') {
        const token = String(env.ADMIN_API_TOKEN || '');
        const provided = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i,'');
        if (!token || !safeEqual(token,provided)) return response('Forbidden',403);
        const detail = await v23.fetch(request, env, ctx);
        try {
          const data = await detail.json();
          return Response.json({
            ...data,
            security_gateway_version:VERSION,
            security:await v24Health(env)
          },{status:detail.status,headers:HEADERS});
        } catch { return response('Health unavailable',503); }
      }
      try {
        await env.DB.prepare('SELECT 1').first();
        return Response.json({ok:true,service:'fibernet-bot',version:VERSION},
          {headers:HEADERS});
      } catch {
        return Response.json({ok:false,service:'fibernet-bot',version:VERSION},
          {status:503,headers:HEADERS});
      }
    }

    return response('Not Found',404);
  },

  async scheduled(controller, env, ctx) {
    await v23.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(runV24Maintenance(env).catch(e =>
        console.error('v24 maintenance',e?.name||'Error')));
    }
  }
};

export const __test = { version:VERSION };
