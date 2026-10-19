-- 0039_formats (wave W foundation; docs/WAVE-W-CONTRACTS.md §10): "Formats". Shipped migrations are never edited.
--
-- - worker_ops, worker_op_outputs: a second job family next to preview_jobs (which has one row per version and is done
--   once the preview exists, so it cannot carry later work). One row per op: remove-bg (WS2), extract-text (WS3),
--   render-pages (WS4). Claimed with FOR UPDATE SKIP LOCKED like a preview job, under a lease, by a worker that reports
--   the kind's capability; the preview path is untouched, so a worker before wave W never sees an op. At most one
--   ACTIVE op per (kind, source version, params_key). worker_op_outputs are the blobs a lease holder reserved
--   (remove-bg: a NEW original; render-pages: page derivatives of the source), scoped to one attempt like
--   asset_derivative_reservations; `complete` turns them into rows, every other one is dropped and its blob deleted.
-- - worker_capabilities_seen: when a worker last reported each capability on a claim (operators, and the web's offer:
--   a worker-backed feature is offered only while its capability was seen within 10 minutes).
-- - asset_versions.derived_from_version_id: the version a server-made version was derived from (remove-bg's new asset
--   names its source; SET NULL when the source goes).
-- - file_text_pages, file_text_state: a file version's extracted text, per page, for search (WS3); `tsv` as
--   board_search_entries' (english || simple of the folded text, computed by the api in the INSERT).
-- - board_file_refs: which versions a board's CANVAS shows (refreshed from sync's /internal/boards/:bid/asset-refs on
--   each canvas reindex), so a file hit needs the version placed on that board, not only linked to it.
--
-- Everything cascades from its version or board, so the file collector (files/gc.ts) and board deletion clean it up.
-- Additive: six new tables and one nullable column; no existing row changes meaning, and an older api ignores all of
-- it (it never writes derived_from_version_id, so it stays null).
--
-- ROLLBACK of the api to a build before 0039 (with DRAFTROOM_ALLOW_NEWER_SCHEMA=1): nothing to undo. That build has no
-- route for any of it: queued ops stay queued (a later api fails them WORKER_UNAVAILABLE after 15 minutes), a
-- worker's /api/worker/ops/claim gets 404 (the worker reads that as "no ops"), file text is not searched, and versions
-- already made by remove-bg are ordinary images.

