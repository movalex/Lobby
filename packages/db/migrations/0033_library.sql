-- 0033_library (wave Q, the Elements panel's library; landed by the wave Q foundation, owner WS2). Shipped migrations
-- are never edited.
--
-- Saved selections ("library items"), kept per workspace (owner_id NULL: the workspace library) or per person
-- (owner_id = that person: the personal library), with flat folders, the file versions their images show, and each
-- person's favourites and recents of every panel source (contracts library.ts; docs/WAVE-Q-CONTRACTS.md §2).
--
-- - library_folders: one level, named uniquely per scope (case-insensitively). Deleting a folder keeps its items,
--   folderless (library_items.folder_id SET NULL; only that column: PG15+ column list).
-- - library_items: `elements` is the validated, portable element list with item-local ids (the api runs board-ops'
--   checks before it writes; nothing here trusts it), `source` where it came from ({kind:'board', boardId} or
--   {kind:'excalidrawlib', fileName, licence, author}). `revision` starts at 1 and rises on every change (PATCH sends
--   the one it read: a stale one is a 409). `deleted_at` is a soft delete, restorable for 30 days, then purged.
--   `internal_only`: saved from an internal-only project, shown to creators only.
-- - library_item_files: the versions an item's images show, recorded by the api from the version rows (never from the
--   client). A GC root (apps/api/src/files/gc.ts treats a row here like a board_asset_links row, soft-deleted items
--   included until they are purged) and what `place` links into a board. Each row names a real version
--   ((asset_id, version_id) → asset_versions (asset_id, id)) of the item's own workspace.
--   NOTE: asset_versions cascade on their HOME board's hard delete (0007). No board is ever hard-deleted today (the
--   trash keeps them), but a change that adds one must re-home the versions a library item still shows first.
-- - library_marks: per person and workspace, `key` names an icon (icon:<set>:<name>@<setVersion>), a built-in shape
--   (piece:<id>) or an item (item:lbi_…); a favourite and/or the last use (the Recents row). A mark grants nothing:
--   reads still check the item's own access.
-- Additive: no existing table changes, and the previous build never reads or writes these, so rolling the api back
-- needs no down migration, only DRAFTROOM_ALLOW_NEWER_SCHEMA=1 and a "Deploy a specific commit" (not Render's
-- Rollback; docs/DEPLOY.md "Rolling the api back past a migration"): a build without 0033 refuses to start on a
-- database that recorded it.

CREATE TABLE library_folders (
  id text PRIMARY KEY CHECK (id ~ '^lbf_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- NULL: the workspace library's; else that person's personal library
  owner_id text REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 10000),
  created_by text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

-- one name per scope, whatever its case
CREATE UNIQUE INDEX library_folders_name_idx ON library_folders (workspace_id, COALESCE(owner_id, ''), lower(name));

CREATE TABLE library_items (
  id text PRIMARY KEY CHECK (id ~ '^lbi_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- NULL: the workspace library's; else that person's personal library
  owner_id text REFERENCES users (id) ON DELETE CASCADE,
  folder_id text,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  elements jsonb NOT NULL CHECK (jsonb_typeof(elements) = 'array'),
  element_count integer NOT NULL CHECK (element_count BETWEEN 1 AND 500),
  image_count integer NOT NULL DEFAULT 0 CHECK (image_count BETWEEN 0 AND 20),
  -- the element JSON's UTF-8 size
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 262144),
  width real NOT NULL CHECK (width >= 0),
  height real NOT NULL CHECK (height >= 0),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object' AND source ->> 'kind' IN ('board', 'excalidrawlib')),
  internal_only boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by text REFERENCES users (id) ON DELETE SET NULL,
  updated_by text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, workspace_id),
  -- a folder of the same workspace; its delete leaves the item, folderless
  FOREIGN KEY (folder_id, workspace_id) REFERENCES library_folders (id, workspace_id) ON DELETE SET NULL (folder_id)
);

-- a scope's list (and a folder's), newest change first; "Recently deleted" and the purge
CREATE INDEX library_items_list_idx
  ON library_items (workspace_id, owner_id, folder_id, updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX library_items_deleted_idx ON library_items (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX library_items_tags_idx ON library_items USING gin (tags);

CREATE TABLE library_item_files (
  item_id text NOT NULL,
  workspace_id text NOT NULL,
  asset_id text NOT NULL CHECK (asset_id ~ '^ast_[0-9A-Za-z]{10,40}$'),
  version_id text NOT NULL CHECK (version_id ~ '^ver_[0-9A-Za-z]{10,40}$'),
  PRIMARY KEY (item_id, version_id),
  FOREIGN KEY (item_id, workspace_id) REFERENCES library_items (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, version_id) REFERENCES asset_versions (asset_id, id) ON DELETE CASCADE
);

-- "Does a library item still show this version?" (the GC's reference check, by workspace and version)
CREATE INDEX library_item_files_ver_idx ON library_item_files (workspace_id, version_id);

CREATE TABLE library_marks (
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (
    char_length(key) BETWEEN 3 AND 120
    AND key ~ '^(icon:(lucide|tabler):[a-z0-9]+(-[a-z0-9]+)*@[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}|piece:[a-z][a-z0-9-]{0,25}|item:lbi_[0-9A-Za-z]{10,40})$'
  ),
  favourite boolean NOT NULL DEFAULT false,
  used_at timestamptz,
  PRIMARY KEY (user_id, workspace_id, key)
);

-- the Recents row: a person's last uses in a workspace
CREATE INDEX library_marks_recent_idx
  ON library_marks (user_id, workspace_id, used_at DESC) WHERE used_at IS NOT NULL;
