-- 0030_workspace_templates (wave M, WS-TEMPLATES / M8-3; landed by the wave M foundation, owner W8). Shipped
-- migrations are never edited.
--
-- A board a workspace's creators saved as a team template ("our retro", "our kickoff"): new boards of the
-- workspace start from a copy of it (POST /api/workspaces/:wid/templates/:bid/use, through createBoardFrom and
-- the sync's duplicate path; only the sync writes board files). The template's grants and links are never
-- copied, and the row grants nothing: the board keeps its own access rules.
--
-- - (workspace_id, board_id) references boards (workspace_id, id) (0001's UNIQUE): a template is always a board
--   of its own workspace, and its row goes when the board is deleted for good (trash keeps the board, so the
--   route treats a trashed template as gone). The workspace's own delete cascades too.
-- - name and category: what the picker's Workspace tab shows (contracts ws-templates.ts WS_TEMPLATE_CATEGORIES).
-- - added_by / added_at: who saved it and when; a deleted account leaves the template (added_by NULL).
-- Additive: no existing table changes, and the previous build never touches this one.

CREATE TABLE workspace_templates (
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  board_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  category text NOT NULL DEFAULT 'other' CHECK (category IN ('ideate', 'visual', 'plan', 'review', 'other')),
  added_by text REFERENCES users (id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, board_id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE
);

-- The Workspace tab, newest first; and whether a board is a template (by board id alone).
CREATE INDEX workspace_templates_added_idx ON workspace_templates (workspace_id, added_at DESC, board_id);
CREATE INDEX workspace_templates_board_idx ON workspace_templates (board_id);
