
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpError, keyedDigest } from './http-utils.mjs';
import { isTelegramMember, parseReferralStartParam, validateClientReport } from './validation.mjs';
import { validateVerifierResult } from './score-verifier.mjs';
import { withTransaction } from './db.mjs';

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const asSafeNumber = (value) => {
  const number = typeof value === 'bigint' ? value : BigInt(value ?? 0);
  return number > MAX_SAFE_BIGINT ? Number.MAX_SAFE_INTEGER : Number(number);
};
const normalizedPhoto = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; }
  catch { return null; }
};
const clipped = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const publicUser = (row) => ({
  firstName: row.first_name || '',
  lastName: row.last_name || '',
  username: row.username || null,
  photoUrl: row.photo_url || null,
  tickets: asSafeNumber(row.tickets),
  bestScore: asSafeNumber(row.best_score),
  totalCrystals: asSafeNumber(row.total_crystals),
  gamesPlayed: asSafeNumber(row.games_played),
});

const achievementDefinitions = [
  { id: 'first-flight', title: 'First Flight', description: 'Complete a verified run.', icon: '✦', test: (user) => user.gamesPlayed >= 1 },
  { id: 'sky-pilot', title: 'Sky Pilot', description: 'Complete 10 verified runs.', icon: '☁', test: (user) => user.gamesPlayed >= 10 },
  { id: 'crystal-seeker', title: 'Crystal Seeker', description: 'Earn 25 verified crystals.', icon: '◇', test: (user) => user.totalCrystals >= 25 },
  { id: 'high-flyer', title: 'High Flyer', description: 'Reach a verified score of 50.', icon: '⬆', test: (user) => user.bestScore >= 50 },
  { id: 'legendary-pilot', title: 'Legendary Pilot', description: 'Reach a verified score of 100.', icon: '★', test: (user) => user.bestScore >= 100 },
];

async function ensureAccount(client, telegram, config) {
  const referralCode = randomBytes(12).toString('base64url');
  const result = await client.query(`
    INSERT INTO skybound_users (telegram_id, first_name, last_name, username, photo_url, referral_code)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (telegram_id) DO UPDATE SET
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      username = EXCLUDED.username,
      photo_url = EXCLUDED.photo_url,
      updated_at = now()
    RETURNING *, (xmax = 0) AS inserted`, [
    telegram.telegramId,
    clipped(telegram.firstName, 128),
    clipped(telegram.lastName, 128),
    telegram.username ? clipped(telegram.username, 64) : null,
    normalizedPhoto(telegram.photoUrl),
    referralCode,
  ]);
  let account = result.rows[0];
  if (account.inserted) {
    const inviterCode = parseReferralStartParam(telegram.startParam);
    if (inviterCode) {
      const inviter = await client.query('SELECT telegram_id FROM skybound_users WHERE referral_code = $1', [inviterCode]);
      if (inviter.rowCount && String(inviter.rows[0].telegram_id) !== telegram.telegramId) {
        const attached = await client.query(`
          UPDATE skybound_users SET referred_by = $2, updated_at = now()
          WHERE telegram_id = $1 AND referred_by IS NULL RETURNING telegram_id`,
        [telegram.telegramId, inviter.rows[0].telegram_id]);
        if (attached.rowCount) {
          await client.query(`
            INSERT INTO skybound_referrals (referred_telegram_id, inviter_telegram_id, status)
            VALUES ($1, $2, 'pending') ON CONFLICT (referred_telegram_id) DO NOTHING`,
          [telegram.telegramId, inviter.rows[0].telegram_id]);
        }
      }
    }
  }
  return account;
}

async function loadUser(client, telegramId) {
  const result = await client.query('SELECT * FROM skybound_users WHERE telegram_id = $1', [telegramId]);
  if (!result.rowCount) throw new HttpError(401, 'ACCOUNT_REQUIRED', 'Authenticated account is not available.');
  return result.rows[0];
}

