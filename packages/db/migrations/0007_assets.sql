-- 0007_assets (docs/M3-STORAGE-CONTRACTS.md §2): asset metadata and the preview job queue move from
-- meta.json / jobs/*.json on the api's disk into Postgres; the bytes live in the blob store
-- (packages/blob-store: local directory or Cloudflare R2). Shipped migrations are never edited.
--
-- The api builds the same AssetVersionMeta JSON as before from these rows (apps/api/src/files/meta.ts).
-- Every row is written by the api only: uploads insert a version + its job in one transaction; workers
-- change them exclusively through the /api/worker/* protocol (apps/api/src/worker/**).

-- One uploaded file version. `board_id` is the board it was uploaded to; history's board_asset_links
-- (0003) let other boards of the same workspace show it too.
CREATE TABLE asset_versions (
  id text PRIMARY KEY CHECK (id ~ '^ver_[0-9A-Za-z]{10,40}$'),
  asset_id text NOT NULL CHECK (asset_id ~ '^ast_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  -- display name only (sanitized, never a path); LIMITS.maxNameLength
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  declared_mime_type text NOT NULL
    CHECK (declared_mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
  -- the type the original is served with (confirmed by content once the worker is done)
  mime_type text NOT NULL
    CHECK (mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
  kind text NOT NULL CHECK (kind IN ('image', 'pdf', 'video', 'other')),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by text NOT NULL CHECK (uploaded_by ~ '^usr_[0-9A-Za-z]{10,40}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- user-safe (shown in the UI): a fixed message per code, never paths or tool output
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  error_message text CHECK (char_length(error_message) BETWEEN 1 AND 500),
  probe jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(probe) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK ((error_code IS NULL) = (error_message IS NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE INDEX asset_versions_board_idx ON asset_versions (board_id, created_at);
CREATE INDEX asset_versions_asset_idx ON asset_versions (asset_id);

-- Previews the worker produced, written (and so visible) only once `complete` verified every blob.
-- `position` keeps the worker's order (the meta JSON lists derivatives in that order).
CREATE TABLE asset_derivatives (
  id text PRIMARY KEY CHECK (id ~ '^drv_[0-9A-Za-z]{10,40}$'),
  version_id text NOT NULL REFERENCES asset_versions (id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 0),
  role text NOT NULL CHECK (role IN ('thumb', 'display', 'page', 'poster')),
  page integer CHECK (page IS NULL OR page >= 1),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 65535),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 65535),
  mime_type text NOT NULL CHECK (mime_type IN ('image/webp', 'image/png')),
  bytes bigint NOT NULL CHECK (bytes >= 1),
  blob_key text NOT NULL UNIQUE
    CHECK (blob_key ~ '^assets/ast_[0-9A-Za-z]{10,40}/ver_[0-9A-Za-z]{10,40}/d/drv_[0-9A-Za-z]{10,40}\.(webp|png)$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, position)
);

-- One preview job per version (PREVIEW_PROFILE). Claimed with FOR UPDATE SKIP LOCKED: `queued` and
-- due, or `running` with an expired lease (the worker that held it is gone). `lease_owner` stays set
-- after `done`/`failed` so a repeated `complete` from the same worker is answered idempotently.
CREATE TABLE preview_jobs (
  version_id text PRIMARY KEY REFERENCES asset_versions (id) ON DELETE CASCADE,
  profile text NOT NULL CHECK (char_length(profile) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (char_length(lease_owner) BETWEEN 1 AND 128),
  lease_until timestamptz,
  -- worker-side detail of the last transient failure: operators only, never shown to users
  last_error text CHECK (char_length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'running' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX preview_jobs_claim_idx ON preview_jobs (status, run_after);
CREATE INDEX preview_jobs_lease_idx ON preview_jobs (lease_until) WHERE status = 'running';

-- Derivative blob keys handed to the worker holding a job's lease (POST /api/worker/jobs/:ver/derivatives)
-- that `complete` has not turned into asset_derivatives rows yet. Scoped to one attempt: a reclaimed,
-- retried or completed job drops its reservations and the api deletes their blobs.
CREATE TABLE asset_derivative_reservations (
  id text PRIMARY KEY CHECK (id ~ '^drv_[0-9A-Za-z]{10,40}$'),
  version_id text NOT NULL REFERENCES asset_versions (id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 1),
  role text NOT NULL CHECK (role IN ('thumb', 'display', 'page', 'poster')),
  page integer CHECK (page IS NULL OR page >= 1),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 65535),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 65535),
  mime_type text NOT NULL CHECK (mime_type IN ('image/webp', 'image/png')),
  bytes bigint NOT NULL CHECK (bytes >= 1),
  blob_key text NOT NULL UNIQUE
    CHECK (blob_key ~ '^assets/ast_[0-9A-Za-z]{10,40}/ver_[0-9A-Za-z]{10,40}/d/drv_[0-9A-Za-z]{10,40}\.(webp|png)$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_derivative_reservations_version_idx ON asset_derivative_reservations (version_id, attempt);
