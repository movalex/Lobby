-- 0038_live_sessions (wave V foundation; docs/WAVE-V-CONTRACTS.md): "Live sessions+". Shipped migrations are never
-- edited.
--
-- - live_activities, live_answers: polls, scales and word clouds (WS1). At most one open activity per board (a dot vote
--   may run beside it). One answer per person, replaced on change. `user_id` is kept only to enforce that while it is
--   open (and, for a NAMED activity, to show its facilitator who answered what after the reveal): whenever an
--   ANONYMOUS activity stops taking answers (closed, ended by its time, revealed, cancelled, its board archived or
--   trashed) the api deletes its answers in the same transaction and keeps only the aggregate (`results`, frozen at
--   its close; none for a cancelled one), so afterwards no row ties a person to an answer. `hidden` holds the words a
--   facilitator hid (normalized, contracts normalizeWord). (Edited in the wave V fix wave, before 0038 ever shipped:
--   `results` may be set on a closed activity.)
-- - breakout_sessions, breakout_members: breakouts (WS4). At most one running session per board; `rev` grows with
--   every change of the session or its members (contracts BreakoutSession.rev). Members are not secret.
-- - invitations.join_code_hash, join_code_n: a workshop link's short join code (WS3): only its sha256 is stored
--   (globally unique: a code names one link, also after it expired), and only on a board's multi-use editor link.
--   The code is derived from the link id and join_code_n (bumped on a collision), so it can be shown again.
--
-- Additive: four new tables, two nullable or defaulted columns; no existing row changes meaning, and an older api
-- ignores all of it (its INSERTs into invitations leave the code null, 0).
--
-- ROLLBACK of the api to a build before 0038 (with DRAFTROOM_ALLOW_NEWER_SCHEMA=1): nothing to undo. That build has no
-- route for any of it: an open activity or a running breakout simply stops (the rows stay, and come back when this
-- build returns), join codes stop resolving (/api/join/:code is an unknown route; the QR of the full invite URL still
-- works), and placed charts and clouds are plain elements on the board.

CREATE TABLE live_activities (
  id text PRIMARY KEY CHECK (id ~ '^act_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('poll', 'scale', 'words')),
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 200),
  -- the kind's setup (contracts PollConfig, ScaleConfig, WordsConfig; the api validates it)
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 4096),
  anonymous boolean NOT NULL DEFAULT true,
  results_live boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'revealed', 'cancelled')),
  -- words a facilitator hid (normalized; word clouds only)
  hidden text[] NOT NULL DEFAULT '{}' CHECK (cardinality(hidden) <= 200),
  -- the aggregate (contracts ActivityResults), frozen at the reveal, or at the close of an anonymous activity
  results jsonb CHECK (results IS NULL OR (jsonb_typeof(results) = 'object' AND octet_length(results::text) <= 16384)),
  created_by text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  closed_at timestamptz,
  revealed_at timestamptz,
  placed_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'revealed') = (revealed_at IS NOT NULL)),
  CHECK (status <> 'revealed' OR results IS NOT NULL),
  CHECK (results IS NULL OR status IN ('closed', 'revealed')),
  CHECK (placed_at IS NULL OR status = 'revealed'),
  CHECK (kind = 'words' OR cardinality(hidden) = 0),
  CHECK (ends_at IS NULL OR ends_at > created_at),
  CHECK (closed_at IS NULL OR closed_at >= created_at)
);
-- at most one open activity per board (an open one past ends_at still holds it until the api closes it)
CREATE UNIQUE INDEX live_activities_open_idx ON live_activities (board_id) WHERE status = 'open';
-- the board's past activities, newest first (GET /api/boards/:bid/activities, the session summary)
CREATE INDEX live_activities_board_idx ON live_activities (board_id, created_at DESC);

CREATE TABLE live_answers (
  workspace_id text NOT NULL,
  activity_id text NOT NULL,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- contracts ActivityAnswer (the api validates it against the activity)
  answer jsonb NOT NULL CHECK (jsonb_typeof(answer) = 'object' AND octet_length(answer::text) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, user_id),
  FOREIGN KEY (workspace_id, activity_id) REFERENCES live_activities (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE breakout_sessions (
  id text PRIMARY KEY CHECK (id ~ '^brk_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('auto', 'manual', 'choose')),
  -- [{id: 'g1'..'g20', name, frameId: 'shape:<element id>'}] (contracts BreakoutGroup)
  groups jsonb NOT NULL CHECK (
    jsonb_typeof(groups) = 'array'
    AND jsonb_array_length(groups) BETWEEN 2 AND 20
    AND octet_length(groups::text) <= 16384
  ),
  group_cap integer CHECK (group_cap BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ended')),
  rev integer NOT NULL DEFAULT 0 CHECK (rev >= 0),
  created_by text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  ended_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK (group_cap IS NULL OR mode = 'choose'),
  CHECK (ends_at IS NULL OR ends_at > created_at),
  CHECK (ended_at IS NULL OR ended_at >= created_at)
);
-- at most one running session per board
CREATE UNIQUE INDEX breakout_sessions_running_idx ON breakout_sessions (board_id) WHERE status = 'running';
CREATE INDEX breakout_sessions_board_idx ON breakout_sessions (board_id, created_at DESC);

CREATE TABLE breakout_members (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id text NOT NULL CHECK (group_id ~ '^g([1-9]|1[0-9]|20)$'),
  assigned_by text NOT NULL CHECK (assigned_by IN ('auto', 'facilitator', 'self')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES breakout_sessions (workspace_id, id) ON DELETE CASCADE
);
-- a group's members (summons and broadcasts to one group; choose mode's cap)
CREATE INDEX breakout_members_group_idx ON breakout_members (session_id, group_id);

-- join codes: only a board's multi-use editor link (a workshop link) holds one
ALTER TABLE invitations ADD COLUMN join_code_hash text CHECK (join_code_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE invitations ADD COLUMN join_code_n smallint NOT NULL DEFAULT 0 CHECK (join_code_n BETWEEN 0 AND 15);
ALTER TABLE invitations ADD CONSTRAINT invitations_join_code_scope_check
  CHECK (join_code_hash IS NULL OR (multi_use AND board_id IS NOT NULL AND role = 'editor'));
CREATE UNIQUE INDEX invitations_join_code_idx ON invitations (join_code_hash) WHERE join_code_hash IS NOT NULL;
