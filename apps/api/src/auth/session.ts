// Cookie sessions (docs/M1-CONTRACTS.md §4): `dr_session` holds 32 random bytes; the database keeps
// only their sha256, so a leaked database (or log line) cannot be replayed as a cookie.

import { createHash, randomBytes } from 'node:crypto'
import type { Db, Queryable } from '@draftroom/db'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { type CreatorLookup, NO_CREATORS, userColumns, userParams } from './creator-sql.ts'

export const SESSION_COOKIE = 'dr_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface SessionUser {
  id: string
  name: string
  handle: string | null
  color: string
  avatarUrl: string | null
  /** 'guest' for a name-only guest (0009_guests), 'account' for everyone who signed in with a provider. */
  kind: 'account' | 'guest'
  /**
   * Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §3.4): a creator right now, from the stored verified
   * addresses, the current policy and their freshness (creator-sql.ts). Never serialized.
   */
  creator: boolean
  /** When the stored addresses were last confirmed with the provider; null = never. */
  identityCheckedAt: Date | null
}

export const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex')
/** 32 random bytes, base64url: session cookie values and invitation link tokens. */
export const newSecretToken = () => randomBytes(32).toString('base64url')
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
export const isSecretToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN_RE.test(value)

export interface SessionStore {
  /**
   * `clerkSessionId`: the Clerk session (`sid`) this session was exchanged from (SCA-4), kept so a
   * sign-out everywhere can end it too (and, later, so Clerk webhooks can end ours).
   * `expiresAt`: an earlier end than the usual SESSION_TTL_MS (name-only guests: their link's expiry
   * or 7 days); never later than that.
   */
  create(
    tx: Queryable,
    userId: string,
    opts?: { clerkSessionId?: string | null; expiresAt?: Date },
  ): Promise<{ token: string; expiresAt: Date }>
  /** The signed-in user for this request (cached per request), or null. */
  user(req: FastifyRequest): Promise<SessionUser | null>
  /**
   * Looks the request's user up again and REPLACES the per-request cache entry (after an identity
   * refresh wrote new addresses, so the rest of the request decides on them).
   */
  reload(req: FastifyRequest): Promise<SessionUser | null>
  /**
   * The id of the session this request presents (sessions.id_hash: the sha256 of the cookie), or
   * null without a well-formed cookie. Says nothing about whether the session is valid.
   */
  idOf(req: FastifyRequest): string | null
  /** Revokes the request's session; resolves with its id when one was revoked. */
  revoke(req: FastifyRequest): Promise<string | null>
  /** Revokes every live session of a user (sign out everywhere); resolves with their ids. */
  revokeAll(userId: string): Promise<string[]>
  /** Of these session ids, the ones still valid (not revoked, not expired). */
  activeIds(ids: readonly string[]): Promise<Set<string>>
  /**
   * RT-01 (wave J3): when the user's oldest live session started (epoch ms), or null when they have
   * none (signed out everywhere, every session expired). The sync server's access re-check reads it
   * (GET /internal/access `signedInSince`): null closes the person's board sockets (NOT_AUTHENTICATED);
   * a socket whose ticket is older than every live session of its person came from a session that has
   * ended, and is sent to reconnect (its new ticket needs a live session).
   */
  signedInSince(userId: string): Promise<number | null>
  /**
   * Called with the ids of sessions revoked through this store (after the revocation committed) and,
   * RT-01, the users they belonged to when the store knows them (the sync server closes their board
   * sockets: auth/session-sync.ts).
   */
  onRevoked(listener: (ids: readonly string[], userIds: readonly string[]) => void): () => void
  /**
   * Tells the onRevoked listeners about sessions revoked inside a caller's own transaction (a guest's
   * sessions end with their last board grant: apps/api/src/features/guests). Call after it committed.
   * `userIds`: whose sessions they were (omitted: the listeners hear the ids only).
   */
  announceRevoked(ids: readonly string[], userIds?: readonly string[]): void
  setCookie(reply: FastifyReply, token: string, expiresAt: Date): void
  clearCookie(reply: FastifyReply): void
}

/** Clerk session ids look like `sess_…`; anything else is not stored (the column has the same check). */
const CLERK_SESSION_RE = /^sess_[A-Za-z0-9]{1,120}$/
export const isClerkSessionId = (v: unknown): v is string => typeof v === 'string' && CLERK_SESSION_RE.test(v)

/** A users row read through creator-sql.ts userColumns. */
export interface SessionUserRow {
  id: string
  name: string
  handle: string | null
  color: string
  avatar_url: string | null
  kind: string
  identity_checked_at: Date | null
  creator: boolean
}

export const toSessionUser = (r: SessionUserRow): SessionUser => ({
  id: r.id,
  name: r.name,
  handle: r.handle,
  color: r.color,
  avatarUrl: r.avatar_url,
  kind: r.kind === 'guest' ? 'guest' : 'account',
  creator: r.creator === true,
  identityCheckedAt: r.identity_checked_at,
})

