-- 0013_asset_gc (UPL-1, SEAM-02, SEAM-11): the report-first collector of uploaded files nothing
-- references any more (apps/api/src/files/gc.ts), plus indexes for the per-guest upload allowance and
-- the storage totals. Shipped migrations are never edited.
--
-- A version counts as referenced while a board of its workspace shows it on the canvas or can put it
-- back from "Recently deleted" (asked of sync), a checkpoint or a board_asset_links row names it, its
-- board is in the trash, or it is younger than 7 days (in flight). The collector marks the others with
-- `unreferenced_since` and clears the mark as soon as a pass sees a reference again. Only with
-- DRAFTROOM_ASSET_GC=delete, and only after 30 days unreferenced, does it delete a version: its rows,
-- its original and preview objects, with an audit event.

ALTER TABLE asset_versions ADD COLUMN unreferenced_since timestamptz;
CREATE INDEX asset_versions_unreferenced_idx ON asset_versions (workspace_id, unreferenced_since)
  WHERE unreferenced_since IS NOT NULL;
-- What one uploader (a name-only guest: SEAM-02) has stored in a workspace.
CREATE INDEX asset_versions_uploader_idx ON asset_versions (workspace_id, uploaded_by);
-- Thumbnail bytes count toward a workspace's storage (SEAM-11).
CREATE INDEX board_thumbnails_workspace_idx ON board_thumbnails (workspace_id);

-- The asset versions each checkpoint body names. Bodies never change, so each is read once; a
-- checkpoint that names no file has a scan row and no ref rows.
CREATE TABLE asset_gc_snapshot_scans (
  snapshot_id text PRIMARY KEY REFERENCES board_snapshots (id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  ref_count integer NOT NULL CHECK (ref_count >= 0)
);
CREATE TABLE asset_gc_snapshot_refs (
  snapshot_id text NOT NULL REFERENCES asset_gc_snapshot_scans (snapshot_id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  asset_id text NOT NULL CHECK (asset_id ~ '^ast_[0-9A-Za-z]{10,40}$'),
  version_id text NOT NULL CHECK (version_id ~ '^ver_[0-9A-Za-z]{10,40}$'),
  PRIMARY KEY (snapshot_id, version_id)
);
CREATE INDEX asset_gc_snapshot_refs_version_idx ON asset_gc_snapshot_refs (workspace_id, version_id);

-- The latest collector pass of each workspace (the storage report shows it).
CREATE TABLE asset_gc_runs (
  workspace_id text PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('report', 'delete')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  -- false: some board or checkpoint could not be read, so nothing new was marked or deleted
  complete boolean NOT NULL,
  boards_scanned integer NOT NULL CHECK (boards_scanned >= 0),
  boards_failed integer NOT NULL CHECK (boards_failed >= 0),
  checkpoints_failed integer NOT NULL CHECK (checkpoints_failed >= 0),
  marked integer NOT NULL CHECK (marked >= 0),
  cleared integer NOT NULL CHECK (cleared >= 0),
  deleted_versions integer NOT NULL CHECK (deleted_versions >= 0),
  deleted_bytes bigint NOT NULL CHECK (deleted_bytes >= 0)
);

-- Objects of versions whose rows the collector deleted, until the blob store confirms each delete
-- (retried by the next pass). Keys are the ones 0007 allows for originals and previews.
CREATE TABLE asset_gc_pending_deletes (
  blob_key text PRIMARY KEY CHECK (
    blob_key ~ '^assets/ast_[0-9A-Za-z]{10,40}/ver_[0-9A-Za-z]{10,40}/(original|d/drv_[0-9A-Za-z]{10,40}\.(webp|png))$'
  ),
  workspace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX asset_gc_pending_deletes_workspace_idx ON asset_gc_pending_deletes (workspace_id);
