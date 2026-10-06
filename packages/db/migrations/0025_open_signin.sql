-- 0025_open_signin (docs/OPEN-SIGNIN.md). Shipped migrations are never edited.
--
--   identities.provider 'email'   open email sign-in (AUTH_PROVIDER=email): the subject is the address a
--                                 person typed, never verified. Only a server started with
--                                 DRAFTROOM_OPEN_SIGNIN=1 writes it.
--   user_emails.source 'email'    that typed address. Only the RUNNING provider's rows count for domain
--                                 access (creator-sql.ts), so these rows never make anyone a creator on
--                                 a Clerk server.
--   boards.external_ref           a partner app's stable key for one board (e.g. `theaitre:production:42`),
--                                 unique per workspace; null for every board people create themselves.
--
-- Additive: no existing row changes meaning, and the previous build's queries and inserts still run (it
-- never writes the new values; external_ref is nullable and no SELECT * reads boards).

ALTER TABLE identities DROP CONSTRAINT identities_provider_check;
ALTER TABLE identities ADD CONSTRAINT identities_provider_check
  CHECK (provider IN ('dev', 'clerk', 'email'));

ALTER TABLE user_emails DROP CONSTRAINT user_emails_source_check;
ALTER TABLE user_emails ADD CONSTRAINT user_emails_source_check
  CHECK (source IN ('clerk', 'dev', 'email'));

ALTER TABLE boards
  ADD COLUMN external_ref text CONSTRAINT boards_external_ref_check
    CHECK (external_ref ~ '^[a-z0-9][a-z0-9:._-]{0,119}$');
CREATE UNIQUE INDEX boards_external_ref_idx ON boards (workspace_id, external_ref)
  WHERE external_ref IS NOT NULL;
