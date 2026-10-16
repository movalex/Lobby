-- 0035_board_imports (wave R foundation; docs/WAVE-R-CONTRACTS.md §2): import jobs (Miro import, WS1; backup
-- restore, WS4) and the `importing` board status. Shipped migrations are never edited.
--
-- - boards.status gains 'importing': a board an import job is still building. Nobody can see it: packages/permissions
--   can() refuses every action on it, the api's access loaders treat its row as missing, and every list reads only
--   the statuses a person may see. The job makes it `active` in one transaction at the end, or deletes it (its asset
--   versions cascade). The trashed_at rule is unchanged (an importing board has none).
-- - board_imports: one row per board of a job (id imb_…); `batch_id` (imp_…) is the job a person started. No secret is
--   ever stored here: a Miro token lives only in the api's memory; `source_ref` is a Miro board id or a backup's
--   sha256; `error_code` is an upper-case code; `report` is capped.
-- - board_import_files: which source file became which version, so a resumed job uploads nothing twice.
-- Additive (a new value, two new tables): rolling the api back needs no down migration, only
-- DRAFTROOM_ALLOW_NEWER_SCHEMA=1 and a "Deploy a specific commit" (docs/DEPLOY.md). An older build's can() treats an
-- unknown status as active (checked in the wave R foundation): it must never meet an `importing` row, so roll back
-- only to a build that has this foundation's fail-closed can() once an import has run (docs/WAVE-R-CONTRACTS.md §2.5).

ALTER TABLE boards DROP CONSTRAINT boards_status_check;
ALTER TABLE boards ADD CONSTRAINT boards_status_check
  CHECK (status IN ('active', 'archived', 'trashed', 'importing'));

CREATE TABLE board_imports (
  id text PRIMARY KEY CHECK (id ~ '^imb_[0-9A-Za-z]{10,40}$'),
  -- the job a person started (the importId the web polls)
  batch_id text NOT NULL CHECK (batch_id ~ '^imp_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  project_id text CHECK (project_id ~ '^prj_[0-9A-Za-z]{10,40}$'),
  created_by text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('miro', 'lobby-backup')),
  -- a Miro board id, or the backup's sha256 (never a secret)
  source_ref text CHECK (source_ref ~ '^[A-Za-z0-9_=-]{6,128}$'),
  -- the new board's title (the source's, or the one the person typed)
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  -- the order of the boards in their job
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
  -- set once the importing board row exists; NULL again when it was removed (failed, cancelled)
  board_id text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'paused', 'interrupted', 'done', 'failed', 'cancelled')),
  cancel_requested boolean NOT NULL DEFAULT false,
  pause_requested boolean NOT NULL DEFAULT false,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object'),
  -- the finished board's report (imports.ts ImportBoardReport); the CSV is built from it
  report jsonb CHECK (report IS NULL OR (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 262144)),
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE SET NULL (board_id),
  UNIQUE (batch_id, position),
  -- a finished row has its time; a failed one its code; a done one its board and report
  CHECK ((status IN ('done', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK (status <> 'done' OR report IS NOT NULL)
);
-- "my imports" (30 days, newest first) and a job's rows
CREATE INDEX board_imports_user_idx ON board_imports (created_by, created_at DESC);
CREATE INDEX board_imports_batch_idx ON board_imports (batch_id, position);
CREATE INDEX board_imports_workspace_idx ON board_imports (workspace_id, created_at DESC);
-- the runner's slots and the start-up sweep of stale heartbeats
CREATE INDEX board_imports_active_idx ON board_imports (status, heartbeat_at) WHERE status IN ('queued', 'running');
-- one import row per board it built
CREATE UNIQUE INDEX board_imports_board_idx ON board_imports (board_id) WHERE board_id IS NOT NULL;

CREATE TABLE board_import_files (
  import_id text NOT NULL REFERENCES board_imports (id) ON DELETE CASCADE,
  -- the Miro resource id, or the backup entry's sha256
  source_key text NOT NULL CHECK (source_key ~ '^[A-Za-z0-9_=-]{1,128}$'),
  -- the version it became (NULL for a file that failed); goes with its version
  version_id text REFERENCES asset_versions (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('stored', 'failed')),
  -- why a file failed (a code: `file-host-refused`, `too-large`, …), never a URL
  note text CHECK (note ~ '^[a-z][a-z0-9-]{0,47}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, source_key),
  CHECK ((status = 'stored') = (version_id IS NOT NULL))
);
CREATE INDEX board_import_files_version_idx ON board_import_files (version_id) WHERE version_id IS NOT NULL;
