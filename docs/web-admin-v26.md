# FiberNet Web Admin Control Center (v26)

## Access

Use the **private Telegram chat with the FiberNet bot**:

1. Send `/admin` from an administrator Telegram account listed in `ADMIN_IDS`.
2. Tap **🌐 WEB ADMIN PANEL**.
3. Telegram opens the Mini App at `PUBLIC_BASE_URL/admin` and supplies signed `initData`.
4. The server validates Telegram's HMAC-SHA-256 signature and `auth_date` (10-minute freshness), then checks the admin ID against `ADMIN_IDS`. Only then does it issue a 2-hour HttpOnly, Secure, SameSite=Strict session cookie.
5. All private API routes require this cookie. Mutation endpoints also require an origin check and a signed CSRF header.

**Do not use Telegram usernames as an authorization source.** Do not paste the bot token into web page code or store it in GitHub. Keep `TELEGRAM_BOT_TOKEN` as a Cloudflare secret.

Directly opening `/admin` in a regular browser will show an authentication instruction; the public HTML contains no customer data or credentials. The admin APIs will return HTTP 401 without a valid server-issued session.

## What the panel manages

- Dashboard: total subscribers, open/closed/unassigned tickets, pending profiles, authorized operator counts, and live support.
- Tickets: search and inspect the last messages, change priority, mark resolved, or close. Actions are checked server-side.
- Profiles: list and approve/reject pending client profiles, with conditional updates to prevent double approvals.
- Operators: inspect and approve/revoke access; approval checks actual Telegram group membership.
- Image library: JPG/PNG upload (up to 6 MB) or external HTTPS link; uploads go through Telegram's Bot API to obtain a persistent `file_id` and also appear in the admin's private Telegram chat.
- Texts: independently edit Uzbek/Russian content (limited HTML tags).
- Links: only official FiberNet domains and `t.me/fibernet_*`.
- Security: view blocked users and security events, block/unblock users with TTL.
- Audit: review changes recorded by admin identity.

The existing Telegram admin menus are retained as a fallback. All settings use the existing `fn23_settings`, `fn23_setting_history`, and `fn23_audit` tables.

## Technical paths

- `GET /admin` — Mini App HTML bootstrap, no private data.
- `GET /admin/app.css`, `GET /admin/app.js` — static UI.
- `POST /admin/api/auth` — validates signed Telegram Mini App payload.
- `GET /admin/api/me` — verifies session; returns ID and CSRF token.
- `GET /admin/api/dashboard`, `tickets`, `profiles`, `operators`, `settings`, `audit`, `security` — authenticated data.
- `POST /admin/api/settings`, `upload`, `profiles/review`, `tickets/action`, `operators/action`, `security/block` — authenticated, CSRF-protected mutations.

The legacy `/telegram/webhook` support-bot flow remains unchanged and is still protected by the v24/v25 ingress security gateways. Customer messages remain isolated in support Topics.

## Deployment

Production Worker entry in `wrangler.jsonc`: `src/index-v26.js`.

Deploy from the repository with appropriately configured Cloudflare credentials and D1 database:

```bash
npm install
npm test
npx wrangler deploy --dry-run
npx wrangler deploy
```

Do not assume that a passing GitHub CI run deploys the Worker: the current CI workflow performs tests and a dry-run only.

After deployment, visit `PUBLIC_BASE_URL/health` and check for `"version":"26.0.0"`. Then test `/admin` using the Telegram button; a non-admin must receive authorization denied for all private APIs.

If Telegram's Mini App does not open, inspect BotFather's web app domain configuration and check that `PUBLIC_BASE_URL` is valid HTTPS.

## Security boundaries and limitations

A public visitor can load the static HTML bootstrap, but cannot access protected data or execute admin actions without a validated Telegram signature and session. Existing authenticated admins must keep their Telegram account secure. The user session expires after 2 hours and is revoked automatically if the admin ID is removed from `ADMIN_IDS` or the bot token is rotated. Access logs and status do not contain the bot token.

This release does **not** claim a completed penetration test or production availability verification. It provides automated HMAC/authentication, CSRF, allowlist and build tests; independently verify behavior and monitor Cloudflare logs in production before relying on it for sensitive customer workflows.
