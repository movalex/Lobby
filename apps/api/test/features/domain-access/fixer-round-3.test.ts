// Fixer round 3 (docs/DOMAIN-ACCESS-CONTRACTS.md §21):
// - a locked invitation to an address of the inviter's own account is refused (409 INVITATION_TO_SELF):
//   it would let only the inviter in, and accepting it used it up for nothing;
// - an invitation whose board is in the trash previews with `boardInTrash` and cannot be accepted
//   (409 BOARD_IN_TRASH, nothing redeemed, no grant); restoring the board makes it usable again while
//   it is still valid. Workspaces have no trash, so workspace invitations never say it.

import {
  BOARD_IN_TRASH,
  DOMAIN_ACCESS_MESSAGES,
  InvitationBoardState,
  InvitationEmailLock,
  InvitationGuestAccess,
  InvitationPreview,
} from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256hex } from '../../../src/auth/session.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from '../../helpers.ts'
import { type ClerkWorld, clerkUser, clerkWorld, fakeClerk } from './clerk-fake.ts'

vi.mock('@clerk/backend', async () => (await import('./clerk-fake.ts')).clerkBackendModule)

const Preview = InvitationPreview.extend(InvitationGuestAccess.shape)
  .extend(InvitationEmailLock.shape)
  .extend(InvitationBoardState.shape)
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)
const code = (res: LightMyRequestResponse) => (res.json() as { error?: { code?: string } }).error?.code
const DAY = 24 * 60 * 60 * 1000

async function redeemedBy(api: TestApi, token: string) {
  return (
    await api.db.one<{ redeemed_by: string | null }>(
      'SELECT redeemed_by FROM invitations WHERE token_hash = $1',
      [sha256hex(token)],
    )
  ).redeemed_by
}
const invitationCount = async (api: TestApi) =>
  (await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM invitations')).n

describe('a locked invitation to the inviter’s own address is refused (dev provider)', () => {
  let api: TestApi
  let alice: Client
  let board: string
  beforeEach(async () => {
    api = await createTestApi()
    alice = await api.login('alice')
    board = await createBoard(alice, DEV_STUDIO, 'Own address')
  })
  afterEach(() => api.close())

  it('board, workspace and email-route links to her own address: 409 INVITATION_TO_SELF, nothing created', async () => {
    const own = devEmail('alice')
    expect(alice.me.access.email).toBe(own)
    const attempts = [
      alice.req('POST', `/api/boards/${board}/invitations`, { role: 'viewer', email: own }),
      // Normalised like every address: case and spaces do not get around it.
      alice.req('POST', `/api/boards/${board}/invitations`, {
        role: 'editor',
        email: ` ${own.toUpperCase()} `,
      }),
      alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, { role: 'member', email: own }),
      alice.req('POST', `/api/boards/${board}/invitations/email`, { role: 'commenter', email: own }),
    ]
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json().error).toEqual({
        code: 'INVITATION_TO_SELF',
        message: DOMAIN_ACCESS_MESSAGES.invitationToSelf,
      })
    }
    expect(DOMAIN_ACCESS_MESSAGES.invitationToSelf).toMatch(/^That’s your own address\./)
    expect(await invitationCount(api)).toBe(0)
    expect(
      (
        await api.db.one<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_events WHERE action = 'invitation.create'",
        )
      ).n,
    ).toBe(0)
  })

  it('someone else’s address still works, and another creator may invite hers', async () => {
    expect(
      (
        await alice.req('POST', `/api/boards/${board}/invitations`, {
          role: 'viewer',
          email: devEmail('bob'),
        })
      ).statusCode,
    ).toBe(201)
    const bob = await api.login('bob')
    const bobs = await createBoard(bob, DEV_STUDIO, 'Bob’s')
    const res = await bob.req('POST', `/api/boards/${bobs}/invitations`, {
      role: 'viewer',
      email: devEmail('alice'),
    })
    expect(res.statusCode).toBe(201)
    expect(await invitationCount(api)).toBe(2)
  })
})

describe('a locked invitation to the inviter’s own address is refused (Clerk)', () => {
  let w: ClerkWorld
  afterEach(() => w.api.close())

  it('any verified address of the inviter counts (a secondary one too); an unverified one does not', async () => {
    fakeClerk.reset()
    w = await clerkWorld()
    clerkUser(
      'user_alice',
      [
        'lobby-test-alice@darkburn.com',
        'alice.home@personal.example.test',
        { email: 'alice.old@personal.example.test', status: 'unverified' },
      ],
      { name: 'Alice' },
    )
    const alice = await w.signIn('user_alice')
    const board = await createBoard(alice, alice.personalWorkspaceId, 'Pitch')
    for (const email of ['lobby-test-alice@darkburn.com', 'Alice.Home@Personal.Example.Test']) {
      const res = await alice.req('POST', `/api/boards/${board}/invitations`, { role: 'viewer', email })
      expect(res.statusCode, email).toBe(409)
      expect(code(res)).toBe('INVITATION_TO_SELF')
    }
    // Not one of her verified addresses: a normal locked link.
    const other = await alice.req('POST', `/api/boards/${board}/invitations`, {
      role: 'viewer',
      email: 'alice.old@personal.example.test',
    })
    expect(other.statusCode).toBe(201)
  })
})

