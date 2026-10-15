-- 0034_library_place (wave Q review fixes; docs/WAVE-Q-CONTRACTS.md §9). Shipped migrations are never edited.
--
-- - library_place_pending: one row for each board_asset_links row that POST …/library/items/:id/place CREATED (never
--   one that existed before). The client confirms after its push of the item's elements succeeded (POST …/place/confirm),
--   which deletes the rows; the hourly sweep (apps/api/src/features/library/purge.ts) removes the links whose row is
--   older than an hour and that the board does not show (sync's asset refs: its canvas or "Recently deleted"), so a
--   place that was never pushed leaves no permanent link. The row goes with its link (a board's delete cascades).
-- - library_items.source_export_limited: the source board's export policy at save time ('editors': copying limited to
--   its editors). While the source board exists, /place reads its policy again; once it is gone, an item saved under a
--   limit is placed only by the person who saved it.
-- Additive (a new table, a column with a default): rolling the api back needs no down migration, only
-- DRAFTROOM_ALLOW_NEWER_SCHEMA=1 and a "Deploy a specific commit" (docs/DEPLOY.md).

CREATE TABLE library_place_pending (
  board_id text NOT NULL,
  asset_id text NOT NULL,
  version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, asset_id, version_id),
  FOREIGN KEY (board_id, asset_id, version_id)
    REFERENCES board_asset_links (board_id, asset_id, version_id) ON DELETE CASCADE
);
-- the sweep: the oldest first
CREATE INDEX library_place_pending_age_idx ON library_place_pending (created_at);

ALTER TABLE library_items ADD COLUMN source_export_limited boolean NOT NULL DEFAULT false;
