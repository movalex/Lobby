-- 0032_board_links (wave N, PWR-10 links between boards; landed by the wave N foundation, owner WS7). Shipped
-- migrations are never edited.
--
-- Derived data, like the search index (0015): which element of which board links to which board (a board card, or
-- any element whose `link` is a Lobby-relative /b/<id>[?el=<id>] path), taken from the sync's read-only text route
-- (`?links=1`) by the search indexer on its schedule, a board's rows replaced in one transaction. It can be dropped
-- and rebuilt from the boards. Nothing here decides access: GET /api/boards/:bid/backlinks filters the from-boards
-- by the caller's permissions at query time (search's scope: viewable, not trashed, workspace membership).
--
-- - board_links: one row per (from_board, from_element, to_board); to_element is the `?el=` target or NULL. Both
--   boards cascade, so a board deleted for good takes its links out and in (a link to a board that does not exist
--   is not indexed: the indexer skips it). board_links_to_idx answers "linked from" for a board.
-- - board_link_scans: the boards whose links were indexed at least once, and at which sync clock. The one-time
--   backfill fetches the boards without a row WITHOUT `since` (the indexer's `unchanged` short-cut would otherwise
--   skip a board whose text did not change since wave M); an older sync's answer without `links` writes no row
--   and keeps the board's links as they are.
-- Additive: no existing table changes, and the previous build never reads or writes these, so rolling the api back
-- needs no down migration, only DRAFTROOM_ALLOW_NEWER_SCHEMA=1 and a "Deploy a specific commit" (docs/DEPLOY.md).

CREATE TABLE board_links (
  from_board text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  from_element text NOT NULL CHECK (char_length(from_element) BETWEEN 1 AND 120),
  to_board text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  to_element text CHECK (to_element IS NULL OR char_length(to_element) BETWEEN 1 AND 120),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_board, from_element, to_board)
);

CREATE INDEX board_links_to_idx ON board_links (to_board, from_board);

CREATE TABLE board_link_scans (
  board_id text PRIMARY KEY REFERENCES boards (id) ON DELETE CASCADE,
  -- the sync's document clock of the scanned text answer
  links_clock bigint NOT NULL CHECK (links_clock >= 0),
  scanned_at timestamptz NOT NULL DEFAULT now()
);
