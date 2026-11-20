# SKYBOUND: CRYSTAL QUEST API

This directory now contains a Node.js ESM HTTP API and PostgreSQL migration code. It is backend **source code**, not a deployed service. No database, Telegram bot, hosting provider, or production credentials are configured in this repository. The frontend continues to fail closed until you deploy the API and set its public URL in `index.html`.

## Security and current limits

- Telegram identity is derived only from verified `X-Telegram-Init-Data`. `initDataUnsafe`, client-supplied Telegram IDs, balances, rewards, and leaderboard records are never authentication or ledger inputs.
- The bot token is read from `TELEGRAM_BOT_TOKEN` on the server. Never add it to frontend code, commit it, or send it in chat.
- Ticket, daily reward, task reward, and referral changes use PostgreSQL transactions, row locks, unique ledger keys, and idempotency controls.
- A game start atomically charges one ticket and creates one seeded run. Abandoning a run does not refund it, matching the current client.
- Channel membership is checked against Telegram Bot API `getChatMember` from the server. Add the bot to each configured channel with access sufficient for membership checks.
- **Score and crystal credit is disabled by default.** Client reports are untrusted. `score-verifier.mjs` deliberately rejects all runs until a trusted deterministic replay verifier for the current game rules is supplied through `GAME_VERIFIER_MODULE`. This is intentional: accepting client-reported scores/crystal counts would allow fabricated results. A custom verifier must reconstruct the run and independently calculate score and each collected crystal; only its verified output can be credited.
- The existing Mini App wallet hook is local TON Connect UI only. This API does not yet implement TON proof verification, wallet registration/disconnect routes, or TON wallet persistence. The `skybound_wallets` tables are schema preparation only.
- Special missions that are not channel-membership tasks are listed, but claims fail closed until a server-owned eligibility rule is implemented for their mission type.

## Requirements and setup

- Node.js 20.11 or newer.
- PostgreSQL 14 or newer.
- An HTTPS API origin and the exact HTTPS frontend origin(s).
- A Telegram bot configured through BotFather. Store its token in the backend provider's secret manager.

From this directory:

```sh
npm install
cp .env.example .env
# Fill the values in .env locally; never commit .env.
node --env-file=.env migrate.mjs
node --env-file=.env --test test/*.test.mjs
node --env-file=.env server.mjs
```

`npm start` runs the API using environment variables supplied by the host. Use the provider's secret/configuration UI in production; do not upload `.env`. `npm test` runs the unit tests and skips the PostgreSQL integration test unless `TEST_DATABASE_URL` is present. The integration test creates and drops a temporary schema, so its database user needs schema create/drop privileges.

`migrate.mjs` applies numbered SQL files from `migrations/` under a PostgreSQL advisory lock and records them in `skybound_schema_migrations`. For a **fresh database**, run the migration command once. `schema.sql` mirrors the initial migration for review/reference. For an existing database that already has these tables, do not run the initial migration blindly; create and review a baseline/upgrade migration first. The migration runner creates its tracking table before acquiring its advisory lock; deploy migrations as a single controlled release task, not concurrently with application startup.

## Environment variables

`.env.example` lists variable names only. Set these in the API host's server-side environment:

- `DATABASE_URL` — PostgreSQL connection string. Use the provider's TLS-enabled URL.
- `TELEGRAM_BOT_TOKEN` — secret bot token, server only.
- `APP_ORIGINS` — comma-separated exact frontend origins, e.g. `https://mini.example`. No paths or trailing slash.
- `BOT_USERNAME` — public bot username without `@`.
- `MINI_APP_SHORT_NAME` — Telegram Mini App short name used for personal invite links.
- `DAILY_REWARD_TICKETS` — server-selected daily ticket reward; required, positive integer.
- `REFERRAL_REWARD_TICKETS` — server-selected reward per qualified referral; required, positive integer.
- `REFERRAL_MIN_VERIFIED_GAMES` — minimum verified completed runs by a new referred account before the inviter can claim; set intentionally (zero is allowed).
- `GAME_VERIFIER_MODULE` — optional absolute/working-directory-relative path to a trusted server module exporting `verifyRunReport({ run, clientReport })`. Without this, game results are not credited.
- `PORT` — optional HTTP listen port (default 8080).
- `TELEGRAM_INITDATA_MAX_AGE_SECONDS` — maximum accepted `auth_date` age (default 3600 seconds, maximum 86400).
- `RUN_MAX_DURATION_SECONDS` — maximum accepted run time (default 3600).
- `API_RATE_LIMIT_PER_MINUTE`, `IP_RATE_LIMIT_PER_MINUTE` — fixed-window limits (defaults 120 and 300).
- `TRUST_PROXY` — set to `true` only when a trusted reverse proxy sanitizes/overwrites `X-Forwarded-For`; otherwise the API uses the direct socket address.
- `DATABASE_POOL_MAX` — PostgreSQL pool size (default 10).
- `NODE_ENV` — runtime label.

