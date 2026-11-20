-- Canonical PostgreSQL schema for SKYBOUND: CRYSTAL QUEST.
-- Fresh deployments should use `npm run migrate`; this file mirrors migrations/001_initial.sql.
CREATE TABLE skybound_users (
  telegram_id BIGINT PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  username TEXT,
  photo_url TEXT,
  tickets INTEGER NOT NULL DEFAULT 0 CHECK (tickets >= 0),
  best_score INTEGER NOT NULL DEFAULT 0 CHECK (best_score >= 0),
  total_crystals BIGINT NOT NULL DEFAULT 0 CHECK (total_crystals >= 0),
  games_played BIGINT NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  referral_code TEXT NOT NULL UNIQUE,
  referred_by BIGINT REFERENCES skybound_users(telegram_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (referred_by IS NULL OR referred_by <> telegram_id)
);

CREATE TABLE skybound_ticket_transactions (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES skybound_users(telegram_id),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reference_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, idempotency_key)
);
CREATE INDEX skybound_ticket_ledger_user_time ON skybound_ticket_transactions(telegram_id, created_at DESC);

CREATE TABLE skybound_crystal_transactions (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES skybound_users(telegram_id),
  delta BIGINT NOT NULL CHECK (delta > 0),
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, idempotency_key),
  UNIQUE (reference_id)
);

CREATE TABLE skybound_daily_claims (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES skybound_users(telegram_id),
  idempotency_key TEXT NOT NULL,
  reward_tickets INTEGER NOT NULL CHECK (reward_tickets > 0),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, idempotency_key)
);
CREATE INDEX skybound_daily_claims_cooldown ON skybound_daily_claims(telegram_id, claimed_at DESC);

CREATE TABLE skybound_referrals (
  referred_telegram_id BIGINT PRIMARY KEY REFERENCES skybound_users(telegram_id),
  inviter_telegram_id BIGINT NOT NULL REFERENCES skybound_users(telegram_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'qualified', 'rewarded', 'rejected')),
  qualified_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (referred_telegram_id <> inviter_telegram_id)
);
CREATE INDEX skybound_referrals_inviter_status ON skybound_referrals(inviter_telegram_id, status);

CREATE TABLE skybound_tasks (
  task_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reward_tickets INTEGER NOT NULL CHECK (reward_tickets > 0),
  telegram_channel TEXT,
  task_url TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT skybound_channel_task_requires_channel CHECK (lower(category) NOT LIKE '%channel%' OR telegram_channel IS NOT NULL)
);
CREATE INDEX skybound_tasks_active ON skybound_tasks(enabled, starts_at, ends_at);

CREATE TABLE skybound_task_claims (
  telegram_id BIGINT NOT NULL REFERENCES skybound_users(telegram_id),
  task_id TEXT NOT NULL REFERENCES skybound_tasks(task_id),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'rejected')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, task_id),
  UNIQUE (telegram_id, idempotency_key)
);

CREATE TABLE skybound_game_runs (
  run_id UUID PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES skybound_users(telegram_id),
  start_idempotency_key TEXT NOT NULL,
  finish_idempotency_key TEXT,
  seed BIGINT NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  status TEXT NOT NULL CHECK (status IN ('active', 'verified', 'rejected', 'abandoned')),
  client_score INTEGER CHECK (client_score IS NULL OR client_score >= 0),
  client_crystals INTEGER CHECK (client_crystals IS NULL OR client_crystals >= 0),
  verified_score INTEGER CHECK (verified_score IS NULL OR verified_score >= 0),
  verified_crystals INTEGER CHECK (verified_crystals IS NULL OR verified_crystals >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (telegram_id, start_idempotency_key),
  UNIQUE (telegram_id, finish_idempotency_key)
);
CREATE UNIQUE INDEX skybound_one_active_run_per_user ON skybound_game_runs(telegram_id) WHERE status = 'active';
CREATE INDEX skybound_runs_user_time ON skybound_game_runs(telegram_id, started_at DESC);

CREATE TABLE skybound_verified_scores (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES skybound_game_runs(run_id),
  telegram_id BIGINT NOT NULL REFERENCES skybound_users(telegram_id),
  score INTEGER NOT NULL CHECK (score >= 0),
  crystals INTEGER NOT NULL CHECK (crystals >= 0),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX skybound_scores_daily ON skybound_verified_scores(verified_at DESC, score DESC);
CREATE INDEX skybound_scores_user_time ON skybound_verified_scores(telegram_id, verified_at DESC);

CREATE TABLE skybound_wallets (
  telegram_id BIGINT PRIMARY KEY REFERENCES skybound_users(telegram_id),
  address TEXT NOT NULL UNIQUE,
  chain TEXT NOT NULL,
  proof_verified_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE skybound_wallet_nonces (
  nonce TEXT PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES skybound_users(telegram_id),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE skybound_achievements (
  telegram_id BIGINT NOT NULL REFERENCES skybound_users(telegram_id),
  achievement_id TEXT NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, achievement_id)
);

CREATE TABLE skybound_rate_buckets (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits INTEGER NOT NULL CHECK (hits >= 0),
  PRIMARY KEY (scope, key_hash)
);
CREATE INDEX skybound_rate_buckets_window ON skybound_rate_buckets(window_start);
