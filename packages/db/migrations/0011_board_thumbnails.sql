-- 0011_board_thumbnails (docs/WAVE3-CONTRACTS.md "thumbnails"): the dashboard card image of a board.
-- An editor's client renders the board (at most 480x300, WebP or PNG/JPEG) and uploads it; the bytes
-- live in the blob store under a key fully determined by the ids below, this row points at the current
-- one. A new upload writes a new blob, swaps this row, then deletes the previous blob. Shipped
-- migrations are never edited.

CREATE TABLE board_thumbnails (
  board_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  -- opaque, server-generated; a new one per accepted upload (the cache key and ETag)
  version text NOT NULL CHECK (version ~ '^[0-9a-f]{24}$'),
  blob_key text NOT NULL UNIQUE,
  -- the type the magic bytes showed (the upload's Content-Type had to agree)
  mime_type text NOT NULL CHECK (mime_type IN ('image/webp', 'image/png', 'image/jpeg')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 1024),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 1024),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 262144),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  updated_by text NOT NULL CHECK (updated_by ~ '^usr_[0-9A-Za-z]{10,40}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK (blob_key = 'thumbnails/' || workspace_id || '/' || board_id || '/' || version)
);
