-- 0037_client_review (wave S foundation; docs/WAVE-S-CONTRACTS.md): client review. Shipped migrations are never edited.
--
-- - review_rounds, review_items, review_events: review status of a board's deliverables (a frame or a file, by its
--   element id), optional rounds ("Round 2"), and the history of every step. Status lives only here, never in elements
--   (CONTRACTS_REV is unchanged). An item is removed softly (removed_at; its history stays) and revived by marking the
--   element again; at most one live item per element and one open round per board. An event keeps the actor's name and
--   kind as they were then (actor_kind read from users.kind in the write's transaction, never from the request).
-- - asset_versions.supersedes: a new version of a deliverable keeps its asset id and names the version it replaces.
--   The composite key keeps a chain inside one asset; the partial unique index keeps it linear (two people superseding
--   v3 at once: the second insert fails). The file collector keeps a whole chain while any version of it is
--   referenced, and every version a comment thread is pinned to (apps/api/src/files/gc.ts).
-- - comment_threads.spot_u / spot_v: where on the image, PDF page or video frame an `asset`-anchored thread points.
-- - invitations.landing: where a review link opens (the board, or its review page).
-- - notifications: kind 'review_status' with the review event it is about; chat_hook_prefs may opt into it.
--
-- Additive: the new tables are empty, the new columns are nullable or have constant defaults (an older build's INSERTs
-- leave them null, 'board'), and no existing row changes meaning. Versions sharing one asset id are valid rows to an
-- older api: every read of it is keyed by the version or by (asset, version) (audited for wave S), and its uploads and
-- restores make fresh assets.
--
-- ROLLBACK of the api to a build before 0037 (with DRAFTROOM_ALLOW_NEWER_SCHEMA=1):
--   1. DELETE FROM notifications WHERE kind = 'review_status';
--      (that build lists every kind it finds, and the web of its time cannot parse it: its whole bell would fail)
--   2. UPDATE chat_hook_prefs SET kinds = array_remove(kinds, 'review_status') WHERE 'review_status' = ANY (kinds);
--      (its chat-prefs answer would carry a kind its web cannot parse)
--   3. Keep DRAFTROOM_ASSET_GC at `report` (or `off`) for as long as that build runs: it does not know the chain and
--      comment-pin rules, so in delete mode it would remove older versions 30 days after they were superseded, and the
--      versions comment threads are pinned to. Report mode only marks; the next pass of this build clears the marks.
-- The review tables, the spot columns and landing are ignored by that build (a spot is dropped from its answers; a
-- review link opens the board).

CREATE TABLE review_rounds (
  id text PRIMARY KEY CHECK (id ~ '^rvr_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  number integer NOT NULL CHECK (number BETWEEN 1 AND 100),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  opened_by text REFERENCES users (id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  -- the named manual checkpoint taken at the start ("Review round 2 sent"); null when it could not be taken
  checkpoint_id text REFERENCES board_snapshots (id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (board_id, number),
  UNIQUE (id, board_id),
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
-- at most one open round per board
CREATE UNIQUE INDEX review_rounds_open_idx ON review_rounds (board_id) WHERE closed_at IS NULL;

CREATE TABLE review_items (
  id text PRIMARY KEY CHECK (id ~ '^rvi_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  -- the Excalidraw element (canvas-schema ELEMENT_ID_PATTERN; the api checks it too)
  element_id text NOT NULL CHECK (element_id ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  kind text NOT NULL CHECK (kind IN ('frame', 'file')),
  -- file items: the deliverable (every version of it shares this id)
  asset_id text CHECK (asset_id ~ '^ast_[0-9A-Za-z]{10,40}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  position integer CHECK (position BETWEEN 0 AND 100000),
  round_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'changes_requested', 'approved')),
  -- status changes so far (a write's fromSeq is compared with it)
  status_seq bigint NOT NULL DEFAULT 0 CHECK (status_seq >= 0),
  status_by text REFERENCES users (id) ON DELETE SET NULL,
  status_at timestamptz,
  -- the version a file item's status is about ("Approved v3"); it must be a version of the item's asset
  status_version_id text,
  created_by text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (round_id, board_id) REFERENCES review_rounds (id, board_id) ON DELETE SET NULL (round_id),
  FOREIGN KEY (asset_id, status_version_id) REFERENCES asset_versions (asset_id, id)
    ON DELETE SET NULL (status_version_id),
  CHECK ((kind = 'file') = (asset_id IS NOT NULL)),
  CHECK (status_version_id IS NULL OR kind = 'file'),
  UNIQUE (id, board_id, workspace_id)
);
-- one live item per element (and the board's list of live items)
CREATE UNIQUE INDEX review_items_live_idx ON review_items (board_id, element_id) WHERE removed_at IS NULL;
-- a new version resets the live items of its asset
CREATE INDEX review_items_asset_idx ON review_items (workspace_id, asset_id)
  WHERE asset_id IS NOT NULL AND removed_at IS NULL;

CREATE TABLE review_events (
  id text PRIMARY KEY CHECK (id ~ '^rve_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  -- null: a round event
  item_id text,
  round_id text,
  kind text NOT NULL CHECK (kind IN ('status', 'added', 'removed', 'round_opened', 'round_closed')),
  status text CHECK (status IN ('pending', 'changes_requested', 'approved')),
  previous_status text CHECK (previous_status IN ('pending', 'changes_requested', 'approved')),
  reason text CHECK (reason IN ('set', 'new_version', 'new_round')),
  version_id text REFERENCES asset_versions (id) ON DELETE SET NULL,
  -- the note's thread, made in the same transaction (an 'everyone' thread on the same board)
  thread_id text,
  actor_id text REFERENCES users (id) ON DELETE SET NULL,
  -- as shown then: a guest's typed name (users.guest_name), an account's name
  actor_name text NOT NULL CHECK (char_length(actor_name) BETWEEN 1 AND 120),
  actor_kind text NOT NULL CHECK (actor_kind IN ('account', 'guest')),
  actor_external boolean NOT NULL DEFAULT false,
  -- round events: how many items it touched
  item_count integer CHECK (item_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (item_id, board_id, workspace_id) REFERENCES review_items (id, board_id, workspace_id)
    ON DELETE CASCADE,
  FOREIGN KEY (round_id, board_id) REFERENCES review_rounds (id, board_id) ON DELETE SET NULL (round_id),
  FOREIGN KEY (thread_id, board_id, workspace_id) REFERENCES comment_threads (id, board_id, workspace_id)
    ON DELETE SET NULL (thread_id),
  CHECK ((kind = 'status') = (status IS NOT NULL AND reason IS NOT NULL)),
  CHECK (kind = 'status' OR (previous_status IS NULL AND version_id IS NULL AND thread_id IS NULL)),
  CHECK ((kind IN ('round_opened', 'round_closed')) = (item_id IS NULL)),
  CHECK (kind NOT IN ('round_opened', 'round_closed') OR round_id IS NOT NULL),
  CHECK (item_count IS NULL OR kind IN ('round_opened', 'round_closed')),
  UNIQUE (id, board_id)
);
CREATE INDEX review_events_item_idx ON review_events (item_id, seq DESC);
CREATE INDEX review_events_board_idx ON review_events (board_id, seq DESC);

-- versions: the chain stays inside one asset (the composite key), never names itself, and is linear
ALTER TABLE asset_versions ADD COLUMN supersedes text;
ALTER TABLE asset_versions ADD CONSTRAINT asset_versions_supersedes_fk
  FOREIGN KEY (asset_id, supersedes) REFERENCES asset_versions (asset_id, id) ON DELETE SET NULL (supersedes);
ALTER TABLE asset_versions ADD CONSTRAINT asset_versions_supersedes_check
  CHECK (supersedes IS NULL OR supersedes <> id);
CREATE UNIQUE INDEX asset_versions_supersedes_idx ON asset_versions (supersedes) WHERE supersedes IS NOT NULL;
-- a chain in upload order (the version list, "the newest servable version")
CREATE INDEX asset_versions_asset_created_idx ON asset_versions (asset_id, created_at);

-- comments: the spot on an image, page or frame (both or neither, asset anchors only)
ALTER TABLE comment_threads
  ADD COLUMN spot_u double precision CHECK (spot_u BETWEEN 0 AND 1),
  ADD COLUMN spot_v double precision CHECK (spot_v BETWEEN 0 AND 1);
ALTER TABLE comment_threads ADD CONSTRAINT comment_threads_spot_check
  CHECK ((spot_u IS NULL) = (spot_v IS NULL) AND (spot_u IS NULL OR anchor ->> 'kind' = 'asset'));
-- the collector's comment-pin rule: the versions threads are pinned to
CREATE INDEX comment_threads_asset_version_idx ON comment_threads (workspace_id, (anchor ->> 'versionId'))
  WHERE anchor ->> 'kind' = 'asset';

-- review links: where a link opens (a review page only for a board's multi-use link)
ALTER TABLE invitations ADD COLUMN landing text NOT NULL DEFAULT 'board' CHECK (landing IN ('board', 'review'));
ALTER TABLE invitations ADD CONSTRAINT invitations_landing_scope_check
  CHECK (landing = 'board' OR (multi_use AND board_id IS NOT NULL));

-- the bell: review_status rows name their review event (on the same board)
ALTER TABLE notifications ADD COLUMN review_event_id text;
ALTER TABLE notifications ADD CONSTRAINT notifications_review_event_fk
  FOREIGN KEY (review_event_id, board_id) REFERENCES review_events (id, board_id) ON DELETE CASCADE;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('mention', 'reply', 'resolved', 'access_request', 'new_comment', 'access_granted',
                  'outsider_joined', 'review_status'));
ALTER TABLE notifications DROP CONSTRAINT notifications_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_check
  CHECK (kind IN ('access_request', 'access_granted', 'outsider_joined', 'review_status') OR thread_id IS NOT NULL);
ALTER TABLE notifications ADD CONSTRAINT notifications_review_check
  CHECK ((kind = 'review_status') = (review_event_id IS NOT NULL));
CREATE INDEX notifications_review_event_idx ON notifications (review_event_id) WHERE review_event_id IS NOT NULL;

-- chat hooks: review_status may be opted into (contracts chat-hooks.ts CHAT_HOOK_KINDS)
ALTER TABLE chat_hook_prefs DROP CONSTRAINT chat_hook_prefs_kinds_check;
ALTER TABLE chat_hook_prefs ADD CONSTRAINT chat_hook_prefs_kinds_check
  CHECK (kinds <@ ARRAY['mention', 'reply', 'new_comment', 'access_request', 'outsider_joined', 'review_status']::text[]);
