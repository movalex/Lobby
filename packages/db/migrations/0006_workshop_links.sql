-- 0006_workshop_links (RETRO-04a): multi-use EDIT links for live workshops, plus what a multi-use
-- link replaced when it raised someone's existing grant. Shipped migrations are never edited.
--
-- A workshop link is a review link (invitations.multi_use, 0005) with role 'editor' and a short life:
-- at most 24 hours after it was created (default 3 h; managers can extend it an hour at a time up to
-- that cap). Review links keep their viewer/commenter roles and 30-day cap. Anyone who opens either
-- kind must sign in; the grants a link created end when it expires or is revoked with removal.

ALTER TABLE invitations DROP CONSTRAINT invitations_review_link_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_review_link_check CHECK (
  NOT multi_use
  OR (
    board_id IS NOT NULL
    AND redeemed_by IS NULL
    AND (
      (role IN ('viewer', 'commenter') AND expires_at <= created_at + interval '30 days')
      OR (role = 'editor' AND expires_at <= created_at + interval '24 hours')
    )
  )
);

-- The direct grant a person had on the board before a multi-use link RAISED it (e.g. a viewer who
-- joined the workshop through an edit link). When the link's access ends, their grant goes back to
-- this role instead of staying raised. NULL: the link created the grant (it is removed) or changed
-- nothing.
ALTER TABLE invitation_redemptions
  ADD COLUMN previous_role text CHECK (previous_role IS NULL OR previous_role IN ('viewer', 'commenter', 'editor'));