async function loadDaily(client, telegramId, rewardTickets) {
  const latest = await client.query(`
    SELECT claimed_at, claimed_at + interval '24 hours' AS next_claim_at,
      claimed_at <= now() - interval '24 hours' AS available
    FROM skybound_daily_claims
    WHERE telegram_id = $1 ORDER BY claimed_at DESC LIMIT 1`, [telegramId]);
  if (!latest.rowCount) return { available: true, rewardTickets, nextClaimAt: null };
  return {
    available: Boolean(latest.rows[0].available),
    rewardTickets,
    nextClaimAt: new Date(latest.rows[0].next_claim_at).toISOString(),
  };
}

async function loadTasks(client, telegramId) {
  const result = await client.query(`
    SELECT t.task_id, t.category, t.title, t.description, t.reward_tickets,
           t.task_url, t.telegram_channel,
           (c.status = 'verified') AS claimed
    FROM skybound_tasks t
    LEFT JOIN skybound_task_claims c ON c.task_id = t.task_id AND c.telegram_id = $1
    WHERE t.enabled = true
      AND (t.starts_at IS NULL OR t.starts_at <= now())
      AND (t.ends_at IS NULL OR t.ends_at > now())
    ORDER BY t.category, t.task_id`, [telegramId]);
  return result.rows.map((row) => ({
    id: row.task_id,
    category: row.category,
    type: row.category,
    title: row.title,
    description: row.description,
    rewardTickets: Number(row.reward_tickets),
    url: row.task_url || null,
    claimed: Boolean(row.claimed),
    progressText: row.claimed ? 'Reward recorded' : (String(row.category).toLowerCase().includes('channel') ? 'Membership is checked with Telegram' : 'Server verification required'),
    claimLabel: row.claimed ? 'CLAIMED' : 'VERIFY & CLAIM',
  }));
}

async function accountSnapshot(client, telegramId, config) {
  const row = await loadUser(client, telegramId);
  const user = publicUser(row);
  const achievements = achievementDefinitions.filter((item) => item.test(user)).map((item) => ({
    id: item.id, title: item.title, description: item.description, icon: item.icon, unlocked: true,
  }));
  return {
    user,
    ticketBalance: user.tickets,
    daily: await loadDaily(client, telegramId, config.dailyRewardTickets),
    tasks: await loadTasks(client, telegramId),
    achievements,
    referralLink: `https://t.me/${config.botUsername}/${config.miniAppShortName}?startapp=ref_${row.referral_code}`,
  };
}

async function checkTelegramMembership(config, chatId, telegramId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getChatMember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, user_id: telegramId }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      throw new HttpError(503, 'MEMBERSHIP_CHECK_UNAVAILABLE', 'Telegram could not verify channel membership. Please try again later.');
    }
    return isTelegramMember(payload.result);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'MEMBERSHIP_CHECK_UNAVAILABLE', 'Telegram could not verify channel membership. Please try again later.');
  } finally {
    clearTimeout(timer);
  }
}

