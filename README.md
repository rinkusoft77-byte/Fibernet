# FiberNet Customer Portal Bot v3

Professional Telegram customer portal for **FiberNet / NET TELEVISION** on **Cloudflare Workers + D1**.

The v3 goal is simple: a customer should be able to do almost everything from the Telegram bot without being sent around different pages.

## Customer portal

- Uzbek and Russian UI.
- Bot-native main menu; tariffs, services, promotions, contacts and support flows stay inside Telegram.
- Persistent customer profile: subscriber login/contract number, address and phone.
- Telegram `request_contact` phone support with tolerant normalization.
- Free-text routing: customers can simply write messages such as `internet yo'q`, `to'lov tushmadi`, `wifi uzilyapti`, `yangi ulanish kerak` and the bot routes the request.
- Technical diagnostics for no internet, low speed, Wi‑Fi, IPTV/TV and ONU/router issues.
- Departments:
  - technical support;
  - subscriber department;
  - accounting;
  - new connections.
- Bot-native TEZKOR and OnLine tariff browsing with pagination.
- My Profile and My Requests sections.
- Customer can reply to an open ticket with text, photo or file.
- Customer satisfaction feedback after resolution/closure.

## Operator workspace

Every customer request is posted to the configured operator group with:

- priority (`CRITICAL`, `HIGH`, `NORMAL`, `LOW`);
- department and category;
- subscriber profile and ticket context;
- inline actions: **Claim**, **Wait for customer**, **Resolve**, **Close**.

Operators can reply directly to the original ticket message. The bot relays the reply to the customer. Media replies are also supported.

Commands in an operator group:

```text
/queue
/stats
/close FN-...
/help
```

## Ticket lifecycle

Ticket `status` remains `open/closed` for compatibility. v3 adds an operational `stage`:

```text
new -> in_progress -> waiting_customer -> resolved -> closed
```

The bot tracks assignment, first response, last customer/operator activity, feedback and SLA reminders.

## SLA

Cloudflare Cron runs an hourly support check. Open tickets that have waited too long receive a reminder in the correct operator group.

Daily at `23:15 UTC` the bot refreshes official FiberNet public data and cleans old Telegram update-deduplication records.

## Routing groups

`SUPPORT_CHAT_ID` is the fallback operator group.

Optional variables can later split departments into separate groups without changing code:

```text
TECH_CHAT_ID
SUBSCRIBER_CHAT_ID
ACCOUNTING_CHAT_ID
CONNECTION_CHAT_ID
```

If these are not configured, all departments use `SUPPORT_CHAT_ID`.

## Data and schema

v3 uses a self-healing D1 schema layer (`src/portal-db.js`). It adds portal columns only when missing, which lets an existing production database upgrade without a destructive migration.

The original D1 tables remain compatible. New portal metadata includes department, stage, assignment, first response, resolution, satisfaction and SLA fields.

## Project structure

```text
src/index-v3.js       production Worker entrypoint
src/portal-db.js      v3 D1/customer portal data layer
src/portal-ui.js      UI, routing, phone normalization and classification
src/catalog.js        official source sync + tariff parsing
src/telegram.js       Telegram Bot API wrapper
src/config.js         public FiberNet catalog/contact configuration
```

`wrangler.jsonc` points directly to `src/index-v3.js`; v3 no longer chains the old v2 wrapper entrypoints, which avoids duplicated webhook/state processing.

## Security

- Telegram webhook requests require `TELEGRAM_WEBHOOK_SECRET`.
- Bot/API secrets belong in Cloudflare Secrets, not GitHub.
- Subscriber passwords are never requested or stored.
- D1 queries use parameter binding.
- Duplicate Telegram updates are rejected through `processed_updates`.
- Operator group access should remain private/restricted.

A real-time balance, billing history or automatic payment verification must only be added when FiberNet provides an authorized billing/customer API. The bot must not invent account data or scrape private customer accounts.

## Health

```text
GET /health
```

Returns service version, portal state, ticket statistics and source-sync status.

Current production generation: **v3.0.0**.
