import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/index-v10.js';

test('webhook secret changes with bot token', async () => {
  const a = await __test.derivedWebhookSecret({ TELEGRAM_BOT_TOKEN: '123:AAA' });
  const b = await __test.derivedWebhookSecret({ TELEGRAM_BOT_TOKEN: '456:BBB' });
  assert.notEqual(a, b);
  assert.match(a, /^[a-f0-9]{48}$/);
});

test('webhook URL is normalized', () => {
  assert.equal(
    __test.webhookUrl({ PUBLIC_BASE_URL: 'https://example.workers.dev/' }),
    'https://example.workers.dev/telegram/webhook'
  );
});
