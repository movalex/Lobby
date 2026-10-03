-- 0024_vote_selection_access_granted (wave B: RETRO-10, PRI-09b). Shipped migrations are never edited.
--
--   vote_sessions.scope 'selection'   a dot vote over what the facilitator selected: several frames (their
--                                     contents take votes, as in a frame vote) and/or single objects. The
--                                     list is `selection`, a JSON array of 1..200 object refs
--                                     (`shape:<id>`, like frame_id), set exactly when scope = 'selection'.
--   notifications.kind 'access_granted'
--                                     the requester's bell item when a board owner approves their access
--                                     request (actor = the approver). Like 'access_request' it has no
--                                     thread.
--
-- Additive: no existing row changes meaning and the previous build's queries and inserts still run (it
-- never writes the new values; `selection` is nullable). The API leaves both new values out of what it
-- answers a web build from before this migration (no `x-lobby-client` header, @draftroom/contracts
-- client-rev.ts): a selection vote reads as a board vote there, and access_granted items are not listed.
-- It must not run while a rollback to R0 is still possible: R0's api would serve the new values to R0's
-- web unchanged (docs/DEPLOY.md "Deploying").

ALTER TABLE vote_sessions DROP CONSTRAINT vote_sessions_scope_check;
ALTER TABLE vote_sessions ADD CONSTRAINT vote_sessions_scope_check
  CHECK (scope IN ('board', 'frame', 'selection'));
-- CASE, not AND: SQL does not promise to evaluate an AND left to right, and jsonb_array_length fails on a
-- scalar. Every element is a string matching the ref pattern of frame_id (and votes.shape_id).
ALTER TABLE vote_sessions
  ADD COLUMN selection jsonb CONSTRAINT vote_sessions_selection_check CHECK (
    selection IS NULL OR CASE
      WHEN jsonb_typeof(selection) = 'array' THEN
        jsonb_array_length(selection) BETWEEN 1 AND 200
        AND NOT jsonb_path_exists(
          selection,
          '$[*] ? (@.type() != "string" || !(@ like_regex "^shape:[A-Za-z0-9_-]{1,100}$"))'
        )
      ELSE false
    END
  );
ALTER TABLE vote_sessions ADD CONSTRAINT vote_sessions_selection_scope_check
  CHECK ((scope = 'selection') = (selection IS NOT NULL));

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('mention', 'reply', 'resolved', 'access_request', 'new_comment', 'access_granted'));
-- 0002's unnamed "access requests have no thread" rule (Postgres named it notifications_check).
ALTER TABLE notifications DROP CONSTRAINT notifications_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_check
  CHECK (kind IN ('access_request', 'access_granted') OR thread_id IS NOT NULL);
