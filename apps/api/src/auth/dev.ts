// Development sign-in (docs/M1-CONTRACTS.md §5): anyone can become any handle, so this provider is
// only constructed when DRAFTROOM_DEV_AUTH=1 and never under NODE_ENV=production (see config.ts and
// createApiServer). Without it, POST /api/auth/dev/login does not exist (404).
//
// Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §3.3, D8): the optional `email` is trusted as
// verified, by this dev-guarded route only. Without one the account gets `<handle>@dev.invalid`, a
// creator domain only while the api runs this provider. Every login replaces the previous dev
// addresses. Dev Studio is joined only by new dev users who are creators.

import { DevLoginInput } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { parse } from '../errors.ts'
import { DEV_CREATOR_DOMAIN } from './creators.ts'
import type { AuthProvider } from './provider.ts'
import { findOrCreateUser, replaceUserEmails, stampIdentityChecked } from './users.ts'

/** The shared workspace every dev user joins on first login (fixed id so logins can race safely). */
export const DEV_STUDIO_ID = 'wsp_DevStudio00000000000'
export const DEV_STUDIO_NAME = 'Dev Studio'

/** The synthetic address of a dev sign-in without an email (D8). `.invalid` can never be a real address. */
export const devEmail = (handle: string) => `${handle}@${DEV_CREATOR_DOMAIN}`

async function joinDevStudio(tx: Queryable, userId: string, now: Date): Promise<void> {
  await tx.query(
    'INSERT INTO workspaces (id, name, created_by, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
    [DEV_STUDIO_ID, DEV_STUDIO_NAME, userId, now],
  )
  // Lock the workspace row so two concurrent first logins cannot both become its first (owner) member.
  await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [DEV_STUDIO_ID])
  await tx.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
     SELECT $1, $2, CASE WHEN EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = $1)
                         THEN 'member' ELSE 'owner' END, $3
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [DEV_STUDIO_ID, userId, now],
  )
}

export function createDevAuthProvider(): AuthProvider {
  let clock: () => Date = () => new Date()
  return {
    id: 'dev',
    publicConfig: () => ({ providers: ['dev'] }),
    register(app, ctx) {
      clock = ctx.now
      app.post('/api/auth/dev/login', { config: { rateLimit: ctx.rateLimit } }, async (req, reply) => {
        const input = parse(DevLoginInput, req.body)
        const email = input.email ?? devEmail(input.handle)
        return ctx.signIn(req, reply, async (tx, now) => {
          const { user, created } = await findOrCreateUser(
            tx,
            {
              provider: 'dev',
              subject: input.handle,
              name: input.name ?? input.handle,
              handle: input.handle,
              avatarUrl: null,
              refreshProfile: input.name !== undefined,
              emails: [{ email, isPrimary: true, strategy: null }],
              fetchedAt: now,
              // Not a remote snapshot: the address this login was just given replaces the stored one.
              authoritative: true,
            },
            now,
            ctx.creators,
          )
          if (created && user.creator) await joinDevStudio(tx, user.id, now)
          return user
        })
      })
    },
    // Never a network call. Always stamps identity_checked_at, so dev users never turn 'unconfirmed'
    // (tests advance the clock). A dev user from before migration 0021 (no dev address stored) gets
    // `<handle>@dev.invalid`.
    async refreshIdentity(db, userId, fetchedAt) {
      await db.transaction(async (tx) => {
        const stored = await tx.maybeOne(
          "SELECT 1 AS ok FROM user_emails WHERE user_id = $1 AND source = 'dev' LIMIT 1",
          [userId],
        )
        if (!stored) {
          const identity = await tx.maybeOne<{ subject: string }>(
            "SELECT subject FROM identities WHERE provider = 'dev' AND user_id = $1 ORDER BY subject LIMIT 1",
            [userId],
          )
          if (identity) {
            await replaceUserEmails(
              tx,
              userId,
              'dev',
              [{ email: devEmail(identity.subject), isPrimary: true, strategy: null }],
              fetchedAt,
              { now: clock() },
            )
            return
          }
        }
        await stampIdentityChecked(tx, userId, fetchedAt, { now: clock() })
      })
      return 'ok'
    },
  }
}
