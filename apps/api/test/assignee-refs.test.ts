// Wave T (docs/WAVE-T-CONTRACTS.md §5): POST /internal/boards/:bid/assignee-refs, the room's check that a card's
// assignee (`card:who`) is an ACCOUNT with a role on the board. Server to server behind the internal secret; the
// answer lists exactly the asked uids that qualify, so it is no existence oracle; a trashed or unknown board is 404.
// On PGlite (the route is two queries over tables every api test has).

import { ASSIGNEE_REFS_MAX_UIDS, AssigneeRefsAnswer, assigneeRefsPath } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { guestLink, joinAsGuest } from './features/guests/support.ts'
import {
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
  TICKET_SECRET,
} from './helpers.ts'

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

const SECRET_HEADER = 'x-draftroom-internal'

function refs(
  a: TestApi,
  boardId: string,
  body: unknown,
  headers: Record<string, string> = { [SECRET_HEADER]: INTERNAL_SECRET },
) {
  return a.app.inject({
    method: 'POST',
    url: assigneeRefsPath(boardId),
    ...(body === undefined ? {} : { payload: body as object }),
    headers,
  })
}

describe('POST /internal/boards/:bid/assignee-refs', () => {
  it('needs the internal secret (in the contract’s error shape); it is server to server (no web origin needed)', async () => {
    api = await createTestApi()
    const bob = await api.login('bob')
    const board = await createBoard(bob, DEV_STUDIO, 'B')
    const refused: Record<string, string>[] = [{}, { [SECRET_HEADER]: TICKET_SECRET }, { cookie: bob.cookie }]
    for (const headers of refused) {
      const res = await refs(api, board, { uids: [bob.userId] }, headers)
      expect(res.statusCode, JSON.stringify(headers)).toBe(401)
      expect(res.json().error.code).toBe('bad-secret')
      expect(res.body).not.toContain(bob.userId)
    }
    const ok = await refs(
      api,
      board,
      { uids: [bob.userId] },
      {
        [SECRET_HEADER]: INTERNAL_SECRET,
        origin: 'https://evil.example',
      },
    )
    expect(ok.statusCode, ok.body).toBe(200)
    expect(AssigneeRefsAnswer.parse(ok.json())).toEqual({ accounts: [bob.userId] })
  })

  it('answers the accounts with a role on the board, each once in order; guests, strangers and junk are left out', async () => {
    api = await createTestApi()
    const alice = await api.login('alice') // Dev Studio owner: a role through the workspace
    const bob = await api.login('bob')
    const carol = await api.login('carol')
    const dave = await api.login('dave')
    const erin = await api.login('erin')
    const board = await createBoard(bob, DEV_STUDIO, 'Planning wall')
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'commenter' })
    // erin has no workspace membership and no grant
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      erin.userId,
      DEV_STUDIO,
    ])
    // a name-only guest who may edit (a workshop link): never an assignee
    const link = await guestLink(bob, board, { role: 'editor' })
    const guest = await joinAsGuest(api, link.url, 'Sam')
    const asked = [
      carol.userId,
      guest.userId,
      'usr_00000000000000000000',
      erin.userId,
      bob.userId,
      'alice',
      carol.userId,
      alice.userId,
      dave.userId,
    ]
    const res = await refs(api, board, { uids: asked })
    expect(res.statusCode, res.body).toBe(200)
    const accounts = AssigneeRefsAnswer.parse(res.json()).accounts
    // dave is signed in but holds no role on this private board (access-many.test.ts: the same rows)
    expect(accounts).toEqual([carol.userId, bob.userId, alice.userId])
    expect(accounts).not.toContain(guest.userId)
    expect(accounts).not.toContain(erin.userId)
    // the guest really has a role on the board (so it is the account rule that leaves it out)
    const role = await api.app.inject({
      method: 'GET',
      url: `/internal/access?boardId=${board}&userId=${guest.userId}`,
      headers: { [SECRET_HEADER]: INTERNAL_SECRET },
    })
    expect(role.json().role).toBe('editor')
  })

  it('an archived board still answers (viewers), a trashed or unknown one is 404 board-not-found', async () => {
    api = await createTestApi()
    const bob = await api.login('bob')
    const carol = await api.login('carol')
    const archived = await createBoard(bob, DEV_STUDIO, 'A')
    const trashed = await createBoard(bob, DEV_STUDIO, 'T')
    await bob.req('PUT', `/api/boards/${archived}/members/${carol.userId}`, { role: 'editor' })
    await bob.req('POST', `/api/boards/${archived}/archive`)
    await bob.req('POST', `/api/boards/${trashed}/trash`)
    const a = await refs(api, archived, { uids: [carol.userId] })
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toEqual({ accounts: [carol.userId] })
    for (const bid of [trashed, 'b-0000000000', 'Not_A_Board!']) {
      const res = await refs(api, bid, { uids: [bob.userId] })
      expect(res.statusCode, bid).toBe(404)
      expect(res.json().error.code).toBe('board-not-found')
    }
  })

  it(`takes 1 to ${ASSIGNEE_REFS_MAX_UIDS} uids (400 bad-request otherwise)`, async () => {
    api = await createTestApi()
    const bob = await api.login('bob')
    const board = await createBoard(bob, DEV_STUDIO, 'B')
    const atCap = Array.from({ length: ASSIGNEE_REFS_MAX_UIDS }, () => bob.userId)
    const ok = await refs(api, board, { uids: atCap })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toEqual({ accounts: [bob.userId] })
    for (const bad of [
      { uids: [...atCap, bob.userId] },
      { uids: [] },
      { uids: [''] },
      { uids: ['u'.repeat(61)] },
      { uids: [bob.userId], extra: 1 },
      { uid: bob.userId },
      undefined,
    ]) {
      const res = await refs(api, board, bad)
      expect(res.statusCode, JSON.stringify(bad)?.slice(0, 60)).toBe(400)
      expect(res.json().error.code).toBe('bad-request')
    }
  })
})
