-- 0004_workshops (features phase): the shared workshop timer and dot voting.
-- Shipped migrations are never edited; add a new numbered file instead (see packages/db/src/migrate.ts).
-- Every tenant row carries workspace_id; composite foreign keys keep a row inside its board's workspace.
-- Budgets (votes per person, one per object) are enforced by the API under a row lock on the session
-- (SELECT … FOR UPDATE); the constraints here are the backstop for impossible values.

-- One timer per board. The server stores the end timestamp (never a counting client):
-- running  -> ends_at set, remaining_ms is the value at the last change;
-- paused   -> ends_at null, remaining_ms frozen;
-- stopped  -> ends_at null, remaining_ms = duration_ms (reset);
-- finished -> ends_at is when it reached zero, remaining_ms = 0.
CREATE TABLE workshop_timers (
  board_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'paused', 'stopped', 'finished')),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 0 AND 86400000),
  started_at timestamptz,
  ends_at timestamptz,
  remaining_ms integer NOT NULL CHECK (remaining_ms BETWEEN 0 AND 86400000),
  started_by text REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK ((status IN ('running', 'finished')) = (ends_at IS NOT NULL)),
  CHECK (status <> 'finished' OR remaining_ms = 0)
);

CREATE TABLE vote_sessions (
  id text PRIMARY KEY CHECK (id ~ '^vot_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  votes_per_person integer NOT NULL CHECK (votes_per_person BETWEEN 1 AND 99),
  one_per_object boolean NOT NULL DEFAULT false,
  scope text NOT NULL CHECK (scope IN ('board', 'frame')),
  frame_id text CHECK (frame_id ~ '^shape:[A-Za-z0-9_-]{1,100}$'),
  -- null = any votable object; else a JSON array of tldraw shape types (e.g. ["note"]).
  shape_types jsonb CHECK (shape_types IS NULL OR jsonb_typeof(shape_types) = 'array'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'revealed')),
  created_by text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  closed_at timestamptz,
  revealed_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK ((scope = 'frame') = (frame_id IS NOT NULL)),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'revealed') = (revealed_at IS NOT NULL)),
  CHECK (ends_at IS NULL OR ends_at > created_at)
);
-- At most one open vote per board.
CREATE UNIQUE INDEX vote_sessions_one_open_idx ON vote_sessions (board_id) WHERE status = 'open';
CREATE INDEX vote_sessions_board_idx ON vote_sessions (board_id, created_at DESC);

-- One row per (session, voter, object); count is how many of the voter's dots are on it.
CREATE TABLE votes (
  session_id text NOT NULL,
  workspace_id text NOT NULL,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  shape_id text NOT NULL CHECK (shape_id ~ '^shape:[A-Za-z0-9_-]{1,100}$'),
  count integer NOT NULL CHECK (count BETWEEN 1 AND 99),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id, shape_id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES vote_sessions (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX votes_session_shape_idx ON votes (session_id, shape_id);

-- "I'm done" markers.
CREATE TABLE vote_done (
  session_id text NOT NULL,
  workspace_id text NOT NULL,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  done_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES vote_sessions (workspace_id, id) ON DELETE CASCADE
);
