import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createServices } from '../services.mjs';
import { HttpError } from '../http-utils.mjs';

const { Pool } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const base = dirname(fileURLToPath(import.meta.url));

test('PostgreSQL API services enforce ticket, daily, referral and unverified-score rules', { skip: !testDatabaseUrl }, async () => {
  const schema = `skybound_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: testDatabaseUrl });
  let testPool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    testPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
    const migration = await readFile(join(base, '..', 'migrations', '001_initial.sql'), 'utf8');
    await testPool.query(migration);
    const config = {
      botUsername: 'SkyboundBot', miniAppShortName: 'play', dailyRewardTickets: 2,
      referralRewardTickets: 3, referralMinVerifiedGames: 0, runMaxDurationSeconds: 3600,
      telegramBotToken: 'integration-test-bot-token-never-real', ipRateLimitPerMinute: 9999,
      apiRateLimitPerMinute: 9999,
    };
    const services = createServices({
      pool: testPool,
      config,
      verifyRunReport: async () => ({ verified: false, reason: 'test verifier intentionally rejects' }),
    });
    const inviter = { telegramId: '900000001', firstName: 'Test Inviter', lastName: '', username: 'inviter', photoUrl: null, startParam: null };
    const invitee = { telegramId: '900000002', firstName: 'Test Invitee', lastName: '', username: 'invitee', photoUrl: null, startParam: null };

    const account = await services.me(inviter);
    assert.equal(account.user.tickets, 0);
    await testPool.query('UPDATE skybound_users SET tickets = 1 WHERE telegram_id = $1', [inviter.telegramId]);

    const firstRun = await services.startGame(inviter, 'start-run-001');
    assert.equal(firstRun.ticketCost, 1);
    assert.equal(firstRun.ticketBalance, 0);
    const retryRun = await services.startGame(inviter, 'start-run-001');
    assert.equal(retryRun.runId, firstRun.runId);
    await assert.rejects(() => services.startGame(inviter, 'start-run-002'), (error) => error.code === 'ACTIVE_RUN_EXISTS');

    const result = await services.finishGame(inviter, firstRun.runId, {
      score: 20, crystals: 5, elapsedMs: 1200, seed: firstRun.seed,
      randomAlgorithm: 'mulberry32-v1', inputEvents: [0, 600],
    });
    assert.equal(result.verified, false);
    assert.equal(result.awardedCrystals, 0);
    assert.equal(result.user.totalCrystals, 0);
    assert.equal(result.user.bestScore, 0);
    assert.equal(result.user.gamesPlayed, 0);

    const daily = await services.claimDaily(inviter, 'daily-claim-0001');
    assert.equal(daily.ticketBalance, 2);
    const dailyRetry = await services.claimDaily(inviter, 'daily-claim-0001');
    assert.equal(dailyRetry.ticketBalance, 2);
    await assert.rejects(() => services.claimDaily(inviter, 'daily-claim-0002'), (error) => error.code === 'DAILY_COOLDOWN');

    const referralLink = new URL(account.referralLink);
    const startParam = referralLink.searchParams.get('startapp');
    const referred = await services.me({ ...invitee, startParam });
    assert.equal(referred.user.tickets, 0);
    const referralClaim = await services.claimReferrals(inviter, 'ref-claim-0001');
    assert.equal(referralClaim.ticketBalance, 5);
    const referralRetry = await services.claimReferrals(inviter, 'ref-claim-0001');
    assert.equal(referralRetry.ticketBalance, 5);

    const board = await services.leaderboard(inviter.telegramId, 'all-time', 100);
    assert.deepEqual(board.entries, []);
    assert.equal(board.currentPlayerRank, null);
  } finally {
    await testPool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
