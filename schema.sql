-- Elevate Faith Gym: Neon Postgres schema
-- Run this once in the Neon SQL editor (or with psql against DATABASE_URL).
-- It creates the auth tables plus the app data tables (kids, ledgers,
-- rewards, gifts, verse vault, activity log).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Families: one row per parent account.
-- pin_hash holds only a salted scrypt hash, never the plain PIN.
CREATE TABLE IF NOT EXISTS families (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE,
  auth_provider TEXT CHECK (auth_provider IN ('google', 'email')),
  google_sub TEXT UNIQUE,
  pin_hash TEXT,
  setup_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Kids: children belong to a family. Keep names minimal.
CREATE TABLE IF NOT EXISTS kids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  leaderboard_nickname TEXT,
  avatar TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kids_family ON kids(family_id);

-- Server-side sessions. The browser cookie holds only a signed session id.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_family ON sessions(family_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- One-time OAuth state values (CSRF protection), 10 minute life.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Email magic links. Only the token hash is stored, never the raw token.
CREATE TABLE IF NOT EXISTS magic_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);

-- Coins earned by kids. Coins stay 'pending' until a parent approves them.
CREATE TABLE IF NOT EXISTS coin_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id UUID NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  activity TEXT NOT NULL,
  coins INTEGER NOT NULL CHECK (coins >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_kid ON coin_ledger(kid_id);

-- Points earned (quiz) and spent (rapid rewards).
CREATE TABLE IF NOT EXISTS point_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id UUID NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  points_earned INTEGER NOT NULL DEFAULT 0 CHECK (points_earned >= 0),
  points_spent INTEGER NOT NULL DEFAULT 0 CHECK (points_spent >= 0),
  source TEXT,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_point_ledger_kid ON point_ledger(kid_id);

-- Sticker catalog (designs live here; they are never exhausted) and claims.
CREATE TABLE IF NOT EXISTS sticker_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
  point_cost INTEGER NOT NULL CHECK (point_cost >= 0)
);
CREATE TABLE IF NOT EXISTS kid_stickers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id UUID NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  sticker_id UUID NOT NULL REFERENCES sticker_catalog(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kid_id, sticker_id)
);

-- Pet catalog and claims (same pattern as stickers).
CREATE TABLE IF NOT EXISTS pet_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
  point_cost INTEGER NOT NULL CHECK (point_cost >= 0)
);
CREATE TABLE IF NOT EXISTS kid_pets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id UUID NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  pet_id UUID NOT NULL REFERENCES pet_catalog(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kid_id, pet_id)
);

-- Parent-set gifts bought with coins.
CREATE TABLE IF NOT EXISTS parent_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  coin_price INTEGER NOT NULL CHECK (coin_price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parent_gifts_family ON parent_gifts(family_id);

-- Gift redemptions: queued until a parent fulfills them.
CREATE TABLE IF NOT EXISTS gift_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id UUID NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  gift_id UUID NOT NULL REFERENCES parent_gifts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'fulfilled')),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fulfilled_at TIMESTAMPTZ
);

-- Verse Vault: memory verses the child has memorized.
CREATE TABLE IF NOT EXISTS verse_vault (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id UUID NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  text TEXT NOT NULL,
  memorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kid_id, reference)
);

-- Activity log: powers the My Progress per-series summary.
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id UUID NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  series TEXT,
  week INTEGER,
  day INTEGER,
  activity_type TEXT NOT NULL,
  minutes_or_value INTEGER,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_kid ON activity_log(kid_id);
