// Every refusal for name-only guests (docs/WAVE3-CONTRACTS.md §2 guests): they reach the boards they
// were granted through guest links, and nothing else.
import { ListMembersResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GUEST_REFUSED_ROUTES } from '../../../src/features/guests/guard.ts'
import { isPendingRoute } from '../../../src/features/pending-routes.ts'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import {
  boardRole,
  errorCode,
  type GuestClient,
  guestLink,
  joinAsGuest,
  type Method,
  setupWorld,
  tokenOf,
  type World,
} from './support.ts'

let w: World
let sam: GuestClient
/** bob's other boards in Dev Studio: private, workspace-view and workspace-edit (members see two). */
let others: { priv: string; wsView: string; wsEdit: string }
beforeEach(async () => {
  // wave V: setupWorld turns all three switches on, so every landed wave V route runs and is held to its guard rows
  // here (with its switch off it is an unknown route for everyone, a guest too: live/switch.test.ts)
  w = await setupWorld()
  sam = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'commenter' })).url, 'Sam')
  const priv = await createBoard(w.bob, DEV_STUDIO, 'Private plan')
  const wsView = await createBoard(w.bob, DEV_STUDIO, 'Team view')
  const wsEdit = await createBoard(w.bob, DEV_STUDIO, 'Team edit')
  for (const [id, visibility] of [
    [wsView, 'workspace_view'],
    [wsEdit, 'workspace_edit'],
  ] as const)
    expect((await w.bob.req('PATCH', `/api/boards/${id}`, { visibility })).statusCode).toBe(200)
  others = { priv, wsView, wsEdit }
})
afterEach(() => w.api.close())

const SNAPSHOT = 'snp_0123456789abcdefghij'
const INVITATION = 'inv_0123456789abcdefghij'
const REQUEST = 'acr_0123456789abcdefghij'
const PROJECT = 'prj_0123456789abcdefghij'
const LIB_ITEM = 'lbi_0123456789abcdefghij'
const LIB_FOLDER = 'lbf_0123456789abcdefghij'
const LIB_VER = 'ver_0123456789abcdefghij'
const IMPORT_JOB = 'imp_0123456789abcdefghij'
const HOOK = 'chk_0123456789abcdefghij'
const REVIEW_ITEM = 'rvi_0123456789abcdefghij'
const REVIEW_ROUND = 'rvr_0123456789abcdefghij'
const ACTIVITY = 'act_0123456789abcdefghij'
const BREAKOUT = 'brk_0123456789abcdefghij'

/**
 * Every refused route (its pattern first), called the way a client would, on the guest's own board
 * where it applies.
 */
