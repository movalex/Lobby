// Sign-in provider subject -> internal user, with auto-provisioning (first sign-in creates the user,
// its identity row and a personal workspace it owns).

import { newId, type Queryable } from '@draftroom/db'
import type { WorkspaceRole } from '@draftroom/permissions'
import type { SessionUser } from './session.ts'
import { toSessionUser } from './session.ts'

// Same palette and hash as the web client's colorForUser (apps/web/src/lib/identity.ts), so a dev
// user keeps the color milestone 0 gave them.
const USER_COLORS = ['#c2410c', '#1d4ed8', '#047857', '#7c3aed', '#be123c', '#0e7490', '#a16207', '#4d7c0f']

/** Deterministic presence color for a stable seed (dev handle or provider subject). */
export function colorFor(seed: string): string {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return USER_COLORS[(h >>> 0) % USER_COLORS.length] ?? '#1d4ed8'
}

export interface IdentityInput {
  provider: 'dev' | 'clerk'
  subject: string
  name: string
  handle: string | null
  avatarUrl: string | null
  /** Update name/avatar of an existing user from the provider profile. */
  refreshProfile: boolean
}

export interface ProvisionResult {
  user: SessionUser
  created: boolean
}

const personalWorkspaceName = (name: string) => `${name}'s workspace`.slice(0, 120)

export async function findOrCreateUser(
  tx: Queryable,
  input: IdentityInput,
  now: Date,
): Promise<ProvisionResult> {
  const existing = await tx.maybeOne<{ user_id: string }>(
    'SELECT user_id FROM identities WHERE provider = $1 AND subject = $2',
    [input.provider, input.subject],
  )
  if (existing) {
    const row = input.refreshProfile
      ? await tx.one<Parameters<typeof toSessionUser>[0]>(
          `UPDATE users SET name = $2, avatar_url = COALESCE($3, avatar_url) WHERE id = $1
           RETURNING id, name, handle, color, avatar_url`,
          [existing.user_id, input.name, input.avatarUrl],
        )
      : await tx.one<Parameters<typeof toSessionUser>[0]>(
          'SELECT id, name, handle, color, avatar_url FROM users WHERE id = $1',
          [existing.user_id],
        )
    return { user: toSessionUser(row), created: false }
  }

  const userId = newId('usr')
  const row = await tx.one<Parameters<typeof toSessionUser>[0]>(
    `INSERT INTO users (id, name, handle, color, avatar_url, created_at) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, handle, color, avatar_url`,
    [userId, input.name, input.handle, colorFor(input.handle ?? input.subject), input.avatarUrl, now],
  )
  // A concurrent first sign-in for the same subject makes this insert fail with a unique violation;
  // the caller retries the whole transaction once and then finds the identity.
  await tx.query('INSERT INTO identities (provider, subject, user_id, created_at) VALUES ($1, $2, $3, $4)', [
    input.provider,
    input.subject,
    userId,
    now,
  ])
  const workspaceId = newId('wsp')
  await tx.query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)', [
    workspaceId,
    personalWorkspaceName(input.name),
    userId,
    now,
  ])
  await tx.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)",
    [workspaceId, userId, now],
  )
  return { user: toSessionUser(row), created: true }
}

export interface MeWorkspace {
  id: string
  name: string
  role: WorkspaceRole
}

export async function listUserWorkspaces(db: Queryable, userId: string): Promise<MeWorkspace[]> {
  return (
    await db.query<MeWorkspace>(
      `SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 ORDER BY w.created_at, w.name, w.id`,
      [userId],
    )
  ).rows
}
