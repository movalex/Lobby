-- 0026_outside_markers (wave J, J1: markers for people outside Dark Burn Creative and Trailer Park Group;
-- owner decisions 2026-10-05). Shipped migrations are never edited.
--
--   workspaces.internal_only, projects.internal_only
--       "Internal only": while true, the api refuses invitations to an outside address, approving an
--       outside account's access request, giving an outside account a grant or a higher role, and
--       creating review, workshop or guest links, in that workspace (every board) or project (its
--       boards): 409 INTERNAL_ONLY. Default false: sharing outside stays allowed until an owner or
--       admin turns it on. Turning it on removes nothing; the outside access that remains is listed for
--       the owners to remove.
--   notifications.kind 'outsider_joined'
--       a board owner's bell item the first time an account outside Dark Burn / TPG (the actor) opens
--       one of their boards. Like 'access_request' and 'access_granted' it has no thread.
--   notifications_outsider_joined_idx
--       whether a board already told its owners about that person (once per board and person).
--
-- Additive: no existing row changes meaning, the new columns have constant defaults (an older build's
-- INSERTs leave them false), and the previous build's queries and inserts still run (it never writes
-- the new kind). The api lists 'outsider_joined' only to a web build that declares LOBBY_CLIENT_REV >= 2
-- (@draftroom/contracts client-rev.ts). Rollback of the api to a build before 0026: that build lists
-- every kind it finds, and the web of its time cannot parse 'outsider_joined' (its whole bell would stop
-- updating), so run `DELETE FROM notifications WHERE kind = 'outsider_joined'` first; it also ignores
-- internal_only (outside sharing is then allowed again until the roll-forward).

ALTER TABLE workspaces ADD COLUMN internal_only boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN internal_only boolean NOT NULL DEFAULT false;

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('mention', 'reply', 'resolved', 'access_request', 'new_comment', 'access_granted',
                  'outsider_joined'));
ALTER TABLE notifications DROP CONSTRAINT notifications_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_check
  CHECK (kind IN ('access_request', 'access_granted', 'outsider_joined') OR thread_id IS NOT NULL);

CREATE INDEX notifications_outsider_joined_idx ON notifications (board_id, actor_id)
  WHERE kind = 'outsider_joined';
