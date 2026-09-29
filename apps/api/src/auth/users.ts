// Sign-in provider subject -> internal user, with auto-provisioning (first sign-in creates the user and
// its identity row), the verified addresses the provider reported (user_emails), and the personal
// workspace, which only creators get (docs/DOMAIN-ACCESS-CONTRACTS.md §3.3, §5).

import { DOMAIN_ACCESS_CODES, DOMAIN_ACCESS_MESSAGES } from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import type { WorkspaceRole } from '@draftroom/permissions'
import { ApiError } from '../errors.ts'
import { type CreatorLookup, type EmailSource, userColumns, userParams } from './creator-sql.ts'
import { normalizeEmail } from './creators.ts'
import type { SessionUser, SessionUserRow } from './session.ts'
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

/** One verified address a provider reported (Clerk profile, dev login). */
export interface ProfileEmail {
  email: string
  isPrimary: boolean
  strategy: string | null
}

/** At most this many addresses are stored per user and source. */
export const MAX_STORED_EMAILS = 20
const STRATEGY_RE = /^[a-z0-9_:.-]{1,100}$/

/**
 * Normalised (normalizeEmail: never non-ASCII, never "+clerk_test"), deduplicated, primary first,
 * exactly one primary when any, at most MAX_STORED_EMAILS; a strategy that is not a plain token is
 * stored as null. Every writer of user_emails goes through this.
 */
export function cleanProfileEmails(list: readonly ProfileEmail[]): ProfileEmail[] {
  const byEmail = new Map<string, ProfileEmail>()
  for (const item of list) {
    const email = normalizeEmail(item.email)
    if (email === null) continue
    const strategy =
      typeof item.strategy === 'string' && STRATEGY_RE.test(item.strategy) ? item.strategy : null
    const seen = byEmail.get(email)
    if (seen) {
      seen.isPrimary ||= item.isPrimary === true
      seen.strategy ??= strategy
    } else byEmail.set(email, { email, isPrimary: item.isPrimary === true, strategy })
  }
  const all = [...byEmail.values()]
  const primary = all.find((e) => e.isPrimary)
  const ordered = primary ? [primary, ...all.filter((e) => e !== primary)] : all
  return ordered
    .slice(0, MAX_STORED_EMAILS)
    .map((e, i) => ({ ...e, isPrimary: primary !== undefined && i === 0 }))
}

/**
 * Stores a snapshot of a user's verified addresses from `source` (docs/DOMAIN-ACCESS-CONTRACTS.md
 * §3.3). `fetchedAt` is ctx.now() read BEFORE the provider was asked: a snapshot older than the one
 * already stored (two sign-ins, or a sign-in and a refresh, racing) writes nothing. Idempotent (the
 * sign-in transaction is retried once on a unique violation). Resolves true when it wrote.
 */
export async function replaceUserEmails(
  tx: Queryable,
  userId: string,
  source: EmailSource,
  emails: readonly ProfileEmail[],
  fetchedAt: Date,
): Promise<boolean> {
  // `<=`, not `<`: two logins within one millisecond both write (the later one wins); an OLDER
  // snapshot never does (contracts doc §17, as built).
  const stamped = await tx.query<{ id: string }>(
    `UPDATE users SET identity_checked_at = $2
      WHERE id = $1 AND (identity_checked_at IS NULL OR identity_checked_at <= $2) RETURNING id`,
    [userId, fetchedAt],
  )
  if (!stamped.rows.length) return false
  await tx.query('DELETE FROM user_emails WHERE user_id = $1 AND source = $2', [userId, source])
  for (const e of cleanProfileEmails(emails))
    await tx.query(
      `INSERT INTO user_emails (user_id, email, is_primary, source, verification_strategy, seen_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, email) DO UPDATE SET is_primary = EXCLUDED.is_primary, source = EXCLUDED.source,
         verification_strategy = EXCLUDED.verification_strategy, seen_at = EXCLUDED.seen_at`,
      [userId, e.email, e.isPrimary, source, e.strategy, fetchedAt],
    )
  return true
}

/** Stamps identity_checked_at alone (a refresh with nothing to find), under the same fetch-time rule. */
export async function stampIdentityChecked(tx: Queryable, userId: string, fetchedAt: Date): Promise<void> {
  await tx.query(
    `UPDATE users SET identity_checked_at = $2
      WHERE id = $1 AND (identity_checked_at IS NULL OR identity_checked_at <= $2)`,
    [userId, fetchedAt],
  )
}

/** The user's stored addresses of `source`: primary first, then oldest first. Never logged. */
export async function storedEmails(q: Queryable, userId: string, source: EmailSource): Promise<string[]> {
  const rows = await q.query<{ email: string }>(
    `SELECT email FROM user_emails WHERE user_id = $1 AND source = $2
      ORDER BY is_primary DESC, seen_at, email`,
    [userId, source],
  )
  return rows.rows.map((r) => r.email)
}

