-- 0014_checkpoint_policy (wave 4, checkpoints-2; docs/WAVE4-CONTRACTS.md, REV-10): automatic
-- checkpoints and their retention. Shipped migrations are never edited; add a new numbered file instead.

-- Why an automatic checkpoint was made (NULL for manual ones, which people name themselves):
--   hourly          at most one an hour while people edit the board
--   session_end     the last editor left after changes
--   before_restore  a checkpoint of this board was about to be restored as a new board
--   import          the board as it was imported, before anyone edited it
-- content_hash: sha256 of the board's records (tldraw user records left out), so a checkpoint whose
-- content did not change is never saved twice. NULL on checkpoints saved before this migration.
ALTER TABLE board_snapshots
  ADD COLUMN reason text CHECK (reason IN ('hourly', 'session_end', 'before_restore', 'import')),
  ADD COLUMN content_hash text CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT board_snapshots_reason_kind CHECK ((kind = 'auto') = (reason IS NOT NULL));

-- Retention (apps/api/src/features/history/retention.ts) reads a board's automatic checkpoints only.
CREATE INDEX board_snapshots_auto_idx ON board_snapshots (board_id, created_at) WHERE kind <> 'manual';

-- Per board: what the automatic checkpoint scheduler knows. A row appears on the first reported canvas
-- change (apps/sync touch.ts -> GET /internal/boards/:bid/touched) or session end, and goes with the board.
CREATE TABLE board_checkpoint_state (
  board_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  -- The first canvas change not covered by a checkpoint yet (NULL: nothing to save).
  dirty_since timestamptz,
  -- The newest canvas change reported.
  last_change_at timestamptz,
  -- The last editor left after changes: a session_end checkpoint is due.
  session_ended_at timestamptz,
  -- The newest automatic checkpoint (the hourly rhythm and the gap between session ends count from it).
  last_auto_at timestamptz,
  -- One api instance works on a board at a time (the claim expires if that instance dies).
  claimed_until timestamptz,
  -- Consecutive failed attempts (the sync server was unreachable) and when to try again.
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  retry_at timestamptz,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX board_checkpoint_state_dirty_idx ON board_checkpoint_state (dirty_since)
  WHERE dirty_since IS NOT NULL;

-- Checkpoint bodies whose rows are gone (deleted by an owner or pruned by retention) and whose blob is
-- not deleted yet. The row delete and this insert commit together; the blob is deleted afterwards and
-- the entry removed, so a failed blob delete is retried instead of leaking. No foreign key on purpose:
-- the entry must outlive the board and its rows. The key is fully determined by the ids.
CREATE TABLE board_snapshot_blob_deletions (
  storage_key text PRIMARY KEY,
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  CHECK (storage_key ~ '^snapshots/[a-z0-9][a-z0-9_-]{2,63}/snp_[0-9A-Za-z]{10,40}\.json$'),
  CHECK (starts_with(storage_key, 'snapshots/' || board_id || '/'))
);