Do not put bot tokens, database credentials, signing secrets, or wallet keys in `index.html`, `app-config.example.js`, or any client-served file. The frontend only needs public `apiBaseUrl`, `tonConnectManifestUrl` (once hosted), and `botUsername` values.

## API contract

Every `/v1` request must include Telegram's raw `initData` in `X-Telegram-Init-Data`. The server validates the HMAC and timestamp on every request, then creates/updates the account by verified Telegram ID. State-changing routes require an `Idempotency-Key`; mutating routes also accept the client's JSON `idempotencyKey`, and if both are present they must match. Responses are JSON and `Cache-Control: no-store`.

- `GET /health` — checks PostgreSQL and returns `{ ok: true }` when available.
- `GET /v1/me` — returns `{ user, ticketBalance, daily, tasks, achievements, referralLink }`; creates the verified account on first authenticated request, with zero tickets. Referral attribution is accepted only from verified Telegram `start_param` on new-account creation.
- `POST /v1/game/start` — body `{ idempotencyKey }`; returns `{ runId, seed, ticketCost: 1, ticketBalance, user }`. The one-ticket debit and active run are in a single transaction. No balance or ID from the browser can alter this.
- `POST /v1/game/finish` — body `{ runId, clientReport }`; the `runId` must also be the `Idempotency-Key`. Report shape is bounded and seed-checked, but that does not make it trustworthy. Only a configured server verifier can cause score/crystals to enter the verified ledger. Unverified reports are recorded as rejected and return `verified: false`, `score: 0`, and `awardedCrystals: 0`.
- `POST /v1/game/abandon` — body `{ runId }`; requires the same run ID as idempotency key and closes the owner's active run without refund.
- `POST /v1/rewards/daily/claim` — body `{ idempotencyKey }`; enforces a 24-hour cooldown and grants the configured ticket count exactly once.
- `POST /v1/referrals/claim` — body `{ idempotencyKey }`; grants configured tickets for new, attributed accounts only after they meet `REFERRAL_MIN_VERIFIED_GAMES`. It never accepts a client invite count.
- `POST /v1/tasks/{taskId}/claim` — channel tasks call Telegram `getChatMember` before one-time ticket grant. Task definitions and channel IDs/reward values must be created by trusted database administration. Unsupported task categories fail closed.
- `GET /v1/leaderboard?period=daily|weekly|all-time&limit=100` — returns the top verified-score entries and the current player's rank; no synthetic/demo rows are generated.

HTTP failures contain `{ code, message, requestId }` (and, for a no-ticket response, `ticketBalance: 0`). The server allows only configured origins and does not use cookies.

## Database and task setup

The initial migration creates accounts, ticket and crystal ledgers, daily claims, referrals, task definitions/claims, game runs, verified score history, wallet preparation tables, achievements, and shared rate-limit buckets. Initial ticket balances are zero; no production users, demo leaderboard rows, or task rewards are seeded.

Channel tasks are inserted by a trusted operator, for example:

```sql
INSERT INTO skybound_tasks
  (task_id, category, title, description, reward_tickets, telegram_channel, task_url, enabled)
VALUES
  ('join-guild', 'channel', 'Join the Sky Guild', 'Join the official channel.', 1,
   '@your_channel', 'https://t.me/your_channel', true);
```

Choose real channel identifiers and reward amounts before inserting. The bot must be able to query membership. Keep task management out of the public API unless protected by a separate administrator authentication system.

Rate limits are stored in PostgreSQL so multiple API instances share the same fixed-window counters. `skybound_rate_buckets` should be periodically cleaned of old rows by a scheduled maintenance job. Configure database backups, monitoring, alerting, connection limits, and retention before launch.

## Deployment sequence

- Provision managed PostgreSQL and a Node.js 20+ service. Keep the database private to the API where possible.
- Configure all required environment variables in the server provider. Set TLS on the database connection and exact `APP_ORIGINS` for the deployed Mini App.
- Run `node migrate.mjs` as a release/migration step, then start `node server.mjs`.
- Confirm `GET /health` from the deployed HTTPS API.
- Configure the Telegram bot's Mini App URL and add it to channels that have membership tasks.
- Set the public API URL and bot username in the frontend's `SKYBOUND_CONFIG`. Do not copy any server secret into the frontend.
- Add carefully reviewed task rows; test in Telegram with real accounts.
- Before enabling score or crystal rewards, implement and test a replay verifier for the current game build. Until then the backend safely refuses to credit them, so verified leaderboards and referral qualification via verified games will remain empty/unavailable.
- If enabling TON wallet association, implement TON proof challenge/verification and wallet routes before treating a connected wallet address as account-owned. Never request private keys or seed phrases.

## Operational status

This code has not been run against a provisioned PostgreSQL instance or deployed to an API host in this project session. The unit/integration tests are authored but have not been executed here. The API should not be described as live until dependencies are installed, tests pass against the target database, deployment is configured, and Telegram end-to-end checks succeed.
