-- 0008_session_revocation (docs/SECURITY-REVIEW-2026-09-27.md SCA-4 and FC-1). Shipped migrations are
-- never edited.

-- SCA-4: the Clerk session (`sid` claim) a dr_session was exchanged from. "Sign out everywhere" uses it
-- to end the Clerk sessions too, and Clerk webhooks (session.revoked / session.ended, future work) can
-- end exactly the dr_sessions that came from a revoked Clerk session. NULL for dev sign-in and for
-- sessions created before this migration.
ALTER TABLE sessions ADD COLUMN clerk_session_id text
  CHECK (clerk_session_id IS NULL OR clerk_session_id ~ '^sess_[A-Za-z0-9]{1,120}$');
CREATE INDEX sessions_clerk_session_idx ON sessions (clerk_session_id) WHERE clerk_session_id IS NOT NULL;

-- FC-1: every upload sums its workspace's stored originals (the per-workspace quota).
CREATE INDEX asset_versions_workspace_idx ON asset_versions (workspace_id);
