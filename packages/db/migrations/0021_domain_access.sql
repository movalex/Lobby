-- 0021_domain_access (docs/DOMAIN-ACCESS-CONTRACTS.md §3.2): the verified sign-in addresses the creator
-- rule reads, the marker for personal workspaces, and single-use invitations locked to one address.
-- Every new column on an existing table is nullable, so an older build's INSERTs keep working. Nothing
-- here deletes a membership, a grant or a workspace.
-- Unreleased until the domain-access deploy: this file may still change before then. A local database
-- that applied an earlier version must be reset (the checksum guard refuses an edited migration).

-- Verified addresses only (never an unverified one, never a Clerk test-mode "+clerk_test" address), as
-- normalised by the api: printable ASCII, ASCII-lowercased. Nothing ever logs them.
CREATE TABLE user_emails (
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (
    email = lower(email)
    AND email !~ '[^!-~]'
    AND char_length(email) BETWEEN 3 AND 254
    AND email ~ '^[^@].*@[^@]+$'
    AND strpos(email, '+clerk_test') = 0
  ),
  -- the text after the LAST "@"
  domain text GENERATED ALWAYS AS (substring(email from '@([^@]+)$')) STORED,
  is_primary boolean NOT NULL DEFAULT false,
  -- the sign-in provider that reported it; only the active provider's rows count
  source text NOT NULL CHECK (source IN ('clerk', 'dev')),
  -- Clerk's verification strategy (e.g. from_oauth_google, email_code); null for dev. Recorded for a
  -- later per-strategy rule, not enforced yet (contracts doc §15).
  verification_strategy text CHECK (char_length(verification_strategy) BETWEEN 1 AND 100),
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, email)
);
CREATE INDEX user_emails_email_idx ON user_emails (email);
CREATE UNIQUE INDEX user_emails_one_primary_idx ON user_emails (user_id, source) WHERE is_primary;

-- When the stored addresses were last confirmed with the sign-in provider. NULL = never (every user who
-- existed before this migration): the next /api/me or gated action refreshes them.
ALTER TABLE users ADD COLUMN identity_checked_at timestamptz;

-- The one personal workspace a creator gets on first sign-in.
ALTER TABLE workspaces ADD COLUMN personal_of text REFERENCES users (id);
CREATE UNIQUE INDEX workspaces_personal_of_idx ON workspaces (personal_of) WHERE personal_of IS NOT NULL;
-- Backfill: before this migration only two code paths created workspaces, the personal one
-- (apps/api/src/auth/users.ts) and Dev Studio (apps/api/src/auth/dev.ts, a fixed id). Each user's
-- earliest workspace other than Dev Studio is their personal one.
UPDATE workspaces w SET personal_of = w.created_by
  FROM (SELECT DISTINCT ON (created_by) id FROM workspaces
         WHERE id <> 'wsp_DevStudio00000000000'
         ORDER BY created_by, created_at, id) pick
 WHERE w.id = pick.id;

-- Single-use invitations name the one address that may accept them (multi-use review, workshop and
-- guest links never do).
ALTER TABLE invitations ADD COLUMN invited_email text;
ALTER TABLE invitations ADD CONSTRAINT invitations_invited_email_check CHECK (
  invited_email IS NULL OR (
    invited_email = lower(invited_email)
    AND invited_email !~ '[^!-~]'
    AND char_length(invited_email) BETWEEN 3 AND 254
    AND invited_email ~ '^[^@].*@[^@]+$'
    AND strpos(invited_email, '+clerk_test') = 0
  )
);
ALTER TABLE invitations ADD CONSTRAINT invitations_invited_email_single_use CHECK (
  invited_email IS NULL OR NOT multi_use
);
-- D3: open single-use links bound to nobody cannot be locked to an address after the fact (the address
-- was never stored), so they end here. Redeemed, revoked, expired and multi-use rows are untouched.
UPDATE invitations SET revoked_at = now()
 WHERE NOT multi_use AND invited_email IS NULL AND redeemed_by IS NULL AND revoked_at IS NULL
   AND expires_at > now();
