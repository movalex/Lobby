-- 0018_ai_settings (ai-assist, reviewer finding DANA-04): AI on or off per board, with a workspace
-- default. Shipped migrations are never edited.
--
-- Whether AI may read a board is its owner's call (an NDA client's board stays out of it), with a default
-- for the whole workspace that its owners and admins set. No row means "on" (the behaviour before this
-- migration), so nothing needs a backfill:
-- - workspace_ai_settings: the default for every board of the workspace without its own row;
-- - board_ai_settings: the board's own choice, which wins over the workspace default.
-- The api reads both for every AI call and status (apps/api/src/features/ai/settings.ts) and refuses
-- AI on a board where it is off, whoever asks.

CREATE TABLE workspace_ai_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  updated_by text REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE board_ai_settings (
  board_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  enabled boolean NOT NULL,
  updated_by text REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE
);
