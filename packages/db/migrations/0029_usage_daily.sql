-- 0029_usage_daily (wave M, S3 / M5-5; landed by the wave M foundation, owner W5). Shipped migrations are
-- never edited.
--
-- Privacy-safe usage counters: how many times each fixed usage event (packages/contracts usage.ts USAGE_EVENTS)
-- happened per UTC day, per role class. That is all: no user id, board id, element id, session, text or time
-- finer than the day, and no foreign key to anything. Written by POST /api/usage (an upsert that adds a capped
-- batch), read by GET /internal/usage (the lead's 48 h watch). A row exists only once an event was counted.
--
-- - event: a usage event name, the contract's USAGE_EVENT_PATTERN (the api validates against the list itself).
-- - role_class: creator (a creator account), member (any other account), guest (a name-only guest).
-- - count: the day's sum, never negative.
-- Additive: no existing table changes, and the previous build never reads or writes this one, so rolling the
-- api back needs no down migration, only DRAFTROOM_ALLOW_NEWER_SCHEMA=1 and a "Deploy a specific commit" (not
-- Render's Rollback; docs/DEPLOY.md "Rolling the api back past a migration"): a build without 0029 refuses to start
-- on a database that recorded it.

CREATE TABLE usage_daily (
  day date NOT NULL,
  event text NOT NULL CHECK (event ~ '^[a-z][A-Za-z0-9._:-]{0,119}$'),
  role_class text NOT NULL CHECK (role_class IN ('creator', 'member', 'guest')),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, event, role_class)
);
