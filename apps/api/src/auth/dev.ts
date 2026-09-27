// Development sign-in (docs/M1-CONTRACTS.md §5): anyone can become any handle, so this provider is
// only constructed when DRAFTROOM_DEV_AUTH=1 and never under NODE_ENV=production (see config.ts and
// createApiServer). Without it, POST /api/auth/dev/login does not exist (404).

import { DevLoginInput } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { parse } from '../errors.ts'
import type { AuthProvider } from './provider.ts'
import { findOrCreateUser } from './users.ts'

/** The shared workspace every dev user joins on first login (fixed id so logins can race safely). */
export const DEV_STUDIO_ID = 'wsp_DevStudio00000000000'
export const DEV_STUDIO_NAME = 'Dev Studio'

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
  return {
    id: 'dev',
    publicConfig: () => ({ providers: ['dev'] }),
    register(app, ctx) {
      app.post('/api/auth/dev/login', { config: { rateLimit: ctx.rateLimit } }, async (req, reply) => {
        const input = parse(DevLoginInput, req.body)
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
            },
            now,
          )
          if (created) await joinDevStudio(tx, user.id, now)
          return user
        })
      })
    },
  }
}