export function createSessionStore(opts: {
  db: Db
  secureCookies: boolean
  now: () => Date
  /** Which stored addresses make a creator (the running provider and policy); default: nobody. */
  creators?: CreatorLookup
}): SessionStore {
  const { db, now } = opts
  const creators = opts.creators ?? NO_CREATORS
  const cache = new WeakMap<FastifyRequest, Promise<SessionUser | null>>()

  const tokenOf = (req: FastifyRequest): string | null => {
    const value = req.cookies[SESSION_COOKIE]
    return isSecretToken(value) ? value : null
  }

  async function lookup(req: FastifyRequest): Promise<SessionUser | null> {
    const token = tokenOf(req)
    if (!token) return null
    const at = now()
    const row = await db.maybeOne<SessionUserRow>(
      `SELECT ${userColumns(3)}
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
      [sha256hex(token), at, ...userParams(creators, at)],
    )
    return row ? toSessionUser(row) : null
  }

  const cookieBase = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: opts.secureCookies }

  const listeners = new Set<(ids: readonly string[], userIds: readonly string[]) => void>()
  const announce = (ids: readonly string[], userIds: readonly string[] = []) => {
    if (!ids.length) return
    const users = [...new Set(userIds)]
    for (const l of [...listeners]) {
      try {
        l(ids, users)
      } catch {
        // a listener's failure never undoes or hides a revocation
      }
    }
  }

  return {
    async create(tx, userId, createOpts = {}) {
      const token = newSecretToken()
      const createdAt = now()
      const longest = createdAt.getTime() + SESSION_TTL_MS
      const asked = createOpts.expiresAt?.getTime()
      // An earlier end only (and at least a second from now, for the sessions table's CHECK).
      const expiresAt = new Date(
        asked === undefined || !Number.isFinite(asked)
          ? longest
          : Math.max(createdAt.getTime() + 1_000, Math.min(asked, longest)),
      )
      const clerkSessionId = isClerkSessionId(createOpts.clerkSessionId) ? createOpts.clerkSessionId : null
      await tx.query(
        `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, clerk_session_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [sha256hex(token), userId, createdAt, expiresAt, clerkSessionId],
      )
      return { token, expiresAt }
    },
    user(req) {
      let p = cache.get(req)
      if (!p) {
        p = lookup(req)
        cache.set(req, p)
      }
      return p
    },
    reload(req) {
      const p = lookup(req)
      cache.set(req, p)
      return p
    },
    idOf(req) {
      const token = tokenOf(req)
      return token ? sha256hex(token) : null
    },
    async revoke(req) {
      const token = tokenOf(req)
      cache.delete(req)
      if (!token) return null
      const id = sha256hex(token)
      const r = await db.query<{ id_hash: string; user_id: string }>(
        'UPDATE sessions SET revoked_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL RETURNING id_hash, user_id',
        [id, now()],
      )
      announce(
        r.rows.map((x) => x.id_hash),
        r.rows.map((x) => x.user_id),
      )
      return r.rows.length ? id : null
    },
    async revokeAll(userId) {
      const r = await db.query<{ id_hash: string }>(
        'UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id_hash',
        [userId, now()],
      )
      const ids = r.rows.map((x) => x.id_hash)
      announce(ids, [userId])
      return ids
    },
    async activeIds(ids) {
      if (!ids.length) return new Set()
      const r = await db.query<{ id_hash: string }>(
        `SELECT id_hash FROM sessions
          WHERE id_hash = ANY($1::text[]) AND revoked_at IS NULL AND expires_at > $2`,
        [[...ids], now()],
      )
      return new Set(r.rows.map((x) => x.id_hash))
    },
    async signedInSince(userId) {
      // the oldest LIVE session (sessions_user_idx): a ticket older than it came from one that ended
      const row = await db.maybeOne<{ since: Date | null }>(
        `SELECT min(created_at) AS since FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
        [userId, now()],
      )
      return row?.since ? new Date(row.since).getTime() : null
    },
    onRevoked(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    announceRevoked(ids, userIds) {
      announce(ids, userIds)
    },
    setCookie(reply, token, expiresAt) {
      // The cookie ends with the session (a guest's session can be much shorter than 30 days).
      const seconds = Math.ceil((expiresAt.getTime() - now().getTime()) / 1000)
      reply.setCookie(SESSION_COOKIE, token, {
        ...cookieBase,
        expires: expiresAt,
        maxAge: Math.max(1, Math.min(seconds, Math.floor(SESSION_TTL_MS / 1000))),
      })
    },
    clearCookie(reply) {
      reply.clearCookie(SESSION_COOKIE, cookieBase)
    },
  }
}
