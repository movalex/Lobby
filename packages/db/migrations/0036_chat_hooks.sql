-- 0036_chat_hooks (wave R foundation; docs/WAVE-R-CONTRACTS.md §4): notifications to Slack and Teams (WS2). Shipped
-- migrations are never edited.
--
-- - chat_hooks: a workspace's incoming-webhook URLs (one channel each). The URL is a secret: only its AES-256-GCM
--   sealed form is stored (apps/api/src/crypto/sealed.ts: 12-byte nonce, ciphertext, 16-byte tag; key from
--   DRAFTROOM_WEBHOOK_SECRET, key_id names which; AAD `workspaceId:hookId`), and `url_hint` is all that is ever shown.
-- - chat_hook_prefs: who sends which kinds to which hook (all off by default: no row, nothing sent). The row goes with
--   the person's workspace membership (a removal deletes it) and with its hook.
-- - chat_deliveries: the outbox, written in the same transaction as the notification it carries (unique per hook and
--   notification, so nothing is lost or sent twice), claimed FOR UPDATE SKIP LOCKED by the api's delivery loop, purged
--   after 14 days. A row holds no message text: the message is rendered from current rows at send time.
-- Additive (three new tables): rolling the api back needs no down migration, only DRAFTROOM_ALLOW_NEWER_SCHEMA=1.

CREATE TABLE chat_hooks (
  id text PRIMARY KEY CHECK (id ~ '^chk_[0-9A-Za-z]{10,40}$'),
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  provider text NOT NULL CHECK (provider IN ('slack', 'teams')),
  -- nonce (12) + ciphertext (≥ 1) + tag (16); a URL is at most 2,048 bytes
  url_sealed bytea NOT NULL CHECK (octet_length(url_sealed) BETWEEN 29 AND 2076),
  key_id text NOT NULL CHECK (key_id ~ '^k[0-9]{1,3}$'),
  url_hint text NOT NULL CHECK (char_length(url_hint) BETWEEN 1 AND 120),
  include_snippets boolean NOT NULL DEFAULT false,
  -- the admin who added it (kept when that account goes: the hook is the workspace's)
  created_by text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  disabled_reason text CHECK (disabled_reason IN ('forbidden', 'not-found', 'gone', 'retired')),
  last_ok_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[a-z0-9-]{1,32}$'),
  UNIQUE (workspace_id, id),
  CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);
CREATE INDEX chat_hooks_workspace_idx ON chat_hooks (workspace_id, created_at);

CREATE TABLE chat_hook_prefs (
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  hook_id text NOT NULL,
  -- the opt-in kinds (contracts chat-hooks.ts CHAT_HOOK_KINDS); an empty list sends nothing
  kinds text[] NOT NULL
    CHECK (kinds <@ ARRAY['mention', 'reply', 'new_comment', 'access_request', 'outsider_joined']::text[]),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hook_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members (workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, hook_id) REFERENCES chat_hooks (workspace_id, id) ON DELETE CASCADE
);
-- the outbox writer: the opted-in people of a hook
CREATE INDEX chat_hook_prefs_hook_idx ON chat_hook_prefs (hook_id);

CREATE TABLE chat_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hook_id text NOT NULL REFERENCES chat_hooks (id) ON DELETE CASCADE,
  notification_id text REFERENCES notifications (id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'dropped', 'coalesced')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  -- the last answer's code (`200`, `429`, `timeout`, `network`), never the receiver's words
  last_code text CHECK (last_code ~ '^[a-z0-9-]{1,32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (hook_id, notification_id),
  CHECK (status <> 'sending' OR lease_until IS NOT NULL),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX chat_deliveries_due_idx ON chat_deliveries (next_at) WHERE status = 'queued';
-- the per-recipient and per-workspace caps count recent sends
CREATE INDEX chat_deliveries_recipient_idx ON chat_deliveries (recipient_id, created_at);
-- the 14-day purge
CREATE INDEX chat_deliveries_created_idx ON chat_deliveries (created_at);
