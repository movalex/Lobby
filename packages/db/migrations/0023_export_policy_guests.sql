-- 0023_export_policy_guests (Excalidraw migration, wave 4b; security audit L3, 2026-10-01): the export
-- policy gains the value 'everyone-including-guests'. From this build on, 'everyone' (the default, no
-- row) lets people WITH an account who can view the board export, copy and download originals; a
-- name-only guest (users.kind = 'guest') exports only when a board owner chose
-- 'everyone-including-guests' explicitly. Shipped migrations are never edited.
--
-- Additive only: every existing row keeps its meaning, and no row needs a backfill (nobody could have
-- chosen the new value before it existed). Rollback (docs/DEPLOY.md "Rollback"): the previous build
-- (R0) reads an unknown policy value as "not 'everyone'", so a row with the new value limits like
-- 'editors' there, which fails closed; R0 never writes the value.

ALTER TABLE board_export_policies DROP CONSTRAINT board_export_policies_policy_check;
ALTER TABLE board_export_policies
  ADD CONSTRAINT board_export_policies_policy_check
  CHECK (policy IN ('everyone', 'editors', 'everyone-including-guests'));
