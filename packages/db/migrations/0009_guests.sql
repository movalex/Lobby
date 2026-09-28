-- 0009_guests (docs/WAVE3-CONTRACTS.md §2 guests): name-only guests. Shipped migrations are never edited.
--
-- A manager can let anyone with a review or workshop link (a multi-use invitation, 0005/0006) join with
-- just a name. Such a guest is a user with no sign-in identity (no `identities` row), a `guest`
-- membership in the link's workspace and a board grant at the link's role; they reach only the boards
-- they were granted through guest links (enforced in the api: apps/api/src/features/guests).
--
-- `guest_name` is the name exactly as typed (trimmed). `users.name` holds its display form, the name
-- followed by " (guest)", so every place that already shows `users.name` (cursor labels through the
-- sync ticket, the people list, comments and mentions, member lists, checkpoints) tells a guest from a
-- member without each of them knowing about guests. The CHECK below ties the two together: the marker
-- cannot be dropped or changed, and a guest has no @handle.

ALTER TABLE users
  ADD COLUMN kind text NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'guest')),
  ADD COLUMN guest_name text CHECK (
    guest_name IS NULL
    OR (
      char_length(guest_name) BETWEEN 1 AND 40
      AND guest_name = btrim(guest_name)
      AND guest_name !~ '[\x01-\x1f\x7f]'
    )
  );
ALTER TABLE users ADD CONSTRAINT users_guest_check CHECK (
  (kind = 'guest') = (guest_name IS NOT NULL)
  AND (kind <> 'guest' OR (name = guest_name || ' (guest)' AND handle IS NULL))
);
-- The guest sweep (sessions left without grants, grants left without sessions) starts from guests.
CREATE INDEX users_guests_idx ON users (id) WHERE kind = 'guest';

-- "Anyone with the link can join with just a name (no account)": off by default, multi-use links only.
ALTER TABLE invitations ADD COLUMN allow_guests boolean NOT NULL DEFAULT false;
ALTER TABLE invitations ADD CONSTRAINT invitations_allow_guests_check CHECK (NOT allow_guests OR multi_use);