CREATE TABLE worker_ops (
  id text PRIMARY KEY CHECK (id ~ '^wop_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('remove-bg', 'extract-text', 'render-pages')),
  source_version_id text NOT NULL REFERENCES asset_versions (id) ON DELETE CASCADE,
  -- the kind's params (contracts WORKER_OP_PARAMS, validated by the api)
  params jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 1024),
  -- the canonical form of params for the one-active-op rule ('-' when a kind has none; render-pages '9-38')
  params_key text NOT NULL DEFAULT '-' CHECK (params_key ~ '^[a-z0-9-]{1,64}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (char_length(lease_owner) BETWEEN 1 AND 128),
  lease_until timestamptz,
  -- the kind's result (contracts WORKER_OP_RESULTS), written by `complete`
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096)),
  -- remove-bg: the version it made
  result_version_id text REFERENCES asset_versions (id) ON DELETE SET NULL,
  -- who asked (null for the api's own extract-text ops, or once the account is gone)
  requested_by text REFERENCES users (id) ON DELETE SET NULL,
  -- user-safe code (contracts WORKER_OP_ERROR_CODES); the worker's own detail is never stored
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK (status <> 'running' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status IN ('done', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK ((status IN ('failed', 'cancelled')) = (error_code IS NOT NULL)),
  CHECK (result_version_id IS NULL OR kind = 'remove-bg'),
  CHECK (status = 'done' OR result_version_id IS NULL)
);
CREATE UNIQUE INDEX worker_ops_active_idx ON worker_ops (kind, source_version_id, params_key)
  WHERE status IN ('queued', 'running');
CREATE INDEX worker_ops_claim_idx ON worker_ops (status, run_after) WHERE status IN ('queued', 'running');
CREATE INDEX worker_ops_workspace_idx ON worker_ops (workspace_id, created_at DESC);
CREATE INDEX worker_ops_requester_idx ON worker_ops (requested_by, created_at DESC) WHERE requested_by IS NOT NULL;
CREATE INDEX worker_ops_result_idx ON worker_ops (result_version_id) WHERE result_version_id IS NOT NULL;

CREATE TABLE worker_op_outputs (
  id text PRIMARY KEY CHECK (id ~ '^wpo_[0-9A-Za-z]{10,40}$'),
  op_id text NOT NULL REFERENCES worker_ops (id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 1),
  role text NOT NULL CHECK (role IN ('original', 'page')),
  page integer CHECK (page IS NULL OR page BETWEEN 1 AND 9999),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 16384),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 16384),
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/webp')),
  bytes bigint NOT NULL CHECK (bytes >= 1),
  -- original: the NEW asset and version the api picked at reservation; page: the source's asset and version, and the
  -- derivative id the row will get
  asset_id text NOT NULL CHECK (asset_id ~ '^ast_[0-9A-Za-z]{10,40}$'),
  version_id text NOT NULL CHECK (version_id ~ '^ver_[0-9A-Za-z]{10,40}$'),
  derivative_id text CHECK (derivative_id ~ '^drv_[0-9A-Za-z]{10,40}$'),
  blob_key text NOT NULL UNIQUE
    CHECK (blob_key ~ '^assets/ast_[0-9A-Za-z]{10,40}/ver_[0-9A-Za-z]{10,40}/(original|d/drv_[0-9A-Za-z]{10,40}\.(webp|png))$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'page') = (page IS NOT NULL)),
  CHECK ((role = 'page') = (derivative_id IS NOT NULL))
);
CREATE INDEX worker_op_outputs_op_idx ON worker_op_outputs (op_id, attempt);

CREATE TABLE worker_capabilities_seen (
  capability text PRIMARY KEY
    CHECK (capability ~ '^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9._-]{0,31})?@[1-9][0-9]{0,3}$'),
  last_seen_at timestamptz NOT NULL,
  -- the last worker that reported it (operators only)
  worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 1 AND 128)
);

ALTER TABLE asset_versions ADD COLUMN derived_from_version_id text REFERENCES asset_versions (id) ON DELETE SET NULL;
CREATE INDEX asset_versions_derived_idx ON asset_versions (derived_from_version_id)
  WHERE derived_from_version_id IS NOT NULL;

CREATE TABLE file_text_state (
  version_id text PRIMARY KEY REFERENCES asset_versions (id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- done: pages stored; empty: no text in the file (a scan: no OCR); failed: extraction gave up; skipped: the
  -- workspace's file text budget was full
  status text NOT NULL CHECK (status IN ('done', 'empty', 'failed', 'skipped')),
  pages integer NOT NULL DEFAULT 0 CHECK (pages BETWEEN 0 AND 300),
  bytes integer NOT NULL DEFAULT 0 CHECK (bytes BETWEEN 0 AND 524288),
  truncated boolean NOT NULL DEFAULT false,
  extractor text NOT NULL CHECK (extractor ~ '^[a-z0-9.-]{1,40}$'),
  extracted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_text_state_workspace_idx ON file_text_state (workspace_id);

CREATE TABLE file_text_pages (
  version_id text NOT NULL REFERENCES asset_versions (id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  page integer NOT NULL CHECK (page BETWEEN 1 AND 300),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  tsv tsvector NOT NULL,
  PRIMARY KEY (version_id, page)
);
CREATE INDEX file_text_pages_tsv_idx ON file_text_pages USING gin (tsv);
CREATE INDEX file_text_pages_workspace_idx ON file_text_pages (workspace_id);

CREATE TABLE board_file_refs (
  board_id text NOT NULL,
  workspace_id text NOT NULL,
  version_id text NOT NULL REFERENCES asset_versions (id) ON DELETE CASCADE,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, version_id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX board_file_refs_version_idx ON board_file_refs (version_id);
