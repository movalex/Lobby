-- 0010_private_notes (wave 3, "private-notes"): private brainstorming in workshops (build plan §9).
-- Shipped migrations are never edited; add a new numbered file instead (see packages/db/src/migrate.ts).
-- Every tenant row carries workspace_id; composite foreign keys keep a row inside its board's workspace.
--
-- Drafts are private: the API only ever returns a draft to its author, and events carry counts. At
-- reveal the sync server writes the drafts into the board as note shapes; the drafts are then deleted,
-- so no row keeps who wrote what (anonymous sessions never store an author anywhere else either).

CREATE TABLE private_brainstorms (
  id text PRIMARY KEY CHECK (id ~ '^pbs_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 200),
  anonymous boolean NOT NULL,
  -- The target frame and where it was at the start (page coordinates), so a frame deleted meanwhile
  -- can be recreated there at reveal.
  frame_id text NOT NULL CHECK (frame_id ~ '^shape:[A-Za-z0-9_-]{1,100}$'),
  frame_page_id text NOT NULL CHECK (frame_page_id ~ '^page:[A-Za-z0-9_-]{1,100}$'),
  frame_x double precision NOT NULL CHECK (frame_x BETWEEN -10000000 AND 10000000),
  frame_y double precision NOT NULL CHECK (frame_y BETWEEN -10000000 AND 10000000),
  frame_w double precision NOT NULL CHECK (frame_w BETWEEN 1 AND 100000),
  frame_h double precision NOT NULL CHECK (frame_h BETWEEN 1 AND 100000),
  -- open -> revealed -> placed; open or revealed -> cancelled.
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'revealed', 'placed', 'cancelled')),
  created_by text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revealed_at timestamptz,
  ended_at timestamptz,
  placed_count integer CHECK (placed_count IS NULL OR placed_count >= 0),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK ((status IN ('revealed', 'placed')) = (revealed_at IS NOT NULL) OR status = 'cancelled'),
  CHECK ((status IN ('placed', 'cancelled')) = (ended_at IS NOT NULL)),
  CHECK ((status = 'placed') = (placed_count IS NOT NULL))
);
-- At most one active (open or revealed) session per board.
CREATE UNIQUE INDEX private_brainstorms_one_active_idx ON private_brainstorms (board_id)
  WHERE status IN ('open', 'revealed');
CREATE INDEX private_brainstorms_board_idx ON private_brainstorms (board_id, created_at DESC);

-- One draft. Readable by its author only (the API's rule; no route returns another person's row).
CREATE TABLE private_notes (
  id text PRIMARY KEY CHECK (id ~ '^pnt_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  author_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  color text NOT NULL CHECK (color IN ('black', 'yellow', 'orange', 'light-red', 'red', 'light-violet',
    'violet', 'blue', 'light-blue', 'green', 'light-green', 'grey', 'white')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Insertion order (drafts written in the same millisecond keep the order they were written in).
  seq bigint GENERATED ALWAYS AS IDENTITY,
  FOREIGN KEY (workspace_id, session_id) REFERENCES private_brainstorms (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX private_notes_session_author_idx ON private_notes (session_id, author_id, seq);
