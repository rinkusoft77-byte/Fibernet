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

test('/start always triggers language selection in private chat', () => {
  assert.equal(__test.isStartCommand({ message: { text: '/start', chat: { type: 'private' } } }), true);
  assert.equal(__test.isStartCommand({ message: { text: '/start payload', chat: { type: 'private' } } }), true);
  assert.equal(__test.isStartCommand({ message: { text: '/start@FiberNetBot', chat: { type: 'private' } } }), true);
  assert.equal(__test.isStartCommand({ message: { text: '/start', chat: { type: 'supergroup' } } }), false);
  assert.equal(__test.isStartCommand({ message: { text: '/profile', chat: { type: 'private' } } }), false);
});