function refusedCalls(board: string, other: string, userId: string): [string, Method, string, unknown][] {
  const b = `/api/boards/${board}`
  const ws = `/api/workspaces/${DEV_STUDIO}`
  const lib = `${ws}/library`
  return [
    ['POST /api/workspaces/:wid/boards', 'POST', `${ws}/boards`, { title: 'Mine' }],
    ['POST /api/workspaces/:wid/projects', 'POST', `${ws}/projects`, { name: 'Mine' }],
    ['PATCH /api/projects/:pid', 'PATCH', `/api/projects/${PROJECT}`, { name: 'Mine' }],
    ['POST /api/workspaces/:wid/boards/import', 'POST', `${ws}/boards/import`, {}],
    ['POST /api/boards/:bid/duplicate', 'POST', `${b}/duplicate`, {}],
    ['POST /api/snapshots/:sid/restore-as-new', 'POST', `/api/snapshots/${SNAPSHOT}/restore-as-new`, {}],
    [
      'POST /api/boards/:bid/snapshots/:sid/restore-elements',
      'POST',
      `${b}/snapshots/${SNAPSHOT}/restore-elements`,
      { ids: ['n1'] },
    ],
    ['GET /api/workspaces/:wid/members', 'GET', `${ws}/members`, undefined],
    ['GET /api/workspaces/:wid/projects', 'GET', `${ws}/projects`, undefined],
    [
      'POST /api/workspaces/:wid/invitations',
      'POST',
      `${ws}/invitations`,
      { role: 'member', email: 'x@example.com' },
    ],
    [
      'POST /api/boards/:bid/invitations',
      'POST',
      `${b}/invitations`,
      { role: 'viewer', email: 'x@example.com' },
    ],
    [
      'POST /api/boards/:bid/invitations/email',
      'POST',
      `${b}/invitations/email`,
      { email: 'x@example.com', role: 'viewer' },
    ],
    ['GET /api/boards/:bid/invitations', 'GET', `${b}/invitations`, undefined],
    [
      'POST /api/boards/:bid/review-links',
      'POST',
      `${b}/review-links`,
      { role: 'viewer', allowGuests: true },
    ],
    ['POST /api/boards/:bid/review-links/:id/revoke', 'POST', `${b}/review-links/${INVITATION}/revoke`, {}],
    ['POST /api/boards/:bid/review-links/:id/extend', 'POST', `${b}/review-links/${INVITATION}/extend`, {}],
    ['DELETE /api/invitations/:id', 'DELETE', `/api/invitations/${INVITATION}`, undefined],
    ['PUT /api/boards/:bid/members/:uid', 'PUT', `${b}/members/${userId}`, { role: 'viewer' }],
    ['DELETE /api/boards/:bid/members/:uid', 'DELETE', `${b}/members/${userId}`, undefined],
    ['POST /api/boards/:bid/transfer-ownership', 'POST', `${b}/transfer-ownership`, { userId }],
    ['GET /api/boards/:bid/sharing/members', 'GET', `${b}/sharing/members`, undefined],
    ['GET /api/boards/:bid/access-requests', 'GET', `${b}/access-requests`, undefined],
    ['POST /api/access-requests/:id/approve', 'POST', `/api/access-requests/${REQUEST}/approve`, {}],
    ['POST /api/access-requests/:id/deny', 'POST', `/api/access-requests/${REQUEST}/deny`, {}],
    // Link previews (audit L2): the api fetches public pages for people with an account only.
    ['POST /api/boards/:bid/link-preview', 'POST', `${b}/link-preview`, { url: 'https://example.com/' }],
    // The spotlight for everyone (wave L, L5-2): facilitators only, and a guest never is one.
    ['POST /api/boards/:bid/spotlight', 'POST', `${b}/spotlight`, { refs: ['shape:abc'] }],
    ['POST /api/boards/:bid/spotlight/end', 'POST', `${b}/spotlight/end`, {}],
    // Wave M (landed by the foundation; pending routes answer as unknown ones until implemented, see below)
    ['GET /api/workspaces/:wid/templates', 'GET', `${ws}/templates`, undefined],
    ['POST /api/workspaces/:wid/templates', 'POST', `${ws}/templates`, { boardId: board, name: 'Mine' }],
    ['DELETE /api/workspaces/:wid/templates/:bid', 'DELETE', `${ws}/templates/${board}`, undefined],
    ['POST /api/workspaces/:wid/templates/:bid/use', 'POST', `${ws}/templates/${board}/use`, {}],
    ['POST /api/workspaces/:wid/ai/ask', 'POST', `${ws}/ai/ask`, { question: 'What did we decide?' }],
    // Wave N (landed by the foundation; pending until implemented, as above)
    ['POST /api/boards/:bid/visit', 'POST', `${b}/visit`, undefined],
    ['POST /api/boards/:bid/visit/seen', 'POST', `${b}/visit/seen`, undefined],
    ['POST /api/boards/:bid/ai/capture/photo', 'POST', `${b}/ai/capture/photo?mode=notes`, {}],
    [
      'POST /api/boards/:bid/ai/capture/board-image',
      'POST',
      `${b}/ai/capture/board-image`,
      { elementId: 'img-1' },
    ],
    [
      'POST /api/boards/:bid/ai/capture/transcript',
      'POST',
      `${b}/ai/capture/transcript`,
      { text: 'We decided.' },
    ],
    ['GET /api/boards/:bid/backlinks', 'GET', `${b}/backlinks`, undefined],
    // Wave Q (landed by the foundation; pending until implemented, as above): the element library
    ['GET /api/workspaces/:wid/library', 'GET', `${ws}/library?scope=workspace`, undefined],
    ['GET /api/workspaces/:wid/library/items/:id', 'GET', `${lib}/items/${LIB_ITEM}`, undefined],
    [
      'POST /api/workspaces/:wid/library/items',
      'POST',
      `${lib}/items`,
      { scope: 'personal', name: 'Mine', sourceBoardId: board, elements: [{ id: 'a', type: 'rectangle' }] },
    ],
    ['PATCH /api/workspaces/:wid/library/items/:id', 'PATCH', `${lib}/items/${LIB_ITEM}`, { revision: 1 }],
    ['DELETE /api/workspaces/:wid/library/items/:id', 'DELETE', `${lib}/items/${LIB_ITEM}`, undefined],
    ['POST /api/workspaces/:wid/library/items/:id/restore', 'POST', `${lib}/items/${LIB_ITEM}/restore`, {}],
    [
      'GET /api/workspaces/:wid/library/items/:id/files/:ver/thumb',
      'GET',
      `${lib}/items/${LIB_ITEM}/files/${LIB_VER}/thumb`,
      undefined,
    ],
    [
      'POST /api/workspaces/:wid/library/import',
      'POST',
      `${lib}/import`,
      { scope: 'personal', fileName: 'a.excalidrawlib', items: [{ name: 'A', elements: [{ id: 'a' }] }] },
    ],
    ['GET /api/workspaces/:wid/library/folders', 'GET', `${lib}/folders?scope=personal`, undefined],
    ['POST /api/workspaces/:wid/library/folders', 'POST', `${lib}/folders`, { scope: 'personal', name: 'F' }],
    [
      'PATCH /api/workspaces/:wid/library/folders/:fid',
      'PATCH',
      `${lib}/folders/${LIB_FOLDER}`,
      { name: 'G' },
    ],
    ['DELETE /api/workspaces/:wid/library/folders/:fid', 'DELETE', `${lib}/folders/${LIB_FOLDER}`, undefined],
    ['GET /api/workspaces/:wid/library/marks', 'GET', `${lib}/marks`, undefined],
    [
      'PUT /api/workspaces/:wid/library/marks',
      'PUT',
      `${lib}/marks`,
      { key: 'piece:decision', favourite: true },
    ],
    [
      'POST /api/boards/:bid/library/items/:id/place',
      'POST',
      `${b}/library/items/${LIB_ITEM}/place`,
      undefined,
    ],
    [
      'POST /api/boards/:bid/library/items/:id/place/confirm',
      'POST',
      `${b}/library/items/${LIB_ITEM}/place/confirm`,
      undefined,
    ],
    // Wave R (landed by the foundation; pending until implemented, as above): imports, backups, chat hooks
    ['GET /api/imports/:id', 'GET', `/api/imports/${IMPORT_JOB}`, undefined],
    ['GET /api/workspaces/:wid/imports', 'GET', `${ws}/imports?mine=1`, undefined],
    ['POST /api/imports/:id/cancel', 'POST', `/api/imports/${IMPORT_JOB}/cancel`, {}],
    ['POST /api/imports/:id/pause', 'POST', `/api/imports/${IMPORT_JOB}/pause`, {}],
    ['POST /api/imports/:id/resume', 'POST', `/api/imports/${IMPORT_JOB}/resume`, {}],
    ['GET /api/imports/:id/report.csv', 'GET', `/api/imports/${IMPORT_JOB}/report.csv`, undefined],
    ['POST /api/workspaces/:wid/imports/miro/boards', 'POST', `${ws}/imports/miro/boards`, {}],
    [
      'POST /api/workspaces/:wid/imports/miro',
      'POST',
      `${ws}/imports/miro`,
      { boards: [{ miroBoardId: 'uXjVOD1Ab2c=' }] },
    ],
    ['POST /api/boards/:bid/backup/ticket', 'POST', `${b}/backup/ticket`, {}],
    ['POST /api/workspaces/:wid/backups', 'POST', `${ws}/backups`, {}],
    ['GET /api/workspaces/:wid/chat-hooks', 'GET', `${ws}/chat-hooks`, undefined],
    ['POST /api/workspaces/:wid/chat-hooks', 'POST', `${ws}/chat-hooks`, { name: 'x', provider: 'slack' }],
    ['PATCH /api/workspaces/:wid/chat-hooks/:hid', 'PATCH', `${ws}/chat-hooks/${HOOK}`, { name: 'y' }],
    ['DELETE /api/workspaces/:wid/chat-hooks/:hid', 'DELETE', `${ws}/chat-hooks/${HOOK}`, undefined],
    ['POST /api/workspaces/:wid/chat-hooks/:hid/test', 'POST', `${ws}/chat-hooks/${HOOK}/test`, {}],
    ['GET /api/me/chat-prefs', 'GET', `/api/me/chat-prefs?workspace=${DEV_STUDIO}`, undefined],
    ['PUT /api/me/chat-prefs', 'PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs: [] }],
    // Wave S (landed by the foundation; pending until implemented): managing a review on their own board
    [
      'POST /api/boards/:bid/review/items',
      'POST',
      `${b}/review/items`,
      { elementId: 'frame-1', kind: 'frame', label: 'Key art' },
    ],
    ['PATCH /api/boards/:bid/review/items/:rvi', 'PATCH', `${b}/review/items/${REVIEW_ITEM}`, { label: 'x' }],
    ['DELETE /api/boards/:bid/review/items/:rvi', 'DELETE', `${b}/review/items/${REVIEW_ITEM}`, undefined],
    ['POST /api/boards/:bid/review/rounds', 'POST', `${b}/review/rounds`, {}],
    [
      'POST /api/boards/:bid/review/rounds/:rvr/close',
      'POST',
      `${b}/review/rounds/${REVIEW_ROUND}/close`,
      {},
    ],
    // Wave V (landed by the foundation; pending until implemented): running polls, word clouds and breakouts, and a
    // workshop link's join code, on their own board
    [
      'POST /api/boards/:bid/activities',
      'POST',
      `${b}/activities`,
      { kind: 'poll', prompt: 'Which one?', config: { options: ['A', 'B'] } },
    ],
    ['POST /api/activities/:aid/close', 'POST', `/api/activities/${ACTIVITY}/close`, {}],
    ['POST /api/activities/:aid/reveal', 'POST', `/api/activities/${ACTIVITY}/reveal`, {}],
    ['POST /api/activities/:aid/extend', 'POST', `/api/activities/${ACTIVITY}/extend`, { addMs: 60_000 }],
    ['POST /api/activities/:aid/cancel', 'POST', `/api/activities/${ACTIVITY}/cancel`, {}],
    ['POST /api/activities/:aid/hide', 'POST', `/api/activities/${ACTIVITY}/hide`, { word: 'rude' }],
    ['POST /api/activities/:aid/placed', 'POST', `/api/activities/${ACTIVITY}/placed`, {}],
    ['GET /api/activities/:aid/answers', 'GET', `/api/activities/${ACTIVITY}/answers`, undefined],
    [
      'POST /api/boards/:bid/breakouts',
      'POST',
      `${b}/breakouts`,
      {
        mode: 'auto',
        groups: [
          { name: 'One', frameId: 'shape:f1' },
          { name: 'Two', frameId: 'shape:f2' },
        ],
      },
    ],
    [
      'POST /api/breakouts/:brk/assign',
      'POST',
      `/api/breakouts/${BREAKOUT}/assign`,
      { moves: [{ userId, groupId: 'g1' }] },
    ],
    ['POST /api/breakouts/:brk/shuffle', 'POST', `/api/breakouts/${BREAKOUT}/shuffle`, {}],
    ['POST /api/breakouts/:brk/extend', 'POST', `/api/breakouts/${BREAKOUT}/extend`, { addMs: 60_000 }],
    [
      'POST /api/breakouts/:brk/broadcast',
      'POST',
      `/api/breakouts/${BREAKOUT}/broadcast`,
      { text: 'Five minutes', groupId: null },
    ],
    ['POST /api/breakouts/:brk/summon', 'POST', `/api/breakouts/${BREAKOUT}/summon`, { groupId: 'g1' }],
    ['POST /api/breakouts/:brk/end', 'POST', `/api/breakouts/${BREAKOUT}/end`, {}],
    [
      'POST /api/boards/:bid/review-links/:id/code',
      'POST',
      `${b}/review-links/${INVITATION}/code`,
      undefined,
    ],
    // Requesting access: to their own board and to any other.
    ['POST /api/boards/:bid/access-requests', 'POST', `${b}/access-requests`, { role: 'editor' }],
    [
      'POST /api/boards/:bid/access-requests',
      'POST',
      `/api/boards/${other}/access-requests`,
      { role: 'viewer' },
    ],
  ]
}

describe('what a guest cannot do', () => {
  it('every refused route answers 403 GUEST_ACCOUNT_REQUIRED, whatever the ids', async () => {
    const calls = refusedCalls(w.board, others.priv, w.bob.userId)
    // The matrix covers the whole refusal list.
    expect(new Set(calls.map(([route]) => route))).toEqual(new Set(Object.keys(GUEST_REFUSED_ROUTES)))
    for (const [route, method, url, body] of calls) {
      const res = await sam.req(method, url, body)
      // A wave M route still pending (src/features/pending-routes.ts) is not registered: the unknown route's 404.
      // Once its owner implements it (and removes it from PENDING_ROUTES), it must refuse the guest here.
      if (isPendingRoute(route)) {
        expect(res.statusCode, `${method} ${url} (pending): ${res.body}`).toBe(404)
        expect(res.json(), `${method} ${url} (pending)`).toEqual({
          error: { code: 'NOT_FOUND', message: 'Not found.' },
        })
        continue
      }
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403)
      expect(errorCode(res), `${method} ${url}`).toBe('GUEST_ACCOUNT_REQUIRED')
    }
    // Nothing was created or requested.
    for (const table of ['projects', 'access_requests']) {
      const n = await w.api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
      expect(n.n, table).toBe(0)
    }
    expect(
      (
        await w.api.db.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM invitations WHERE created_by = $1',
          [sam.userId],
        )
      ).n,
    ).toBe(0)
  })

  it('every pattern on the refusal list is a registered route (a renamed route fails here), or a pending one that is not', () => {
    for (const key of Object.keys(GUEST_REFUSED_ROUTES)) {
      const [method = '', url = ''] = key.split(' ')
      expect(w.api.app.hasRoute({ method: method as Method, url }), key).toBe(!isPendingRoute(key))
    }
  })

  it('there is no route to create a workspace (for anyone)', async () => {
    expect((await sam.req('POST', '/api/workspaces', { name: 'Mine' })).statusCode).toBe(404)
  })

  it('even as the board’s owner (a legacy grant), a guest cannot invite people or create links', async () => {
    // Guests cannot be made owners through the API (below); this simulates a grant from elsewhere.
    await w.api.db.query("UPDATE board_members SET role = 'owner' WHERE board_id = $1 AND user_id = $2", [
      w.board,
      sam.userId,
    ])
    expect(await boardRole(sam, w.board)).toBe('owner')
    for (const [method, url, body] of [
      ['POST', `/api/boards/${w.board}/invitations`, { role: 'viewer', email: 'x@example.com' }],
      ['POST', `/api/boards/${w.board}/review-links`, { role: 'viewer' }],
      ['POST', `/api/boards/${w.board}/invitations/email`, { email: 'x@example.com', role: 'viewer' }],
      ['PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'editor' }],
    ] as [Method, string, unknown][]) {
      const res = await sam.req(method, url, body)
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(errorCode(res)).toBe('GUEST_ACCOUNT_REQUIRED')
    }
    expect(await boardRole(w.carol, w.board)).toBeNull()
  })

  it('cannot accept a normal invitation: 403 "Sign in with an account to accept this invitation"', async () => {
    const single = (
      await w.bob.req('POST', `/api/boards/${others.priv}/invitations`, {
        role: 'editor',
        email: 'erin@dev.invalid', // the account that uses it below
      })
    ).json() as {
      url: string
    }
    const workspace = (
      await w.alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
        role: 'member',
        email: 'x@example.com',
      })
    ).json() as { url: string }
    const review = await guestLink(w.bob, others.priv, { role: 'viewer', allowGuests: false })
    for (const url of [single.url, workspace.url, review.url]) {
      const res = await sam.req('POST', `/api/invitations/${tokenOf(url)}/accept`)
      expect(res.statusCode, url).toBe(403)
      expect(res.json()).toEqual({
        error: {
          code: 'GUEST_ACCOUNT_REQUIRED',
          message: 'Sign in with an account to accept this invitation.',
        },
      })
    }
    expect(await boardRole(sam, others.priv)).toBeNull()
    // Unused: the single-use invitation still works for someone with an account.
    expect((await w.erin.req('POST', `/api/invitations/${tokenOf(single.url)}/accept`)).statusCode).toBe(200)
    // A guest link is fine through accept too (the same redemption as joining).
    const guestOk = await guestLink(w.bob, others.priv, { role: 'viewer' })
    expect((await sam.req('POST', `/api/invitations/${tokenOf(guestOk.url)}/accept`)).statusCode).toBe(200)
    expect(await boardRole(sam, others.priv)).toBe('viewer')
  })

  it('sees only the boards granted to them: not private, workspace-view or workspace-edit boards', async () => {
    const list = await sam.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)
    expect(list.statusCode).toBe(200)
    expect((list.json() as { boards: { id: string }[] }).boards.map((b) => b.id)).toEqual([w.board])
    for (const id of [others.priv, others.wsView, others.wsEdit]) {
      expect((await sam.req('GET', `/api/boards/${id}`)).statusCode, id).toBe(404)
      expect((await sam.req('POST', `/api/boards/${id}/ticket`)).statusCode, id).toBe(404)
      expect((await sam.req('GET', `/api/boards/${id}/members`)).statusCode, id).toBe(404)
      expect((await sam.req('GET', `/api/boards/${id}/threads`)).statusCode, id).toBe(404)
    }
    // A carol-style member sees the two workspace boards, for contrast.
    const carols = await w.carol.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)
    expect((carols.json() as { boards: { id: string }[] }).boards.map((b) => b.id).sort()).toEqual(
      [others.wsView, others.wsEdit].sort(),
    )
  })

  it('lists only the people on their own boards, without their @handles', async () => {
    const res = await sam.req('GET', `/api/boards/${w.board}/members`)
    expect(res.statusCode).toBe(200)
    const members = ListMembersResponse.parse(res.json()).members
    // bob (owner, grant), alice (workspace owner) and Sam: not carol, who has no access to the board.
    expect(members.map((m) => m.user.id).sort()).toEqual([w.alice.userId, w.bob.userId, sam.userId].sort())
    expect(members.every((m) => m.user.handle === null)).toBe(true)
  })
})

