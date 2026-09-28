-- 0015_board_search (docs/WAVE4-CONTRACTS.md "search"): the full-text index behind search across
-- boards. Shipped migrations are never edited.
--
-- The index is derived data: it can be dropped and rebuilt from the boards (canvas text comes from the
-- sync server, comment text from comment_threads/comments). Nothing here decides access: every search
-- filters by the caller's permissions at query time (apps/api/src/features/search). Entries of a
-- trashed board are deleted when it is trashed (and by the indexer's sweep); deleting a board or a
-- workspace cascades.

-- What was indexed, per board. A board is stale when boards.updated_at moved past canvas_source_at
-- (canvas writes move it through the sync "touch" path) or a thread's updated_at moved past
-- comments_source_at (every comment write touches its thread). The *_source_at values are read BEFORE
-- the text is, so a change that lands meanwhile always leaves the board stale, never missed.
CREATE TABLE board_search_state (
  board_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  canvas_source_at timestamptz,
  -- the sync server's document clock of the indexed canvas text
  canvas_clock bigint CHECK (canvas_clock >= 0),
  canvas_indexed_at timestamptz,
  canvas_bytes integer NOT NULL DEFAULT 0 CHECK (canvas_bytes >= 0),
  canvas_truncated boolean NOT NULL DEFAULT false,
  comments_source_at timestamptz,
  comments_indexed_at timestamptz,
  comments_truncated boolean NOT NULL DEFAULT false,
  -- the canvas text could not be fetched (sync unreachable, …): retried after retry_at
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  retry_at timestamptz,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE
);

-- One row per searchable object: a shape with text, or a comment thread (its live comments' bodies).
-- tsv = english (stemmed, Postgres' own tokens) of the text || simple of its case- and accent-folded
-- form split into runs of letters and digits (how query words are split); the api computes both in
-- the INSERT.
CREATE TABLE board_search_entries (
  board_id text NOT NULL,
  workspace_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('canvas', 'comment')),
  -- a shape id (shape:…) or a thread id (thr_…)
  object_id text NOT NULL CHECK (char_length(object_id) BETWEEN 1 AND 210),
  kind text NOT NULL CHECK (
    kind IN ('note', 'text', 'shape', 'arrow', 'frame', 'file', 'image', 'video', 'other', 'comment',
             'resolved-comment')
  ),
  page_id text CHECK (page_id IS NULL OR char_length(page_id) BETWEEN 1 AND 210),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  tsv tsvector NOT NULL,
  PRIMARY KEY (board_id, source, object_id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK ((source = 'comment') = (kind IN ('comment', 'resolved-comment')))
);
CREATE INDEX board_search_entries_tsv_idx ON board_search_entries USING gin (tsv);
