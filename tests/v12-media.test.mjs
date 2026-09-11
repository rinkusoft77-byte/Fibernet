import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/v12-media.js';
import { __test as gateway } from '../src/index-v12.js';

test('v12 recognizes support media in both directions', () => {
  for (const msg of [
    { sticker: {} }, { photo: [{}] }, { video: {} }, { video_note: {} },
    { animation: {} }, { voice: {} }, { audio: {} }, { document: {} }
  ]) assert.equal(__test.isSupportedMedia(msg), true);
  assert.equal(__test.isSupportedMedia({ text: 'hello' }), false);
});

test('v12 classifies core requested media', () => {
  assert.equal(__test.mediaKind({ sticker: {} }), 'sticker');
  assert.equal(__test.mediaKind({ photo: [{}] }), 'photo');
  assert.equal(__test.mediaKind({ video: {} }), 'video');
  assert.equal(gateway.version, '12.0.0');
});
