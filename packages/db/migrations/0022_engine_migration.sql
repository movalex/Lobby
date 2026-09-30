-- 0022_engine_migration (bridge release R0; docs/EXCALIDRAW-MIGRATION.md §5.5, §5.9, §5.10): what the
-- Excalidraw build writes about checkpoints and boards, added before the cut-over so that R0 (the last
-- tldraw build, and the rollback target) understands it. Additive only: every existing row keeps its
-- meaning and R0's own inserts need no change. Shipped migrations are never edited.
--
--   reason engine_migration   the automatic checkpoint the Excalidraw build takes of a board right after
--                             converting it, as a restore point (§5.5)
--   board_snapshots.body_version
--                             1: the stored body is the tldraw one (`draftroom-checkpoint` v1, every
--                             checkpoint made so far); 2: the Excalidraw one (`lobby-checkpoint` v2).
--                             R0 lists v2 checkpoints ("Made on the new canvas") and refuses to preview
--                             or restore them. The Excalidraw build writes 2 on every checkpoint it makes.
--   boards.new_canvas         the board was born on the new canvas (Excalidraw): R0 shows it with a
--                             "new canvas" badge and refuses to open, duplicate or export it. The
--                             Excalidraw build sets it on every board it creates (new, duplicate, restore
--                             as new, import, template); converted boards keep false.
ALTER TABLE board_snapshots DROP CONSTRAINT board_snapshots_reason_check;
ALTER TABLE board_snapshots ADD CONSTRAINT board_snapshots_reason_check
  CHECK (reason IN ('hourly', 'session_end', 'before_restore', 'import', 'before_reveal', 'before_ai_themes',
                    'engine_migration'));
ALTER TABLE board_snapshots
  ADD COLUMN body_version smallint NOT NULL DEFAULT 1 CHECK (body_version IN (1, 2));
ALTER TABLE boards ADD COLUMN new_canvas boolean NOT NULL DEFAULT false;
