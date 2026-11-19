
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createPool } from './db.mjs';
import { HttpError, readJson, requestId, resolveIdempotencyKey, sendJson } from './http-utils.mjs';
import { verifyTelegramInitData } from './telegram-init-data.mjs';
import { createServices } from './services.mjs';
import { verifyRunReport as rejectUnverifiedRun } from './score-verifier.mjs';

const config = loadConfig();
const pool = createPool(config);
let verifyRunReport = rejectUnverifiedRun;
if (config.gameVerifierModule) {
  const moduleUrl = pathToFileURL(resolve(config.gameVerifierModule));
  const verifierModule = await import(moduleUrl.href);
  if (typeof verifierModule.verifyRunReport !== 'function') {
    throw new Error('GAME_VERIFIER_MODULE must export verifyRunReport({ run, clientReport }).');
  }
  verifyRunReport = verifierModule.verifyRunReport;
} else {
  console.warn('Game replay verification is not configured; game results will fail closed without score/crystal credit.');
}
const services = createServices({ pool, config, verifyRunReport });

function setCors(request, response) {
  const origin = request.headers.origin;
  response.setHeader('Vary', 'Origin');
  if (origin && !config.allowedOrigins.has(origin)) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'This application origin is not allowed.');
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, Idempotency-Key');
    response.setHeader('Access-Control-Max-Age', '600');
  }
}

function validRunId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function authenticate(request) {
  const initData = request.headers['x-telegram-init-data'];
  if (typeof initData !== 'string' || !initData) {
    throw new HttpError(401, 'TELEGRAM_AUTH_REQUIRED', 'Open this Mini App from Telegram to authenticate.');
  }
  try {
    return await verifyTelegramInitData(initData, config.telegramBotToken, {
      maxAgeSeconds: config.telegramInitDataMaxAgeSeconds,
    });
  } catch {
    throw new HttpError(401, 'TELEGRAM_AUTH_INVALID', 'Telegram authentication could not be verified. Reopen the Mini App and retry.');
  }
}

async function handle(request, response) {
  const id = requestId();
  try {
    setCors(request, response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/health' && request.method === 'GET') {
      await pool.query('SELECT 1');
      sendJson(response, 200, { ok: true }, id);
      return;
    }
    if (!url.pathname.startsWith('/v1/')) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found.');

    const telegram = await authenticate(request);
    await services.applyRateLimits(request, telegram.telegramId);
    const needsBody = request.method === 'POST';
    if (needsBody && !String(request.headers['content-type'] || '').toLowerCase().includes('application/json')) {
      throw new HttpError(415, 'JSON_REQUIRED', 'Send a JSON request body.');
    }
    const body = needsBody ? await readJson(request) : {};

    if (request.method === 'GET' && url.pathname === '/v1/me') {
      sendJson(response, 200, await services.me(telegram), id);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/game/start') {
      const key = resolveIdempotencyKey(request, body);
      sendJson(response, 200, await services.startGame(telegram, key), id);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/game/finish') {
      const key = resolveIdempotencyKey(request, body);
      if (!validRunId(body.runId) || key !== body.runId) throw new HttpError(400, 'INVALID_RUN_ID', 'A valid run ID and matching idempotency key are required.');
      sendJson(response, 200, await services.finishGame(telegram, body.runId, body.clientReport), id);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/game/abandon') {
      const key = resolveIdempotencyKey(request, body);
      if (!validRunId(body.runId) || key !== body.runId) throw new HttpError(400, 'INVALID_RUN_ID', 'A valid run ID and matching idempotency key are required.');
      sendJson(response, 200, await services.abandonGame(telegram, body.runId), id);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/rewards/daily/claim') {
      const key = resolveIdempotencyKey(request, body);
      sendJson(response, 200, await services.claimDaily(telegram, key), id);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/referrals/claim') {
      const key = resolveIdempotencyKey(request, body);
      sendJson(response, 200, await services.claimReferrals(telegram, key), id);
      return;
    }
    const taskMatch = /^\/v1\/tasks\/([^/]+)\/claim$/.exec(url.pathname);
    if (request.method === 'POST' && taskMatch) {
      const key = resolveIdempotencyKey(request, body);
      let taskId;
      try { taskId = decodeURIComponent(taskMatch[1]); }
      catch { throw new HttpError(400, 'INVALID_TASK_ID', 'Mission ID is invalid.'); }
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) throw new HttpError(400, 'INVALID_TASK_ID', 'Mission ID is invalid.');
      sendJson(response, 200, await services.claimTask(telegram, taskId, key), id);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/leaderboard') {
      const period = url.searchParams.get('period') || 'daily';
      if (!['daily', 'weekly', 'all-time'].includes(period)) throw new HttpError(400, 'INVALID_PERIOD', 'Period must be daily, weekly, or all-time.');
      const rawLimit = url.searchParams.get('limit') || '100';
      if (!/^\d{1,3}$/.test(rawLimit)) throw new HttpError(400, 'INVALID_LIMIT', 'Leaderboard limit is invalid.');
      sendJson(response, 200, await services.leaderboard(telegram.telegramId, period, Number(rawLimit)), id);
      return;
    }
    throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found.');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof HttpError)) console.error('Skybound API request failed', { requestId: id, errorName: error?.name || 'Error' });
    if (!response.headersSent) {
      const extra = error instanceof HttpError ? error.extra : {};
      sendJson(response, status, { code, message: error instanceof HttpError ? error.message : 'The Skybound service encountered an error.', ...extra }, id);
    } else {
      response.destroy();
    }
  }
}

const server = createServer((request, response) => { void handle(request, response); });
server.requestTimeout = 25_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Skybound API listening on ${config.port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
