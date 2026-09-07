# FiberNet Support Bot

Professional Telegram technical-support bot for **FiberNet / NET TELEVISION**, designed for **Cloudflare Workers + D1** and Telegram webhooks.

## What is included

- Uzbek and Russian UI.
- Guided diagnostics: no internet, low speed, Wi‑Fi, IPTV/TV, billing/cabinet, other issues.
- Support ticket workflow with subscriber login, address, phone and description.
- New-connection request workflow.
- Telegram operator group integration:
  - every ticket is posted to the support group;
  - operator can **Reply** to the ticket message and the reply is relayed to the subscriber;
  - `/reply FN-... message`, `/close FN-...`, `/tickets`, `/stats`, `/sync` commands;
  - inline **Close ticket** button.
- D1 persistence for users, tickets, messages, source cache and deduplication.
- Official FiberNet data synchronization once per day from `fibernet.uz`.
- Dynamic parsing of TEZKOR and OnLine tariff pages, with safe fallback tariff data.
- `/health` endpoint and protected `/admin/sync` endpoint.
- Telegram webhook validation with `secret_token`.
- No subscriber passwords are requested or stored.

## Official information sources

The bot uses only official FiberNet resources for the provider-facing information:

- `https://www.fibernet.uz/language/uz/uz/`
- `https://www.fibernet.uz/language/uz/tariflar/`
- `https://www.fibernet.uz/language/uz/tariflar/7945-2/`
- `https://www.fibernet.uz/language/uz/tariflar/online-new/`
- `https://www.fibernet.uz/language/uz/savol-va-javoblar/`
- `https://www.fibernet.uz/language/uz/sozlamalar/`
- `https://www.fibernet.uz/language/uz/tezlik-sinovi/`
- `https://www.fibernet.uz/language/uz/dop_uslugi_uz/`
- `https://www.fibernet.uz/language/uz/aloqa-uchun/`
- `https://www.fibernet.uz/contacts/`
- `https://cabinet.fibernet.uz/`

> Note: Uzbek and Russian contact pages currently expose different extension numbers. The bot therefore publishes the verified main number `+998 71 200-47-47` and the official email addresses instead of hard-coding a potentially wrong extension.

## Cloudflare deployment

### 1. Install

```bash
npm install
```

### 2. Create D1 database

```bash
npx wrangler login
npx wrangler d1 create fibernet-support
```

Copy the returned database UUID into `wrangler.jsonc`:

```json
"database_id": "YOUR_D1_DATABASE_ID"
```

### 3. Apply migrations

```bash
npm run db:migrate:remote
```

### 4. Configure Worker variables

In `wrangler.jsonc` replace:

- `PUBLIC_BASE_URL`
- `SUPPORT_CHAT_ID`
- optionally `ADMIN_IDS` as comma-separated Telegram user IDs.

`SUPPORT_CHAT_ID` is normally a negative group/supergroup ID, for example `-1001234567890`.

### 5. Configure secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_API_TOKEN
```

`TELEGRAM_WEBHOOK_SECRET` must contain only `A-Z`, `a-z`, `0-9`, `_` and `-`.

Generate secrets locally, for example:

```bash
openssl rand -hex 32
```

### 6. Deploy

```bash
npm run deploy
```

After deploy, set `PUBLIC_BASE_URL` to the final Worker/custom-domain URL and deploy once more if needed.

### 7. Register Telegram webhook

On your local machine:

```bash
export TELEGRAM_BOT_TOKEN='...'
export TELEGRAM_WEBHOOK_SECRET='...'
export PUBLIC_BASE_URL='https://your-worker.example.com'
npm run webhook
```

Telegram will send updates to:

```text
POST /telegram/webhook
```

### 8. Add the bot to the operator group

1. Add the Telegram bot to the FiberNet support group.
2. Give it permission to read/send messages as needed.
3. Put that group's ID into `SUPPORT_CHAT_ID`.
4. Deploy again.

Operators can now reply directly to a ticket message.

## Cloudflare Cron

`wrangler.jsonc` runs sync at:

```text
15 23 * * *
```

Cloudflare Cron uses UTC. This is 04:15 in Uzbekistan (UTC+5). The job refreshes official FiberNet pages and removes old Telegram update-deduplication rows.

## Endpoints

- `GET /` — service marker.
- `GET /health` — D1 + source-sync health.
- `POST /telegram/webhook` — Telegram webhook; protected by Telegram secret header.
- `POST /admin/sync` — manual FiberNet source sync; requires `Authorization: Bearer <ADMIN_API_TOKEN>`.

## Admin commands

Inside the configured support group:

```text
/tickets
/stats
/sync
/close FN-260907-ABC123
/reply FN-260907-ABC123 Assalomu alaykum, liniyani tekshiryapmiz.
```

The easiest reply workflow is simply to **reply to the original ticket message** in the group.

## User commands

```text
/start
/language
/tickets
/cancel
```

## Local development

Create `.dev.vars` from `.dev.vars.example`, then:

```bash
npm run db:migrate:local
npm run dev
```

Run tests:

```bash
npm test
```

## Security notes

- Do not commit bot tokens or API tokens.
- Keep Telegram webhook secret enabled.
- Do not request subscriber cabinet passwords through Telegram.
- D1 uses parameterized queries throughout the bot.
- Keep the support group private and restrict administrator access.
- If a billing/customer API becomes available later, integrate it with a separate secret and least-privilege credentials rather than scraping private subscriber data.
