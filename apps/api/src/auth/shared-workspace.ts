// Open email sign-in (docs/OPEN-SIGNIN.md): the one workspace everybody on the server shares. Every
// email sign-in joins it as a member; partner boards (routes/partner.ts) are created in it.
//
// It is owned by a built-in account with no sign-in identity, so nobody can sign in as its owner and
// nobody who signs in can trash or re-share the partner boards it owns. Fixed ids, so concurrent first
// sign-ins and partner calls create it exactly once.

import type { Queryable } from '@draftroom/db'

export const SHARED_WORKSPACE_ID = 'wsp_SharedLobby000000000'
export const SHARED_OWNER_ID = 'usr_SharedLobbyOwner0000'
const SHARED_OWNER_COLOR = '#4d7c0f'

/**
 * Creates the shared workspace and its owner when missing, and keeps both named `name` (the
 * DRAFTROOM_SHARED_WORKSPACE_NAME of the running server). Idempotent.
 */
export async function ensureSharedWorkspace(tx: Queryable, name: string, now: Date): Promise<void> {
  await tx.query(
    `INSERT INTO users (id, name, handle, color, avatar_url, created_at) VALUES ($1, $2, NULL, $3, NULL, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name WHERE users.name <> EXCLUDED.name`,
    [SHARED_OWNER_ID, name, SHARED_OWNER_COLOR, now],
  )
  await tx.query(
    `INSERT INTO workspaces (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name WHERE workspaces.name <> EXCLUDED.name`,
    [SHARED_WORKSPACE_ID, name, SHARED_OWNER_ID, now],
  )
  await tx.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [SHARED_WORKSPACE_ID, SHARED_OWNER_ID, now],
  )
}

/** `userId` joins the shared workspace as a member (a no-op when they already have any role there). */
export async function joinSharedWorkspace(
  tx: Queryable,
  name: string,
  userId: string,
  now: Date,
): Promise<void> {
  await ensureSharedWorkspace(tx, name, now)
  await tx.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [SHARED_WORKSPACE_ID, userId, now],
  )
}