/** A user as a SessionUser (kind, creator, freshness), read with `q` (a transaction or the pool). */
export async function loadSessionUser(
  q: Queryable,
  userId: string,
  creators: CreatorLookup,
  now: Date,
): Promise<SessionUser | null> {
  const row = await q.maybeOne<SessionUserRow>(`SELECT ${userColumns(2)} FROM users u WHERE u.id = $1`, [
    userId,
    ...userParams(creators, now),
  ])
  return row ? toSessionUser(row) : null
}

export interface IdentityInput {
  provider: EmailSource
  subject: string
  name: string
  handle: string | null
  avatarUrl: string | null
  /** Update name/avatar of an existing user from the provider profile. */
  refreshProfile: boolean
  /**
   * The provider's verified addresses (cleanProfileEmails applies), or null when the provider could
   * not be asked: an existing user keeps the stored ones (identity_checked_at is not bumped), and a
   * FIRST sign-in is refused with 503 IDENTITY_UNAVAILABLE (D9).
   */
  emails: readonly ProfileEmail[] | null
  /** ctx.now() read BEFORE the provider call started (replaceUserEmails). */
  fetchedAt: Date
}

export interface ProvisionResult {
  user: SessionUser
  created: boolean
}

export const identityUnavailable = () =>
  new ApiError(503, DOMAIN_ACCESS_CODES.identityUnavailable, DOMAIN_ACCESS_MESSAGES.identityUnavailable)

const personalWorkspaceName = (name: string) => `${name}'s workspace`.slice(0, 120)

/**
 * The creator's personal workspace (workspaces.personal_of), created with its owner membership when
 * there is none; a no-op otherwise (a single indexed read). Only ever called for creators: a
 * non-creator never gets one, and one they already have is kept (decision 4). Resolves true when it
 * created the workspace.
 */
export async function ensurePersonalWorkspace(
  tx: Queryable,
  userId: string,
  name: string,
  now: Date,
): Promise<boolean> {
  const existing = await tx.maybeOne('SELECT id FROM workspaces WHERE personal_of = $1', [userId])
  if (existing) return false
  const created = await tx.maybeOne<{ id: string }>(
    `INSERT INTO workspaces (id, name, created_by, created_at, personal_of) VALUES ($1, $2, $3, $4, $3)
     ON CONFLICT (personal_of) WHERE personal_of IS NOT NULL DO NOTHING RETURNING id`,
    [newId('wsp'), personalWorkspaceName(name), userId, now],
  )
  if (!created) return false
  await tx.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [created.id, userId, now],
  )
  return true
}

export async function findOrCreateUser(
  tx: Queryable,
  input: IdentityInput,
  now: Date,
  creators: CreatorLookup,
): Promise<ProvisionResult> {
  const existing = await tx.maybeOne<{ user_id: string }>(
    'SELECT user_id FROM identities WHERE provider = $1 AND subject = $2',
    [input.provider, input.subject],
  )
  let userId: string
  let created = false
  if (existing) {
    userId = existing.user_id
    if (input.refreshProfile)
      await tx.query('UPDATE users SET name = $2, avatar_url = COALESCE($3, avatar_url) WHERE id = $1', [
        userId,
        input.name,
        input.avatarUrl,
      ])
  } else {
    // D9: without the provider's addresses nobody can tell a creator from an outsider; creating the
    // user now would turn a provider blip into an outsider account.
    if (input.emails === null) throw identityUnavailable()
    userId = newId('usr')
    await tx.query(
      `INSERT INTO users (id, name, handle, color, avatar_url, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, input.name, input.handle, colorFor(input.handle ?? input.subject), input.avatarUrl, now],
    )
    // A concurrent first sign-in for the same subject makes this insert fail with a unique violation;
    // the caller retries the whole transaction once and then finds the identity.
    await tx.query(
      'INSERT INTO identities (provider, subject, user_id, created_at) VALUES ($1, $2, $3, $4)',
      [input.provider, input.subject, userId, now],
    )
    created = true
  }
  if (input.emails !== null)
    await replaceUserEmails(tx, userId, input.provider, input.emails, input.fetchedAt)
  let user = await loadSessionUser(tx, userId, creators, now)
  if (!user) throw new Error('provisioned user not found')
  if (user.creator && (await ensurePersonalWorkspace(tx, userId, user.name, now)))
    user = (await loadSessionUser(tx, userId, creators, now)) ?? user
  return { user, created }
}

/**
 * 'guest' for a name-only guest (0009_guests: no sign-in identity, only the boards of guest links),
 * 'account' for everyone who signed in with a provider. An unknown id reads as 'account'.
 */
export async function userKind(db: Queryable, userId: string): Promise<'account' | 'guest'> {
  const row = await db.maybeOne<{ kind: string }>('SELECT kind FROM users WHERE id = $1', [userId])
  return row?.kind === 'guest' ? 'guest' : 'account'
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
