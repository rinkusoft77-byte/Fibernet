const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const base = process.env.PUBLIC_BASE_URL;

if (!token || !secret || !base) {
  console.error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_BASE_URL first.");
  process.exit(1);
}

if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET may contain only A-Z, a-z, 0-9, _ and - (1-256 chars).");
  process.exit(1);
}

const webhookUrl = `${base.replace(/\/$/, "")}/telegram/webhook`;
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  })
});

const data = await response.json();
console.log(JSON.stringify({ webhookUrl, ...data }, null, 2));
if (!data.ok) process.exit(1);
