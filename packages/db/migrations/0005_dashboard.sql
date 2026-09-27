-- 0005_dashboard (features phase, dashboard-share; docs/FEATURES-M2-CONTRACTS.md): starred boards,
-- access requests and multi-use review links. Shipped migrations are never edited.
-- Tenant rows carry workspace_id; composite foreign keys keep every row inside its board's workspace.

-- ---- starred boards (per user) ------------------------------------------------------------------

CREATE TABLE board_stars (
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  board_id text NOT NULL,
  workspace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, board_id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX board_stars_user_workspace_idx ON board_stars (user_id, workspace_id, created_at DESC);
CREATE INDEX board_stars_board_idx ON board_stars (board_id);

-- ---- access requests ----------------------------------------------------------------------------
-- A signed-in user asks a board's owners for a role (outsiders: any role; viewers/commenters: more
-- than they have). At most one pending request per (board, user); decided requests are kept.

CREATE TABLE access_requests (
  id text PRIMARY KEY CHECK (id ~ '^acr_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_requested text NOT NULL CHECK (role_requested IN ('editor', 'commenter', 'viewer')),
  message text CHECK (message IS NULL OR char_length(message) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- when the owners were last notified about this request (re-notification is rate limited)
  notified_at timestamptz,
  decided_by text REFERENCES users (id) ON DELETE SET NULL,
  decided_at timestamptz,
  role_granted text CHECK (role_granted IS NULL OR role_granted IN ('editor', 'commenter', 'viewer')),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'approved') = (role_granted IS NOT NULL))
);
CREATE UNIQUE INDEX access_requests_one_pending_idx ON access_requests (board_id, user_id)
  WHERE status = 'pending';
CREATE INDEX access_requests_board_idx ON access_requests (board_id, status, created_at DESC);
CREATE INDEX access_requests_user_idx ON access_requests (user_id, board_id, created_at DESC);

-- ---- review links (multi-use board invitations) --------------------------------------------------
-- A review link is an `invitations` row with multi_use = true: a board link for viewers or
-- commenters that anyone with the link can accept (after signing in) until it expires (at most 30
-- days after creation), is revoked, or reaches max_uses. It never hands out edit or ownership.

ALTER TABLE invitations
  ADD COLUMN multi_use boolean NOT NULL DEFAULT false,
  ADD COLUMN max_uses integer CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 10000),
  ADD COLUMN use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  -- when the grants created through this link were removed (link expired, or revoked with removal)
  ADD COLUMN swept_at timestamptz;

ALTER TABLE invitations ADD CONSTRAINT invitations_review_link_check CHECK (
  NOT multi_use
  OR (
    board_id IS NOT NULL
    AND role IN ('viewer', 'commenter')
    AND expires_at <= created_at + interval '30 days'
    AND redeemed_by IS NULL
  )
);
ALTER TABLE invitations ADD CONSTRAINT invitations_max_uses_review_only CHECK (multi_use OR max_uses IS NULL);
CREATE INDEX invitations_review_links_idx ON invitations (board_id, expires_at)
  WHERE multi_use AND swept_at IS NULL;

-- Who joined through which review link, and when (the moment their grant was created or raised).
CREATE TABLE invitation_redemptions (
  invitation_id text NOT NULL REFERENCES invitations (id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  redeemed_at timestamptz NOT NULL,
  PRIMARY KEY (invitation_id, user_id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES boards (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX invitation_redemptions_board_user_idx ON invitation_redemptions (board_id, user_id);

-- The milestone-1 accept route (POST /api/invitations/:token/accept) redeems a link by setting
-- redeemed_by/redeemed_at. For a review link this trigger turns that into a recorded use instead,
-- so the same link keeps working for the next person: the use is logged in invitation_redemptions,
-- redeemed_by stays NULL, and a link that reaches max_uses is closed (revoked_at) for newcomers.
CREATE FUNCTION draftroom_review_link_redeem() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  used_at timestamptz;
  uses integer;
BEGIN
  IF NOT OLD.multi_use OR NEW.redeemed_by IS NULL OR OLD.redeemed_by IS NOT NULL THEN
    RETURN NEW;
  END IF;
  used_at := COALESCE(NEW.redeemed_at, now());
  INSERT INTO invitation_redemptions (invitation_id, workspace_id, board_id, user_id, redeemed_at)
    VALUES (OLD.id, OLD.workspace_id, OLD.board_id, NEW.redeemed_by, used_at)
    ON CONFLICT (invitation_id, user_id) DO NOTHING;
  SELECT count(*)::int INTO uses FROM invitation_redemptions WHERE invitation_id = OLD.id;
  NEW.use_count := uses;
  NEW.redeemed_by := NULL;
  NEW.redeemed_at := NULL;
  IF OLD.max_uses IS NOT NULL AND uses >= OLD.max_uses AND NEW.revoked_at IS NULL THEN
    NEW.revoked_at := used_at;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER invitations_review_link_redeem
  BEFORE UPDATE OF redeemed_by ON invitations
  FOR EACH ROW EXECUTE FUNCTION draftroom_review_link_redeem();
