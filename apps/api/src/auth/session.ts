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
  create(tx: Queryable, userId: string): Promise<{ token: string; expiresAt: Date }>
  /** The signed-in user for this request (cached per request), or null. */
  user(req: FastifyRequest): Promise<SessionUser | null>
  revoke(req: FastifyRequest): Promise<void>
  setCookie(reply: FastifyReply, token: string, expiresAt: Date): void
  clearCookie(reply: FastifyReply): void
}

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

  return {
    async create(tx, userId) {
      const token = newSecretToken()
      const createdAt = now()
      const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS)
      await tx.query(
        'INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
        [sha256hex(token), userId, createdAt, expiresAt],
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
    async revoke(req) {
      const token = tokenOf(req)
      cache.delete(req)
      if (!token) return
      await db.query('UPDATE sessions SET revoked_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL', [
        sha256hex(token),
        now(),
      ])
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
