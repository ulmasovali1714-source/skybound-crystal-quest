import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { verifyTelegramInitData } from '../telegram-init-data.mjs';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const encoder = new TextEncoder();

async function signInitData(fields, token) {
  const params = new URLSearchParams(fields);
  const entries = [...params.entries()].sort(([a], [b]) => a < b ? -1 : (a > b ? 1 : 0));
  const check = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  const derivation = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', derivation, encoder.encode(token));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(check));
  params.set('hash', [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
  return params.toString();
}

const token = 'test-only-telegram-bot-token-0123456789';
const baseFields = (date = 1_700_000_000) => ({
  auth_date: String(date),
  query_id: 'AAEAA-test-query',
  user: JSON.stringify({ id: 987654321, first_name: 'Sky', username: 'sky_pilot', photo_url: 'https://t.me/i/userpic/320/example.jpg' }),
  start_param: 'ref_AbCdef_123456',
});

test('valid Telegram initData returns identity only after HMAC verification', async () => {
  const nowSeconds = 1_700_000_100;
  const initData = await signInitData(baseFields(nowSeconds - 10), token);
  const user = await verifyTelegramInitData(initData, token, { nowSeconds, maxAgeSeconds: 60 });
  assert.equal(user.telegramId, '987654321');
  assert.equal(user.firstName, 'Sky');
  assert.equal(user.username, 'sky_pilot');
  assert.equal(user.startParam, 'ref_AbCdef_123456');
});

test('tampered Telegram initData is rejected', async () => {
  const nowSeconds = 1_700_000_001;
  const initData = await signInitData(baseFields(nowSeconds - 1), token);
  const tampered = initData.replace('sky_pilot', 'not_the_user');
  await assert.rejects(() => verifyTelegramInitData(tampered, token, { nowSeconds }));
});

test('expired and duplicate Telegram initData fields are rejected', async () => {
  const initData = await signInitData(baseFields(100), token);
  await assert.rejects(() => verifyTelegramInitData(initData, token, { nowSeconds: 10_000, maxAgeSeconds: 60 }));
  await assert.rejects(() => verifyTelegramInitData(`${initData}&auth_date=100`, token, { nowSeconds: 101 }));
});
