-- 0003_history (docs/FEATURES-M2-CONTRACTS.md "history"): named board checkpoints and file links for
-- boards made from another board (restore-as-new, duplicate, import).
-- Shipped migrations are never edited; add a new numbered file instead.

-- A checkpoint's records live in the object store (the local stand-in: ${DATA}/snapshots/<board>/<snp>.json);
-- this row is the index. storage_key is relative to the data dir and fully determined by the ids, so a
-- row can never point outside its own board's folder.
CREATE TABLE board_snapshots (
  id text PRIMARY KEY CHECK (id ~ '^snp_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('manual', 'auto', 'pre_restore')),
  created_by text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  document_clock bigint NOT NULL CHECK (document_clock >= 0),
  record_count integer NOT NULL CHECK (record_count >= 0),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key text NOT NULL UNIQUE,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK (storage_key = 'snapshots/' || board_id || '/' || id || '.json')
);
CREATE INDEX board_snapshots_board_idx ON board_snapshots (board_id, created_at DESC);

-- An asset version uploaded to one board (its meta.json names that board) that another board of the SAME
-- workspace may also serve, because that board was made from content that already showed it. The file
-- authorizer (apps/api/src/files-auth.ts) serves a version on board B when meta.boardId = B or a row
-- (B, asset, version) exists here. Rows are only written after checking the caller could view the file.
CREATE TABLE board_asset_links (
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  asset_id text NOT NULL CHECK (asset_id ~ '^ast_[0-9A-Za-z]{10,40}$'),
  version_id text NOT NULL CHECK (version_id ~ '^ver_[0-9A-Za-z]{10,40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, asset_id, version_id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE
);
-- "Which boards can show this version?" (transitive checks when copying a copy, imports).
CREATE INDEX board_asset_links_asset_idx ON board_asset_links (workspace_id, asset_id, version_id);