describe('an invitation to a board in the trash', () => {
  let api: TestApi
  let alice: Client
  let board: string
  const patEmail = 'pat@client.example.test'
  beforeEach(async () => {
    api = await createTestApi()
    alice = await api.login('alice')
    board = await createBoard(alice, DEV_STUDIO, 'Trashed pitch')
  })
  afterEach(() => api.close())

  const lockedLink = async (role = 'commenter') => {
    const res = await alice.req('POST', `/api/boards/${board}/invitations`, { role, email: patEmail })
    expect(res.statusCode, res.body).toBe(201)
    return tokenOf(res.json().url)
  }
  const preview = async (token: string, c?: Client) => {
    const res = c
      ? await c.req('GET', `/api/invitations/${token}`)
      : await api.anon('GET', `/api/invitations/${token}`)
    expect(res.statusCode, res.body).toBe(200)
    return Preview.parse(res.json())
  }
  const trash = async () =>
    expect((await alice.req('POST', `/api/boards/${board}/trash`)).statusCode).toBe(200)
  const restore = async () =>
    expect((await alice.req('POST', `/api/boards/${board}/restore`)).statusCode).toBe(200)

  it('previews say so; accepting is 409 BOARD_IN_TRASH with no grant and the link unused; after a restore it works', async () => {
    const token = await lockedLink()
    const pat = await api.login('pat', 'Pat Client', { email: patEmail })
    expect((await preview(token)).boardInTrash).toBe(false)
    await trash()
    // Everyone who holds the link is told, signed out, the invitee and the inviter alike.
    for (const c of [undefined, pat, alice]) {
      const p = await preview(token, c)
      expect(p).toMatchObject({ boardInTrash: true, board: { id: board, title: 'Trashed pitch' } })
    }
    const res = await pat.req('POST', `/api/invitations/${token}/accept`)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toEqual(BOARD_IN_TRASH)
    expect(await redeemedBy(api, token)).toBeNull()
    const grants = await api.db.one<{ board: number; ws: number }>(
      `SELECT (SELECT count(*)::int FROM board_members WHERE board_id = $1 AND user_id = $2) AS board,
              (SELECT count(*)::int FROM workspace_members WHERE workspace_id = $3 AND user_id = $2) AS ws`,
      [board, pat.userId, DEV_STUDIO],
    )
    expect(grants).toEqual({ board: 0, ws: 0 })
    expect(
      (
        await api.db.one<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_events WHERE action = 'invitation.accept'",
        )
      ).n,
    ).toBe(0)
    await restore()
    expect((await preview(token, pat)).boardInTrash).toBe(false)
    expect((await alice.req('GET', `/api/boards/${board}/invitations`)).json().invitations).toEqual([
      expect.objectContaining({ kind: 'invite', email: patEmail, uses: 0 }),
    ])
    expect((await pat.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    expect((await pat.req('GET', `/api/boards/${board}`)).json().role).toBe('commenter')
  })

  it('a wrong account is refused the same way (the board state comes first); nothing is redeemed', async () => {
    const token = await lockedLink()
    const sam = await api.login('sam', 'Sam Client', { email: 'sam@client.example.test' })
    await trash()
    const res = await sam.req('POST', `/api/invitations/${token}/accept`)
    expect(res.statusCode).toBe(409)
    expect(code(res)).toBe('BOARD_IN_TRASH')
    expect(await redeemedBy(api, token)).toBeNull()
  })

  it('a restore does not bring back an expired link: 410', async () => {
    const token = await lockedLink()
    await trash()
    api.clock.advance(8 * DAY)
    await restore()
    const pat = await api.login('pat', 'Pat Client', { email: patEmail })
    expect((await api.anon('GET', `/api/invitations/${token}`)).statusCode).toBe(410)
    const res = await pat.req('POST', `/api/invitations/${token}/accept`)
    expect(res.statusCode).toBe(410)
    expect(await redeemedBy(api, token)).toBeNull()
  })

  it('an account accepting a multi-use review link of a trashed board is refused too', async () => {
    const link = (
      await alice.req('POST', `/api/boards/${board}/review-links`, { role: 'viewer' })
    ).json() as {
      url: string
    }
    const token = tokenOf(link.url)
    const bob = await api.login('bob')
    await trash()
    expect((await preview(token, bob)).boardInTrash).toBe(true)
    const res = await bob.req('POST', `/api/invitations/${token}/accept`)
    expect(res.statusCode).toBe(409)
    expect(code(res)).toBe('BOARD_IN_TRASH')
    await restore()
    expect((await bob.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
  })

  it('an archived board is not in the trash: its invitation still works (read-only, as before)', async () => {
    const token = await lockedLink()
    const pat = await api.login('pat', 'Pat Client', { email: patEmail })
    expect((await alice.req('POST', `/api/boards/${board}/archive`)).statusCode).toBe(200)
    expect((await preview(token, pat)).boardInTrash).toBe(false)
    expect((await pat.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
  })

  it('workspace invitations have no board, so they never say it', async () => {
    const res = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
      role: 'member',
      email: patEmail,
    })
    const token = tokenOf(res.json().url)
    await trash() // another board of the workspace
    expect(await preview(token)).toMatchObject({ board: null, boardInTrash: false })
  })
})