export function createServices({ pool, config, verifyRunReport }) {
  async function me(telegram) {
    return withTransaction(pool, async (client) => {
      await ensureAccount(client, telegram, config);
      return accountSnapshot(client, telegram.telegramId, config);
    });
  }

  async function startGame(telegram, idempotencyKey) {
    try {
      return await withTransaction(pool, async (client) => {
        await client.query('SELECT telegram_id FROM skybound_users WHERE telegram_id = $1 FOR UPDATE', [telegram.telegramId]);
        const prior = await client.query(`
          SELECT run_id, seed, status FROM skybound_game_runs
          WHERE telegram_id = $1 AND start_idempotency_key = $2`, [telegram.telegramId, idempotencyKey]);
        if (prior.rowCount) {
          if (prior.rows[0].status !== 'active') throw new HttpError(409, 'RUN_ALREADY_CLOSED', 'This start request already belongs to a closed run.');
          const user = await loadUser(client, telegram.telegramId);
          return { runId: prior.rows[0].run_id, seed: Number(prior.rows[0].seed), ticketCost: 1, ticketBalance: asSafeNumber(user.tickets), user: publicUser(user) };
        }
        const active = await client.query(`SELECT run_id FROM skybound_game_runs WHERE telegram_id = $1 AND status = 'active'`, [telegram.telegramId]);
        if (active.rowCount) throw new HttpError(409, 'ACTIVE_RUN_EXISTS', 'An active game run already exists.');
        const debit = await client.query(`
          UPDATE skybound_users SET tickets = tickets - 1, updated_at = now()
          WHERE telegram_id = $1 AND tickets > 0 RETURNING tickets`, [telegram.telegramId]);
        if (!debit.rowCount) {
          const user = await loadUser(client, telegram.telegramId);
          throw new HttpError(409, 'NOT_ENOUGH_TICKETS', 'Not enough tickets! Visit EARN to get more.', { ticketBalance: asSafeNumber(user.tickets) });
        }
        const runId = randomUUID();
        const seed = randomBytes(4).readUInt32BE(0);
        await client.query(`
          INSERT INTO skybound_game_runs (run_id, telegram_id, start_idempotency_key, seed, status)
          VALUES ($1, $2, $3, $4, 'active')`, [runId, telegram.telegramId, idempotencyKey, seed]);
        await client.query(`
          INSERT INTO skybound_ticket_transactions (telegram_id, delta, reason, idempotency_key, reference_id)
          VALUES ($1, -1, 'game_start', $2, $3)`, [telegram.telegramId, `game-start:${idempotencyKey}`, runId]);
        const user = await loadUser(client, telegram.telegramId);
        return { runId, seed, ticketCost: 1, ticketBalance: asSafeNumber(debit.rows[0].tickets), user: publicUser(user) };
      });
    } catch (error) {
      if (error.code === '23505') throw new HttpError(409, 'ACTIVE_RUN_EXISTS', 'A game run is already active or this request was already processed.');
      throw error;
    }
  }

  async function claimDaily(telegram, idempotencyKey) {
    return withTransaction(pool, async (client) => {
      await client.query('SELECT telegram_id FROM skybound_users WHERE telegram_id = $1 FOR UPDATE', [telegram.telegramId]);
      const existing = await client.query(`SELECT id FROM skybound_daily_claims WHERE telegram_id = $1 AND idempotency_key = $2`, [telegram.telegramId, idempotencyKey]);
      if (existing.rowCount) return { ...(await accountSnapshot(client, telegram.telegramId, config)), message: 'Daily reward already recorded.' };
      const recent = await client.query(`
        SELECT claimed_at FROM skybound_daily_claims
        WHERE telegram_id = $1 AND claimed_at > now() - interval '24 hours'
        ORDER BY claimed_at DESC LIMIT 1`, [telegram.telegramId]);
      if (recent.rowCount) {
        const snapshot = await accountSnapshot(client, telegram.telegramId, config);
        throw new HttpError(409, 'DAILY_COOLDOWN', 'Daily reward already claimed. Check back after the 24-hour cooldown.', { ticketBalance: snapshot.ticketBalance, daily: snapshot.daily });
      }
      await client.query(`INSERT INTO skybound_daily_claims (telegram_id, idempotency_key, reward_tickets) VALUES ($1, $2, $3)`, [telegram.telegramId, idempotencyKey, config.dailyRewardTickets]);
      await client.query(`UPDATE skybound_users SET tickets = tickets + $2, updated_at = now() WHERE telegram_id = $1`, [telegram.telegramId, config.dailyRewardTickets]);
      await client.query(`
        INSERT INTO skybound_ticket_transactions (telegram_id, delta, reason, idempotency_key)
        VALUES ($1, $2, 'daily_reward', $3)`, [telegram.telegramId, config.dailyRewardTickets, `daily:${idempotencyKey}`]);
      return { ...(await accountSnapshot(client, telegram.telegramId, config)), message: `Daily reward granted: ${config.dailyRewardTickets} ticket(s).` };
    });
  }

  async function claimReferrals(telegram, idempotencyKey) {
    return withTransaction(pool, async (client) => {
      await client.query('SELECT telegram_id FROM skybound_users WHERE telegram_id = $1 FOR UPDATE', [telegram.telegramId]);
      const operationPrefix = `referral:${idempotencyKey}:`;
      const prior = await client.query(`
        SELECT COALESCE(SUM(delta), 0) AS amount FROM skybound_ticket_transactions
        WHERE telegram_id = $1 AND left(idempotency_key, length($2)) = $2`, [telegram.telegramId, operationPrefix]);
      if (Number(prior.rows[0]?.amount || 0) > 0) {
        return { ...(await accountSnapshot(client, telegram.telegramId, config)), message: `Referral rewards already recorded: ${Number(prior.rows[0].amount)} ticket(s).` };
      }
      const candidates = await client.query(`
        SELECT r.referred_telegram_id
        FROM skybound_referrals r
        JOIN skybound_users invitee ON invitee.telegram_id = r.referred_telegram_id
        WHERE r.inviter_telegram_id = $1 AND r.status IN ('pending', 'qualified')
          AND invitee.games_played >= $2
        ORDER BY r.created_at FOR UPDATE OF r`, [telegram.telegramId, config.referralMinVerifiedGames]);
      let count = 0;
      for (const candidate of candidates.rows) {
        const referredId = String(candidate.referred_telegram_id);
        const ledgerKey = `${operationPrefix}${referredId}`;
        const updated = await client.query(`
          UPDATE skybound_referrals SET status = 'rewarded', qualified_at = COALESCE(qualified_at, now()), rewarded_at = now()
          WHERE referred_telegram_id = $1 AND inviter_telegram_id = $2 AND status IN ('pending', 'qualified')
          RETURNING referred_telegram_id`, [referredId, telegram.telegramId]);
        if (!updated.rowCount) continue;
        await client.query(`UPDATE skybound_users SET tickets = tickets + $2, updated_at = now() WHERE telegram_id = $1`, [telegram.telegramId, config.referralRewardTickets]);
        await client.query(`
          INSERT INTO skybound_ticket_transactions (telegram_id, delta, reason, idempotency_key, reference_id)
          VALUES ($1, $2, 'referral_reward', $3, $4)`, [telegram.telegramId, config.referralRewardTickets, ledgerKey, referredId]);
        count++;
      }
      const snapshot = await accountSnapshot(client, telegram.telegramId, config);
      return { ...snapshot, message: count ? `Verified ${count} referral reward(s).` : 'No eligible verified referrals are ready to claim.' };
    });
  }

  async function claimTask(telegram, taskId, idempotencyKey) {
    const taskResult = await pool.query(`
      SELECT * FROM skybound_tasks WHERE task_id = $1 AND enabled = true
        AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [taskId]);
    if (!taskResult.rowCount) throw new HttpError(404, 'TASK_NOT_FOUND', 'This mission is unavailable.');
    const task = taskResult.rows[0];
    const previousClaim = await pool.query(`
      SELECT status FROM skybound_task_claims WHERE telegram_id = $1 AND task_id = $2`, [telegram.telegramId, taskId]);
    if (previousClaim.rowCount && previousClaim.rows[0].status === 'verified') {
      return withTransaction(pool, async (client) => ({
        ...(await accountSnapshot(client, telegram.telegramId, config)), message: 'Mission reward already recorded.',
      }));
    }
    if (String(task.category).toLowerCase().includes('channel')) {
      if (!task.telegram_channel) throw new HttpError(503, 'TASK_MISCONFIGURED', 'This mission is not configured for verification.');
      const member = await checkTelegramMembership(config, task.telegram_channel, telegram.telegramId);
      if (!member) throw new HttpError(403, 'TASK_NOT_COMPLETED', 'Telegram could not confirm that you joined this channel.');
    } else {
      throw new HttpError(409, 'TASK_VERIFICATION_UNAVAILABLE', 'This mission requires a server-side verification rule that is not configured.');
    }

    return withTransaction(pool, async (client) => {
      await client.query('SELECT telegram_id FROM skybound_users WHERE telegram_id = $1 FOR UPDATE', [telegram.telegramId]);
      const existing = await client.query(`
        SELECT status FROM skybound_task_claims WHERE telegram_id = $1 AND task_id = $2`, [telegram.telegramId, taskId]);
      if (existing.rowCount && existing.rows[0].status === 'verified') {
        return { ...(await accountSnapshot(client, telegram.telegramId, config)), message: 'Mission reward already recorded.' };
      }
      const insert = await client.query(`
        INSERT INTO skybound_task_claims (telegram_id, task_id, idempotency_key, status)
        VALUES ($1, $2, $3, 'verified') ON CONFLICT (telegram_id, task_id) DO NOTHING RETURNING task_id`,
      [telegram.telegramId, taskId, idempotencyKey]);
      if (!insert.rowCount) return { ...(await accountSnapshot(client, telegram.telegramId, config)), message: 'Mission reward already recorded.' };
      await client.query(`UPDATE skybound_users SET tickets = tickets + $2, updated_at = now() WHERE telegram_id = $1`, [telegram.telegramId, task.reward_tickets]);
      await client.query(`
        INSERT INTO skybound_ticket_transactions (telegram_id, delta, reason, idempotency_key, reference_id)
        VALUES ($1, $2, 'task_reward', $3, $4)`, [telegram.telegramId, Number(task.reward_tickets), `task:${taskId}`, taskId]);
      return { ...(await accountSnapshot(client, telegram.telegramId, config)), message: 'Mission membership verified and reward granted.' };
    });
  }

  async function abandonGame(telegram, runId) {
    return withTransaction(pool, async (client) => {
      const result = await client.query(`
        SELECT run_id, status FROM skybound_game_runs
        WHERE run_id = $1 AND telegram_id = $2 FOR UPDATE`, [runId, telegram.telegramId]);
      if (!result.rowCount) throw new HttpError(404, 'RUN_NOT_FOUND', 'Game run not found.');
      if (result.rows[0].status === 'active') {
        await client.query(`UPDATE skybound_game_runs SET status = 'abandoned', finished_at = now() WHERE run_id = $1`, [runId]);
      }
      return { ...(await accountSnapshot(client, telegram.telegramId, config)), message: 'Run closed. The reserved ticket was not refunded.' };
    });
  }

  async function finishGame(telegram, runId, rawReport) {
    const runResult = await pool.query(`
      SELECT run_id, telegram_id, seed, status, started_at, verified_score, verified_crystals
      FROM skybound_game_runs WHERE run_id = $1 AND telegram_id = $2`, [runId, telegram.telegramId]);
    if (!runResult.rowCount) throw new HttpError(404, 'RUN_NOT_FOUND', 'Game run not found.');
    const run = runResult.rows[0];
    if (run.status === 'verified') {
      return withTransaction(pool, async (client) => ({
        ...(await accountSnapshot(client, telegram.telegramId, config)),
        verified: true,
        score: Number(run.verified_score),
        awardedCrystals: Number(run.verified_crystals),
      }));
    }
    if (run.status !== 'active') {
      return withTransaction(pool, async (client) => ({
        ...(await accountSnapshot(client, telegram.telegramId, config)),
        verified: false,
        score: 0,
        awardedCrystals: 0,
      }));
    }

    let report;
    try {
      report = validateClientReport(rawReport, Number(run.seed), Date.now(), run.started_at, config.runMaxDurationSeconds * 1000);
    } catch (error) {
      // Invalid submissions must not leave an active run permanently blocking the account.
      await withTransaction(pool, async (client) => {
        await client.query(`
          UPDATE skybound_game_runs SET status = 'rejected', finish_idempotency_key = $3, finished_at = now()
          WHERE run_id = $1 AND telegram_id = $2 AND status = 'active'`, [runI
