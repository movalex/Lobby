-- 0019_checkpoint_reasons (history-polish, R10): two more reasons for an automatic checkpoint, saved
-- right before another feature makes a big change to the board. Shipped migrations are never edited.
--   before_reveal     a private brainstorm's notes are about to be put on the board (workshops)
--   before_ai_themes  AI "Group into themes" is about to rearrange notes (ai)
-- Only widens the check that 0014 added (Postgres named that column check board_snapshots_reason_check).
ALTER TABLE board_snapshots DROP CONSTRAINT board_snapshots_reason_check;
ALTER TABLE board_snapshots ADD CONSTRAINT board_snapshots_reason_check
  CHECK (reason IN ('hourly', 'session_end', 'before_restore', 'import', 'before_reveal', 'before_ai_themes'));
