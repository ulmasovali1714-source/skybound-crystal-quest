import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdempotencyKey, HttpError } from '../http-utils.mjs';
import { isTelegramMember, parseReferralStartParam, validateClientReport } from '../validation.mjs';
import { verifyRunReport, validateVerifierResult } from '../score-verifier.mjs';

const request = (headers = {}) => ({ headers });
const validReport = { score: 20, crystals: 3, elapsedMs: 2500, seed: 123, randomAlgorithm: 'mulberry32-v1', inputEvents: [0, 700, 1800] };

test('idempotency keys require a matching body and header value', () => {
  assert.equal(resolveIdempotencyKey(request({ 'idempotency-key': 'flight-123456' }), { idempotencyKey: 'flight-123456' }), 'flight-123456');
  assert.throws(() => resolveIdempotencyKey(request({ 'idempotency-key': 'flight-123456' }), { idempotencyKey: 'other-123456' }), HttpError);
  assert.throws(() => resolveIdempotencyKey(request(), {}), HttpError);
});

test('run report shape is bounded and tied to the issued seed', () => {
  assert.deepEqual(validateClientReport(validReport, 123), validReport);
  assert.throws(() => validateClientReport({ ...validReport, seed: 124 }, 123), HttpError);
  assert.throws(() => validateClientReport({ ...validReport, inputEvents: [0, 1500, 1200] }, 123), HttpError);
  assert.throws(() => validateClientReport({ ...validReport, crystals: 1_000_001 }, 123), HttpError);
});

test('referral codes and Telegram membership are parsed conservatively', () => {
  assert.equal(parseReferralStartParam('ref_AbCdef_123456'), 'AbCdef_123456');
  assert.equal(parseReferralStartParam('ref_short'), null);
  assert.equal(isTelegramMember({ status: 'member' }), true);
  assert.equal(isTelegramMember({ status: 'restricted', is_member: true }), true);
  assert.equal(isTelegramMember({ status: 'left' }), false);
  assert.equal(isTelegramMember({ status: 'restricted', is_member: false }), false);
});

test('score verifier fails closed and rejects client-echoed rewards as trusted output', async () => {
  assert.deepEqual(await verifyRunReport(), { verified: false, reason: 'GAMEPLAY_REPLAY_VERIFIER_NOT_CONFIGURED' });
  assert.equal(validateVerifierResult({ verified: true, score: 8, crystals: 2 }, validReport).crystals, 2);
  assert.throws(() => validateVerifierResult({ verified: true, score: 8, crystals: 4 }, validReport));
});
