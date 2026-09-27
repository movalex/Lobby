-- 0001_core (milestone 1): accounts, sessions, workspaces, projects, boards, ACLs, invitations, audit.
-- Shipped migrations are never edited; add a new numbered file instead (see packages/db/src/migrate.ts).
-- Enum-like columns use CHECK constraints (not Postgres ENUM types) so later migrations can extend them
-- with a plain constraint swap. Tenant rows carry workspace_id; composite foreign keys keep a board's
-- project and an invitation's board inside the same workspace.

CREATE TABLE users (
  id text PRIMARY KEY CHECK (id ~ '^usr_[0-9A-Za-z]{10,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  handle text UNIQUE CHECK (char_length(handle) BETWEEN 1 AND 64),
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sign-in provider subject -> internal user ("dev:<handle>", "clerk:<user_...>").
CREATE TABLE identities (
  provider text NOT NULL CHECK (provider IN ('dev', 'clerk')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user_idx ON identities (user_id);

-- id_hash = sha256 hex of the random cookie value; the cookie value itself is never stored.
CREATE TABLE sessions (
  id_hash text PRIMARY KEY CHECK (id_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE workspaces (
  id text PRIMARY KEY CHECK (id ~ '^wsp_[0-9A-Za-z]{10,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE projects (
  id text PRIMARY KEY CHECK (id ~ '^prj_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, id)
);
CREATE INDEX projects_workspace_idx ON projects (workspace_id, created_at);

-- Board ids keep the sync format (they name the board's SQLite file): lowercase only.
CREATE TABLE boards (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  project_id text,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'workspace_view', 'workspace_edit')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'trashed')),
  trashed_at timestamptz,
  created_by text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  CHECK ((status = 'trashed') = (trashed_at IS NOT NULL))
);
-- Dashboard lists: boards of one workspace in one status, most recently opened first.
CREATE INDEX boards_list_idx ON boards (workspace_id, status, last_opened_at DESC NULLS LAST);
CREATE INDEX boards_project_idx ON boards (project_id) WHERE project_id IS NOT NULL;

CREATE TABLE board_members (
  board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  added_by text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX board_members_user_idx ON board_members (user_id);

-- token_hash = sha256 hex of the one-time link token (shown once at creation, never stored).
-- Workspace invitations carry a workspace role; board invitations a board role (never owner).
CREATE TABLE invitations (
  id text PRIMARY KEY CHECK (id ~ '^inv_[0-9A-Za-z]{10,40}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  board_id text,
  role text NOT NULL,
  created_by text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_by text REFERENCES users (id),
  redeemed_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK (
    (board_id IS NULL AND role IN ('admin', 'member', 'guest'))
    OR (board_id IS NOT NULL AND role IN ('editor', 'commenter', 'viewer'))
  ),
  CHECK ((redeemed_by IS NULL) = (redeemed_at IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX invitations_workspace_idx ON invitations (workspace_id);
CREATE INDEX invitations_board_idx ON invitations (board_id) WHERE board_id IS NOT NULL;

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  actor_id text REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z_.]*$'),
  target text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace_idx ON audit_events (workspace_id, at DESC);
