# FiberNet Assistant

Telegram customer-service bot for **FiberNet / NET TELEVISION**, using Cloudflare Workers, D1, Telegram Forum Topics, and the official FiberNet public site/channel for customer-facing reference content.

Production source entry (repository configuration): `src/index-v24.js`. A green GitHub CI result validates the repository, **not** a Cloudflare production deployment.

## Customer journey

1. `/start` requests Uzbek or Russian. New customers can submit first and last name (mandatory for a profile), plus optional subscriber login and address. They may skip the profile.
2. Admins review submitted profiles in private chat; only approved profile data is reused automatically on future requests. If no approved profile exists, the customer supplies identifying information during operator intake.
3. Customer selects their problem, receives MET/GPON/ONU-aware diagnostics and optional official instructions.
4. If unresolved, an operator ticket creates a **dedicated Telegram Forum Topic**. Never put a ticket or its media in the group's General chat. If topic creation fails, delivery is queued instead of falling back to General.
5. The customer receives a **5–15 minute estimated first-response window** (admin-configurable; not a guarantee). While the conversation is active, private-chat messages go only to that ticket's topic. `/start` and normal menu navigation pause live routing; resuming a ticket is explicit.
6. Staff reply with ordinary messages in the matching topic; messages/media are copied to the customer. Staff notes beginning with `//` remain internal. Each topic supports claim/resolve/transfer/close; extended operator commands remain available without overcrowding the ticket card.

The operator group must have **Forum Topics enabled** and the bot must be an admin with **Manage Topics**, send, and appropriate pin/edit rights.

## Private admin panel

Open the bot privately and send `/admin`. This works only for IDs listed in `ADMIN_IDS`. Group-admin privileges alone do not grant access to the bot-wide panel.

- Dashboard: users, pending/approved profiles, open/urgent/unassigned tickets, live support, outboxes.
- Image management: replace home/support/tariff/payment/connection/TV/services/contacts/news/etc. cards by sending a Telegram photo or safe HTTPS URL; Telegram photo file IDs are reused.
- Uzbek/Russian copy, official source links, preview, restore previous setting, reset to default.
- Ticket lookup, priorities, resolve, and **confirmation before close**.
- Operator access review: validate group membership, approve or revoke; revocation releases assigned open tickets to the queue. Telegram group admins retain their own Telegram rights.
- Broadcasts: preview before explicit confirmation, database-backed queue, per-recipient state and retries, stop action. Telegram sends are at-least-once in exceptional failures (e.g. API succeeds but Worker stops before database confirmation).
- Maintenance: confirmation before toggling, customer notice limited to once per ten minutes. Existing live operator conversations and explicit resume remain available.
- Audit log, official source refresh, and image-cache management.

Changes to image/text/link/wait settings are persisted in D1 and take effect without a code deploy.

## Access and privacy

- `ADMIN_IDS` is a server-side list of numeric Telegram IDs; do not use usernames as authorization.
- Operator access is group-specific (`fn19_operator_acl`). Staff must be added by group managers (`/oprequest` -> approval or `/opadd`) or through the private admin panel.
- The v24 webhook **fails closed** when the token-derived Telegram secret is missing or incorrect. Requests must be JSON and no larger than 512 KiB. D1-based update claims reduce accidental duplicate processing; a processing retry is not discarded as a success.
- Separate private-user burst limits protect the bot from high-volume message storms. Operator group handling has a strict ticket-topic/context check; old General-chat cards cannot relay customer messages.
- Admin-managed official links accept `fibernet.uz` (including subdomains) and matching official `t.me/fibernet_*` handles only. Public HTTPS image URLs cannot point to localhost, direct IPs, or private hostnames; alternatively upload an image directly as a Telegram photo.
- Customer credentials such as passwords, SMS codes, card data and CVV are never requested. **Subscriber login is not a password.**
- Customer profile data is displayed only to authorized staff/admins, not in the group General chat. Old profile approval cards cannot approve a different/newer submission.

Keep `TELEGRAM_BOT_TOKEN` and optional `ADMIN_API_TOKEN` in **Cloudflare Secrets**, not in code, chat screenshots, or GitHub. Rotate any previously exposed tokens and re-check the webhook after rotation.

## Configuration and deployment

```sh
npm install
npm test
npx wrangler deploy --dry-run
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Optional, required for authenticated detailed /health:
npx wrangler secret put ADMIN_API_TOKEN
npm run deploy
```

Configure `ADMIN_IDS`, `SUPPORT_CHAT_ID`, `PUBLIC_BASE_URL`, and the D1 binding in `wrangler.jsonc`; apply any required database migrations before deploy. A Worker cron is configured every five minutes, plus the nightly sync.

After deploying:

- `GET /` should report v24.
- Public `GET /health` returns only `ok`, `service`, `version` (or 503 if D1 fails).
- `GET /health?details=1` requires `Authorization: Bearer <ADMIN_API_TOKEN>` and returns operational statistics. It is disabled when the secret is not configured.
- In a test operator group, create a ticket and verify that its messages appear **only in its own topic**, never General.
- Test non-admin `/admin` and old/stale admin buttons; test approve/reject, then change the profile and confirm old buttons are invalid.
- Test broadcast preview, confirmation twice, stop, and report counts before using broadcasts at scale.
- Check Cloudflare logs, GitHub CI, and back up D1 regularly. Do not confuse passing CI with live production verification.

## Project files

`src/index-v24.js` — public entry; `src/v24-security.js` — ingress dedupe/size/rate control; `src/v24-validation.js` — admin media/link policy; `src/v23-admin.js`, `src/v23-store.js` — private admin controls; `src/v22-content.js` — official bilingual content; `src/v21-conversation.js` — topic chat/outbox; `src/v19-group-guard.js` — operator access and topic isolation; `src/v18-profile.js` — customer profile approval.

Older versioned modules provide backwards-compatible D1 and ticket migration paths. Source-of-truth for current behavior is the v24 entry, not the old v3 gateway.
