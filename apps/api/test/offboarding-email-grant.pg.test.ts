// A member removal against the same person being granted a board by email invitation (the `granted` mode
// of POST /api/boards/:bid/invitations/email), on a real Postgres. Set DRAFTROOM_TEST_DATABASE_URL to a
// database these tests may create and drop schemas in; skipped otherwise. The other paths that give access
// are in offboarding-races.pg.test.ts; this one needs the Clerk sign-in (the invitation is looked up through
// a fake Clerk Backend API, as in features/dashboard/email-invites.test.ts).
//
// The grant stops midway, right after its guest-membership step; the real removal then runs against it.
// Before wave E the step was ON CONFLICT DO NOTHING, which locks nothing: the removal ran in full between
// that step and the grant insert, and the grant landed afterwards, for someone who is no member any more
// (it gives nothing while they are none, but comes back to life if they ever join again).

import { EmailInviteResult, Me } from '@draftroom/contracts'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClerkAuthProvider } from '../src/auth/clerk.ts'
import { type Client, createBoard, createTestApi, ORIGIN, type TestApi } from './helpers.ts'
import { orphanGrants, pausingDb, waitedOrFinished } from './race-support.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL

// ---- the fake Clerk Backend API (users only: the granted mode looks one up and sends nothing) -------

interface FakeClerkUser {
  id: string
  emailAddresses: { emailAddress: string; verification: { status: string } | null }[]
}
const clerk = vi.hoisted(() => ({ users: [] as FakeClerkUser[] }))

vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({
    users: {
      getUserList: async (params: { emailAddress?: string[] }) => {
        const wanted = new Set((params.emailAddress ?? []).map((e) => e.toLowerCase()))
        const data = clerk.users.filter((u) =>
          u.emailAddresses.some((a) => wanted.has(a.emailAddress.toLowerCase())),
        )
        return { data, totalCount: data.length }
      },
    },
    invitations: { createInvitation: async () => ({ id: 'inv_clerk_fake', status: 'pending' }) },
  }),
}))

const CLERK_KEYS = { secretKey: 'sk_test_fake_secret_0123456789', publishableKey: 'pk_test_fake' }
type Person = 'alice' | 'bob'
const clerkIdOf = (p: Person) => `user_clerk_${p}`
// alice works at a creator domain (only creators hand out access); bob is a client
const clerkEmailOf = (p: Person) =>
  p === 'alice' ? 'lobby-test-alice@darkburn.com' : 'bob@client.example.test'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  clerk.users = []
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

async function world() {
  const base = await openTestDb()
  const paused = pausingDb(base)
  const api: TestApi = await createTestApi({
    db: paused.db,
    env: {
      AUTH_PROVIDER: 'clerk',
      CLERK_SECRET_KEY: CLERK_KEYS.secretKey,
      CLERK_PUBLISHABLE_KEY: CLERK_KEYS.publishableKey,
    },
    deps: {
      authProvider: createClerkAuthProvider({
        ...CLERK_KEYS,
        publicOrigin: ORIGIN,
        deps: {
          verify: async (token) => {
            const p = (['alice', 'bob'] as const).find((x) => token === `token-${x}`)
            if (!p) throw new Error('invalid')
            return { sub: clerkIdOf(p) }
          },
          profile: async (sub) => {
            const p = sub.replace('user_clerk_', '') as Person
            return {
              name: p.charAt(0).toUpperCase() + p.slice(1),
              avatarUrl: null,
              emails: [{ email: clerkEmailOf(p), isPrimary: true, strategy: 'email_code' }],
            }
          },
        },
      }),
    },
  })
  cleanup.push(async () => {
    await api.close()
    await base.close()
  })
  const signIn = async (p: Person): Promise<Client> => {
    const res = await api.anon('POST', '/api/auth/clerk/session', undefined, {
      authorization: `Bearer token-${p}`,
    })
    if (res.statusCode !== 200) throw new Error(`clerk sign-in ${p}: ${res.statusCode} ${res.body}`)
    const cookie = res.cookies.find((c) => c.name === 'dr_session')
    if (!cookie) throw new Error('no session cookie')
    const me = Me.parse(res.json())
    return {
      me,
      userId: me.user.id,
      personalWorkspaceId: me.workspaces.find((w) => w.role === 'owner')?.id ?? '',
      cookie: `dr_session=${cookie.value}`,
      req: (method, url, body, headers = {}) =>
        api.app.inject({
          method,
          url,
          ...(body === undefined ? {} : { payload: body as object }),
          headers: { origin: ORIGIN, cookie: `dr_session=${cookie.value}`, ...headers },
        }),
    }
  }
  const alice = await signIn('alice')
  const bob = await signIn('bob')
  clerk.users = [
    {
      id: clerkIdOf('bob'),
      emailAddresses: [{ emailAddress: 'bob@client.example.test', verification: { status: 'verified' } }],
    },
  ]
  return { api, paused, alice, bob }
}

describe.skipIf(!PG)(
  'removing a member while they are granted a board by email invitation (real Postgres)',
  () => {
    it('the removal waits for the grant (guest membership step done) and sweeps it: no grant outlives the membership', async () => {
      const w = await world()
      const wid = w.alice.personalWorkspaceId
      const boardA = await createBoard(w.alice, wid, 'Board A')
      const boardB = await createBoard(w.alice, wid, 'Board B')
      const invite = (board: string) =>
        w.alice.req('POST', `/api/boards/${board}/invitations/email`, {
          email: 'bob@client.example.test',
          role: 'editor',
        })

      // bob is a guest of alice's workspace through board A
      const first = await invite(boardA)
      expect(first.statusCode, first.body).toBe(200)
      expect(EmailInviteResult.parse(first.json())).toMatchObject({
        mode: 'granted',
        alreadyHadAccess: false,
      })

      // the second invitation (board B) stops after its guest-membership step; the removal runs against it
      const pause = w.paused.arm(/INSERT INTO workspace_members/, 'after')
      const granting = invite(boardB)
      const pid = await pause.reached
      const removing = w.alice.req('DELETE', `/api/workspaces/${wid}/members/${w.bob.userId}`)
      try {
        // the membership step locked the row, so the removal waits for the grant to commit
        expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
      } finally {
        pause.release()
      }
      const [removed, granted] = await Promise.all([removing, granting])
      expect(granted.statusCode, granted.body).toBe(200)
      expect(removed.statusCode, removed.body).toBe(200)
      expect(await orphanGrants(w.api.db, wid, w.bob.userId)).toEqual([])
      const left = await w.api.db.query(
        'SELECT board_id FROM board_members WHERE user_id = $1 AND board_id = ANY($2)',
        [w.bob.userId, [boardA, boardB]],
      )
      expect(left.rows).toEqual([])
      expect(
        await w.api.db.maybeOne('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
          wid,
          w.bob.userId,
        ]),
      ).toBeNull()
      const entry = await w.api.db.one<{ detail: { boardGrantsRemoved: number } }>(
        "SELECT detail FROM audit_events WHERE action = 'workspace.member.remove' ORDER BY id DESC LIMIT 1",
      )
      expect(entry.detail.boardGrantsRemoved).toBe(2)
    })
  },
)
