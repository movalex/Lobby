-- 0016_ai_usage (docs/WAVE4-CONTRACTS.md §4 ai-assist): what AI on the board costs, call by call, and who
-- has seen the "Sends the selected text to OpenAI" notice. Shipped migrations are never edited.
--
-- ai_usage is the ledger behind the api's hard cost limits (apps/api/src/features/ai/budget.ts). The key
-- has no spending cap at OpenAI, so these rows are the only brake:
-- - a row is written BEFORE each model call, with the worst case reserved (the capped input plus the
--   capped output), under one transaction-scoped advisory lock, after the per-user hourly call count and
--   the per-user, per-workspace and global daily token sums were checked against their limits;
-- - after the call it is settled to what OpenAI reported (usage.total_tokens); a call whose cost is
--   unknown (timeout, dropped connection, no usage in the answer) keeps its full reservation, and a row
--   left 'reserved' by a crash keeps it too. Nothing ever gives budget back.
-- Deliberately no foreign keys: deleting a board, a user or a workspace must not erase what was spent
-- today. No prompt, answer or board text is ever stored: ids and counts only.
CREATE TABLE ai_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('summarize', 'themes', 'actions', 'ideas')),
  -- the UTC day the call counts toward
  day date NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'done', 'failed')),
  reserved_tokens integer NOT NULL CHECK (reserved_tokens >= 0),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  -- what counts toward every budget: the reservation until settled, then the real (or unknown = full) cost
  charged_tokens integer NOT NULL CHECK (charged_tokens >= 0),
  created_at timestamptz NOT NULL,
  finished_at timestamptz
);
-- The daily sums (global, per workspace, per user) and the per-user hourly call count.
CREATE INDEX ai_usage_day_idx ON ai_usage (day, workspace_id);
CREATE INDEX ai_usage_user_idx ON ai_usage (user_id, created_at);

-- The privacy notice, once per person per workspace (each workspace is a different client's content):
-- the api refuses an AI call until the person has acknowledged it.
CREATE TABLE ai_notice_acceptances (
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
