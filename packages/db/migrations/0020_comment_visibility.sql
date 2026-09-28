-- 0020_comment_visibility (comment-privacy, F10): a thread is seen by 'everyone' who can view the board,
-- or only by the 'team' (workspace owners, admins and members with an account). Name-only guests and
-- workspace guests (review-link visitors) never receive a team thread, its comments, mentions,
-- notifications, pins, counts, events or search hits; the API enforces it on every route.
-- Existing threads keep 'everyone'. Shipped migrations are never edited.
ALTER TABLE comment_threads
  ADD COLUMN visibility text NOT NULL DEFAULT 'everyone' CHECK (visibility IN ('everyone', 'team'));
