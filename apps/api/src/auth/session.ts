// Cookie sessions (docs/M1-CONTRACTS.md §4): `dr_session` holds 32 random bytes; the database keeps
// only their sha256, so a leaked database (or log line) cannot be replayed as a cookie.

import { createHash, randomBytes } from 'node:crypto'
import type { Db, Queryable } from '@draftroom/db'
import type { FastifyReply, FastifyRequest } from 'fastify'

export const SESSION_COOKIE = 'dr_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface SessionUser {
  id: string
  name: string
  handle: string | null
  color: string
  avatarUrl: string | null
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
   */
  create(
    tx: Queryable,
    userId: string,
    opts?: { clerkSessionId?: string | null },
  ): Promise<{ token: string; expiresAt: Date }>
  /** The signed-in user for this request (cached per request), or null. */
  user(req: FastifyRequest): Promise<SessionUser | null>
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
  /** Called with the ids of sessions revoked through this store (after the revocation committed). */
  onRevoked(listener: (ids: readonly string[]) => void): () => void
  setCookie(reply: FastifyReply, token: string, expiresAt: Date): void
  clearCookie(reply: FastifyReply): void
}

/** Clerk session ids look like `sess_…`; anything else is not stored (the column has the same check). */
const CLERK_SESSION_RE = /^sess_[A-Za-z0-9]{1,120}$/
export const isClerkSessionId = (v: unknown): v is string => typeof v === 'string' && CLERK_SESSION_RE.test(v)

interface UserRow {
  id: string
  name: string
  handle: string | null
  color: string
  avatar_url: string | null
}

export const toSessionUser = (r: UserRow): SessionUser => ({
  id: r.id,
  name: r.name,
  handle: r.handle,
  color: r.color,
  avatarUrl: r.avatar_url,
})

export function createSessionStore(opts: { db: Db; secureCookies: boolean; now: () => Date }): SessionStore {
  const { db, now } = opts
  const cache = new WeakMap<FastifyRequest, Promise<SessionUser | null>>()

  const tokenOf = (req: FastifyRequest): string | null => {
    const value = req.cookies[SESSION_COOKIE]
    return isSecretToken(value) ? value : null
  }

  async function lookup(req: FastifyRequest): Promise<SessionUser | null> {
    const token = tokenOf(req)
    if (!token) return null
    const row = await db.maybeOne<UserRow>(
      `SELECT u.id, u.name, u.handle, u.color, u.avatar_url
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
      [sha256hex(token), now()],
    )
    return row ? toSessionUser(row) : null
  }

  const cookieBase = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: opts.secureCookies }

  const listeners = new Set<(ids: readonly string[]) => void>()
  const announce = (ids: readonly string[]) => {
    if (!ids.length) return
    for (const l of [...listeners]) {
      try {
        l(ids)
      } catch {
        // a listener's failure never undoes or hides a revocation
      }
    }
  }

  return {
    async create(tx, userId, createOpts = {}) {
      const token = newSecretToken()
      const createdAt = now()
      const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS)
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
    idOf(req) {
      const token = tokenOf(req)
      return token ? sha256hex(token) : null
    },
    async revoke(req) {
      const token = tokenOf(req)
      cache.delete(req)
      if (!token) return null
      const id = sha256hex(token)
      const r = await db.query<{ id_hash: string }>(
        'UPDATE sessions SET revoked_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL RETURNING id_hash',
        [id, now()],
      )
      announce(r.rows.map((x) => x.id_hash))
      return r.rows.length ? id : null
    },
    async revokeAll(userId) {
      const r = await db.query<{ id_hash: string }>(
        'UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id_hash',
        [userId, now()],
      )
      const ids = r.rows.map((x) => x.id_hash)
      announce(ids)
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
    onRevoked(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    setCookie(reply, token, expiresAt) {
      reply.setCookie(SESSION_COOKIE, token, {
        ...cookieBase,
        expires: expiresAt,
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      })
    },
    clearCookie(reply) {
      reply.clearCookie(SESSION_COOKIE, cookieBase)
    },
  }
}
