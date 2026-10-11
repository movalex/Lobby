-- 0031_board_visits (wave N, LM-9 "since your last visit"; landed by the wave N foundation, owner WS4). Shipped
-- migrations are never edited.
--
-- One row per (board, person): when that person last saw the board. The owner's condition for storing it: nobody
-- else ever sees who visited when, and there are no read receipts. So only the person's own row is ever read
-- (POST /api/boards/:bid/visit answers their previous time; nothing lists, exports, counts or logs visit times),
-- name-only guests get no row (they keep the device-local window), and rows older than
-- DRAFTROOM_VISITS_RETENTION_DAYS (180) are deleted by the sweeper (board_visits_seen_idx). Deleting the board or
-- the account deletes its rows (ON DELETE CASCADE, also the offboarding sweep's account deletion). The archive
-- export never includes this table.
-- Additive: no existing table changes, and the previous build never reads or writes this one, so rolling the api
-- back needs no down migration, only DRAFTROOM_ALLOW_NEWER_SCHEMA=1 and a "Deploy a specific commit" (not Render's
-- Rollback; docs/DEPLOY.md "Rolling the api back past a migration").

CREATE TABLE board_visits (
  board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);

-- The retention sweep (oldest first), and an account's rows (its cascade).
CREATE INDEX board_visits_seen_idx ON board_visits (seen_at);
CREATE INDEX board_visits_user_idx ON board_visits (user_id);
