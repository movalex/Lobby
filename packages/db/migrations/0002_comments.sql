-- 0002_comments (milestone 2, comments feature): threads, comments, mentions, per-user read marks and
-- in-app notifications. Shipped migrations are never edited; add a new numbered file instead.
-- Every row carries workspace_id. Composite foreign keys keep a thread on a board of the same
-- workspace, and a comment in a thread of the same board and workspace.

CREATE TABLE comment_threads (
  id text PRIMARY KEY CHECK (id ~ '^thr_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  board_id text NOT NULL,
  -- {kind:'point',x,y,pageId?} | {kind:'shape',shapeId,u,v} | {kind:'asset',shapeId,assetId,versionId,page?,timeMs?}
  -- (validated by the API with @draftroom/contracts CommentAnchor before it is stored).
  anchor jsonb NOT NULL CHECK (
    jsonb_typeof(anchor) = 'object' AND anchor ->> 'kind' IN ('point', 'shape', 'asset')
  ),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_by text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_by text REFERENCES users (id),
  resolved_at timestamptz,
  -- Insertion order: breaks ties between rows created in the same millisecond.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (id, board_id, workspace_id),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);
CREATE INDEX comment_threads_board_idx ON comment_threads (board_id, status, updated_at DESC);

-- Soft delete: deleted_at set, the row stays (the API never returns a deleted comment's body).
CREATE TABLE comments (
  id text PRIMARY KEY CHECK (id ~ '^cmt_[0-9A-Za-z]{10,40}$'),
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  author_id text NOT NULL REFERENCES users (id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  FOREIGN KEY (thread_id, board_id, workspace_id)
    REFERENCES comment_threads (id, board_id, workspace_id) ON DELETE CASCADE,
  UNIQUE (id, thread_id)
);
CREATE INDEX comments_thread_idx ON comments (thread_id, seq);

-- Who a comment notified (only people who could view the board when it was written).
CREATE TABLE comment_mentions (
  comment_id text NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX comment_mentions_user_idx ON comment_mentions (user_id);

-- Per-person read marks: a thread is unread for a user when someone else commented after read_at.
CREATE TABLE comment_reads (
  thread_id text NOT NULL REFERENCES comment_threads (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX comment_reads_user_idx ON comment_reads (user_id);

-- In-app notifications (mentions, replies, resolutions; other features add access requests).
-- The id defaults to a random 'ntf_' + 32 hex characters so other features can insert rows without an
-- id generator. Access to the board is re-checked when notifications are listed.
CREATE TABLE notifications (
  id text PRIMARY KEY DEFAULT ('ntf_' || replace(gen_random_uuid()::text, '-', ''))
    CHECK (id ~ '^ntf_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('mention', 'reply', 'resolved', 'access_request')),
  board_id text NOT NULL,
  thread_id text,
  comment_id text,
  actor_id text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id, board_id, workspace_id)
    REFERENCES comment_threads (id, board_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id, thread_id) REFERENCES comments (id, thread_id) ON DELETE CASCADE,
  CHECK (kind = 'access_request' OR thread_id IS NOT NULL),
  CHECK (comment_id IS NULL OR thread_id IS NOT NULL)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, seq DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
