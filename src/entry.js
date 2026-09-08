import app from "./index.js";

async function fp(value) {
  if (value == null) return null;
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).slice(0, 6).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/debug/header") {
      const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const expected = env.TELEGRAM_WEBHOOK_SECRET;
      return Response.json({
        receivedPresent: received !== null,
        receivedLength: received === null ? null : received.length,
        receivedFingerprint: await fp(received),
        expectedPresent: !!expected,
        expectedLength: expected == null ? null : String(expected).length,
        expectedFingerprint: await fp(expected),
        strictEqual: received === expected
      }, { headers: { "cache-control": "no-store" } });
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return app.scheduled(controller, env, ctx);
  }
};
