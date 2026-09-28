-- 0012_board_export_policy (wave 3, export-control; docs/WAVE3-CONTRACTS.md): whether viewers and
-- commenters may export, copy and download files on a board. Shipped migrations are never edited.
--
-- One row per board whose owner changed the setting; a board without a row uses 'everyone' (the
-- behaviour before this migration), so existing boards need no backfill. The api reads it for every
-- enforced route (original file downloads, the board archive, duplicate, restore-as-new).

CREATE TABLE board_export_policies (
  board_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  policy text NOT NULL CHECK (policy IN ('everyone', 'editors')),
  updated_by text REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE
);