describe('what nobody can do to a guest', () => {
  it('add them to a board they did not join through a guest link, or make them an owner (409); role changes and removal on their board work', async () => {
    const { bob, board } = w
    const put = (b: string, role: string) =>
      bob.req('PUT', `/api/boards/${b}/members/${sam.userId}`, { role })
    const elsewhere = await put(others.priv, 'viewer')
    expect(elsewhere.statusCode).toBe(409)
    expect(errorCode(elsewhere)).toBe('GUEST_ONLY_THROUGH_LINKS')
    expect(await boardRole(sam, others.priv)).toBeNull()
    const owner = await put(board, 'owner')
    expect(owner.statusCode).toBe(409)
    expect(errorCode(owner)).toBe('GUEST_ONLY_THROUGH_LINKS')
    const transfer = await bob.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: sam.userId })
    expect(transfer.statusCode).toBe(409)
    expect(errorCode(transfer)).toBe('GUEST_ONLY_THROUGH_LINKS')
    expect(await boardRole(sam, board)).toBe('commenter')
    expect((await put(board, 'editor')).statusCode).toBe(200)
    expect(await boardRole(sam, board)).toBe('editor')
    expect((await bob.req('DELETE', `/api/boards/${board}/members/${sam.userId}`)).statusCode).toBe(200)
    expect(await boardRole(sam, board)).toBeNull()
  })

  it('someone who cannot manage the board gets the route’s own answer (no hint that the id is a guest)', async () => {
    const res = await w.carol.req('PUT', `/api/boards/${w.board}/members/${sam.userId}`, { role: 'viewer' })
    expect(res.statusCode).toBe(404)
    // An account user is added as before.
    expect(
      (await w.bob.req('PUT', `/api/boards/${others.priv}/members/${w.carol.userId}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(200)
  })
})
