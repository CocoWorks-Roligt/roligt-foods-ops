-- Roligt Ops — Cloudflare D1 schema. One database per environment
-- (roligt-ops-scratch, roligt-ops-prod), location hint weur (beside Vercel fra1).
--
-- The migration keeps the app's document shape byte-for-byte: what lived in a
-- Zoho "Data JSON" column is the `json` column here, unchanged — no remodeling.
-- The five Zoho link-machinery tables (Vendor Types, Order Lines, BOM Lines,
-- Melange Components, Test Categories) are deliberately absent: the app never
-- read them back (sweepTables skipped them); they existed so Zoho link columns
-- resolved.
--
-- Apply with:
--   npx wrangler d1 execute <database> --remote --file scripts/d1/schema.sql --yes

CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL,             -- wire table name ('grns', 'ledger', 'audits', …) or 'compliance'
  id         TEXT NOT NULL,             -- business key (App ID; sticker templates: the stage)
  json       TEXT NOT NULL,             -- the stored document / flat row — byte-for-byte the wire data
  version    INTEGER NOT NULL DEFAULT 1,-- the <n> of "<id>:<n>"; the token is composed only at API boundaries
  updated_at TEXT NOT NULL,             -- ISO stamp of the last write (forensics; no logic reads it)
  PRIMARY KEY (collection, id)
);

CREATE TABLE IF NOT EXISTS meta (
  setting TEXT PRIMARY KEY,             -- 'app_revision' ("<n>:<nonce>"), 'app_config' (whole JSON), 'period:<series>'
  value   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  series TEXT PRIMARY KEY,
  next   INTEGER NOT NULL
);

-- Turns a guarded write's silent no-op (meta.changes = 0) into a constraint
-- error so the whole commit batch rolls back, when the REST batch is atomic
-- (Design A — pinned by scripts/d1/probe.mjs before the engine trusts it).
-- Every write batch empties it first: DELETE FROM _assert_changed;
-- The constraint is NAMED "_assert_changed" — exactly the string the engines'
-- /_assert_changed/ pattern searches for — because SQLite words a CHECK
-- failure "CHECK constraint failed: <constraint name>", so the name IS the
-- message the engines recognize their assert trip by.
CREATE TABLE IF NOT EXISTS _assert_changed (
  n INTEGER NOT NULL,
  CONSTRAINT _assert_changed CHECK (n = 1)
);

-- Seeded as '0' — the exact token a fresh Zoho base serves — so an empty
-- database reads as never-written (assembleState's everWritten check) and the
-- first client seeds it. The dump's INSERT OR REPLACE lands the real token
-- over this at import.
INSERT OR IGNORE INTO meta(setting, value) VALUES ('app_revision', '0');
