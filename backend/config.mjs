function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(name, fallback, { min = 1, max = 2_147_483_647 } = {}) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function requiredInteger(name, { min = 1, max = 2_147_483_647 } = {}) {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function originsFromEnvironment() {
  const values = required('APP_ORIGINS').split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new Error('APP_ORIGINS must contain at least one exact web origin.');
  return new Set(values.map((value) => {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.origin !== value.replace(/\/$/, '') || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
      throw new Error('APP_ORIGINS entries must be HTTPS origins (HTTP is allowed only for localhost).');
    }
    return url.origin;
  }));
}

export function loadConfig() {
  const botUsername = required('BOT_USERNAME').replace(/^@/, '');
  const miniAppShortName = required('MINI_APP_SHORT_NAME');
  if (!/^[A-Za-z0-9_]{5,64}$/.test(botUsername)) throw new Error('BOT_USERNAME is invalid.');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(miniAppShortName)) throw new Error('MINI_APP_SHORT_NAME is invalid.');

  return Object.freeze({
    nodeEnv: process.env.NODE_ENV || 'production',
    port: positiveInteger('PORT', 8080, { max: 65_535 }),
    databaseUrl: required('DATABASE_URL'),
    databasePoolMax: positiveInteger('DATABASE_POOL_MAX', 10, { max: 100 }),
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    telegramInitDataMaxAgeSeconds: positiveInteger('TELEGRAM_INITDATA_MAX_AGE_SECONDS', 3600, { min: 60, max: 86_400 }),
    allowedOrigins: originsFromEnvironment(),
    botUsername,
    miniAppShortName,
    dailyRewardTickets: requiredInteger('DAILY_REWARD_TICKETS', { max: 1_000_000 }),
    referralRewardTickets: requiredInteger('REFERRAL_REWARD_TICKETS', { max: 1_000_000 }),
    referralMinVerifiedGames: requiredInteger('REFERRAL_MIN_VERIFIED_GAMES', { min: 0, max: 1_000_000 }),
    runMaxDurationSeconds: positiveInteger('RUN_MAX_DURATION_SECONDS', 3600, { min: 60, max: 86_400 }),
    apiRateLimitPerMinute: positiveInteger('API_RATE_LIMIT_PER_MINUTE', 120, { max: 100_000 }),
    ipRateLimitPerMinute: positiveInteger('IP_RATE_LIMIT_PER_MINUTE', 300, { max: 100_000 }),
    trustProxy: process.env.TRUST_PROXY === 'true',
    gameVerifierModule: process.env.GAME_VERIFIER_MODULE?.trim() || '',
  });
}
