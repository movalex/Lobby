// Session routes shared by every sign-in provider: config, me, logout.

import type { Me } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import type { AuthProvider } from '../auth/provider.ts'
import { listUserWorkspaces } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import { sessionUserToUser } from '../serialize.ts'

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, provider: AuthProvider): void {
  const { db, sessions } = ctx

  app.get('/api/auth/config', async () => provider.publicConfig())

  app.get('/api/me', async (req): Promise<Me> => {
    const user = await ctx.requireUser(req)
    return { user: sessionUserToUser(user), workspaces: await listUserWorkspaces(db, user.id) }
  })

  // Always 204, signed in or not: logging out twice (or from a stale tab) is not an error.
  app.post('/api/auth/logout', { config: { rateLimit: ctx.authRateLimit } }, async (req, reply) => {
    await sessions.revoke(req)
    sessions.clearCookie(reply)
    return reply.code(204).send()
  })
}
