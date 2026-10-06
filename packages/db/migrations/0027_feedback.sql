-- 0027_feedback (wave J5: the pilot's "Send feedback" button). Shipped migrations are never edited.
--
-- One table, `feedback`: what people typed into the board menu's or the account menu's feedback dialog.
-- Written by POST /api/feedback (apps/api/src/features/feedback), read by the inbox page (people named in
-- DRAFTROOM_FEEDBACK_ADMINS) and by GET /internal/feedback (the lead's triage tooling).
--
-- - user_id has no foreign key, like ai_usage: feedback outlives the account (a deleted or offboarded
--   person's report is still the team's), and a name-only guest's rows survive the guest sweep. user_name
--   is the display name when it was sent, user_kind says whether it came from an account or a guest.
-- - text is "What happened?" (1 to 4,000 characters, already cleaned of control and bidi characters by the
--   api), expected is "What did you expect?" (optional); both plain text, never rendered as HTML.
-- - context is the small block the dialog showed before sending (page path without a query string, board
--   id and title, user agent, viewport, build, the sender's clock): a JSON object capped at 4 KiB.
-- - status open/done, with who and when it last changed (status_by is a user id, no foreign key).
-- Additive: no existing table changes, and the previous build never touches this one.

CREATE TABLE feedback (
  id text PRIMARY KEY CHECK (id ~ '^fbk_[0-9A-Za-z]{10,40}$'),
  created_at timestamptz NOT NULL,
  user_id text NOT NULL,
  user_name text NOT NULL CHECK (char_length(user_name) BETWEEN 1 AND 200),
  user_kind text NOT NULL CHECK (user_kind IN ('account', 'guest')),
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 4096),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  expected text CHECK (expected IS NULL OR char_length(expected) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  status_at timestamptz,
  status_by text
);

-- The inbox: newest first (created_at, id is the keyset the list pages by), all or by status.
CREATE INDEX feedback_created_idx ON feedback (created_at DESC, id DESC);
CREATE INDEX feedback_status_created_idx ON feedback (status, created_at DESC, id DESC);
