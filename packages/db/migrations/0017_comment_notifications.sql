-- 0017_comment_notifications (DANA-02): a board's owners hear about every new comment thread on it, so a
-- client's (or anyone's) first comment lands in the owner's bell and on the dashboard card. Shipped
-- migrations are never edited.
--
-- Only the kind list widens ('new_comment'); no column or row changes. Recipients, the author exclusion,
-- the view check and the per-author flood cap live in apps/api/src/features/comments. Additive for an
-- older build (DRAFTROOM_ALLOW_NEWER_SCHEMA): its queries still run; its bell just cannot label the rows.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('mention', 'reply', 'resolved', 'access_request', 'new_comment'));
