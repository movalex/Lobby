// Wave M (M8-3, WS-TEMPLATES; owner W8): workspace templates. Who may list, save, remove and use one; what a use
// copies (the content, through the sync's snapshot and seed) and what it never copies (the template's grants,
// links, visibility, export policy); the lock order of a use and a removal (the interleavings themselves are in
// templates.pg.test.ts, on a real Postgres).
//
// Dev Studio: owner is its owner (the first login); bob is an admin, carol and dave members, all creators; pat is a
// member who is not a creator (an address outside the creator domains); erin is not a member.

import {
  HistoryBoardCreated,
  ListWorkspaceTemplatesResponse,
  WorkspaceTemplate,
  WS_TEMPLATES_MAX,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { statementLog } from '../../statement-log.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from '../history/helpers.ts'
import { move, newProject, projectOf, refused, setProject } from '../outside/internal-only-support.ts'

let api: TestApi
let sync: FakeSync
let owner: Client
let bob: Client
let carol: Client
let dave: Client
let pat: Client
let erin: Client
/** carol's private board with a note, a viewer grant for dave, a review link, AI off, a stored export policy. */
let source: string

const ws = `/api/workspaces/${DEV_STUDIO}/templates`
const one = (bid: string) => `${ws}/${bid}`
const use = (bid: string) => `${ws}/${bid}/use`

async function setup() {
  sync = createFakeSync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  owner = await api.login('owner')
  bob = await api.login('bob')
  carol = await api.login('carol')
  dave = await api.login('dave')
  pat = await api.login('pat', 'Pat', { email: 'pat@client.example.test' })
  erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  await api.db.query(`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`, [
    DEV_STUDIO,
    bob.userId,
  ])
  await api.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'member'`,
    [DEV_STUDIO, pat.userId],
  )
  source = await createBoard(carol, DEV_STUDIO, 'Our retro')
  sync.setBoard(source, [...baseRecords(), noteRec('n1', 'What went well?')])
}

beforeEach(async () => {
  await setup()
})
afterEach(() => api.close())

const save = (c: Client, boardId: string, name = 'Team retro', category = 'review') =>
  c.req('POST', ws, { boardId, name, category })
const list = async (c: Client) => {
  const res = await c.req('GET', ws)
  expect(res.statusCode, res.body).toBe(200)
  return ListWorkspaceTemplatesResponse.parse(res.json()).templates
}
const count = async (sql: string, params: unknown[] = []) =>
  (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).n
const membersOf = async (bid: string) =>
  (
    await api.db.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM board_members WHERE board_id = $1 ORDER BY user_id',
      [bid],
    )
  ).rows

describe('saving and removing (a creator who is a workspace owner or admin)', () => {
  it('an admin saves any board of the workspace (even one they hold no grant on); listed for every member', async () => {
    const res = await save(bob, source)
    expect(res.statusCode, res.body).toBe(201)
    const t = WorkspaceTemplate.parse(res.json())
    expect(t).toMatchObject({
      boardId: source,
      name: 'Team retro',
      category: 'review',
      addedBy: { id: bob.userId, name: 'bob' },
    })
    for (const who of [owner, bob, carol, dave, pat]) expect(await list(who), who.userId).toEqual([t])
    // saving again changes name and category, keeps who added it and when
    const again = await save(owner, source, 'Retro v2', 'plan')
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json()).toEqual({ ...t, name: 'Retro v2', category: 'plan' })
    expect(await count('workspace_templates')).toBe(1)
  })

  it('a member (creator, not admin) gets 403; a non-creator admin 403 CREATOR_REQUIRED; a stranger 404', async () => {
    const r1 = await save(carol, source)
    expect(r1.statusCode, r1.body).toBe(403)
    expect(r1.json().error.code).toBe('FORBIDDEN')
    await api.db.query(
      `UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`,
      [DEV_STUDIO, pat.userId],
    )
    const r2 = await save(pat, source)
    expect(r2.statusCode, r2.body).toBe(403)
    expect(r2.json().error.code).toBe('CREATOR_REQUIRED')
    expect((await save(erin, source)).statusCode).toBe(404)
    expect(await count('workspace_templates')).toBe(0)
    // removing: the same people are refused
    expect((await save(bob, source)).statusCode).toBe(201)
    expect((await carol.req('DELETE', one(source))).statusCode).toBe(403)
    expect((await pat.req('DELETE', one(source))).json().error.code).toBe('CREATOR_REQUIRED')
    expect((await erin.req('DELETE', one(source))).statusCode).toBe(404)
    expect(await count('workspace_templates')).toBe(1)
  })

  it('a board of another workspace, a trashed board or no board: 404; the 101st template: 409', async () => {
    const foreign = await createBoard(erin, erin.personalWorkspaceId, 'Foreign')
    expect((await save(bob, foreign)).statusCode).toBe(404)
    expect((await save(bob, 'b-nonexistent')).statusCode).toBe(404)
    const trashed = await createBoard(bob, DEV_STUDIO, 'Trashed')
    expect((await bob.req('POST', `/api/boards/${trashed}/trash`)).statusCode).toBe(200)
    expect((await save(bob, trashed)).statusCode).toBe(404)
    // the limit (rows made directly; the boards are real)
    for (let i = 0; i < WS_TEMPLATES_MAX; i++) {
      const b = await api.db.one<{ id: string }>(
        `INSERT INTO boards (id, workspace_id, title, visibility, created_by, created_at, updated_at)
         VALUES ($1, $2, 'T', 'private', $3, now(), now()) RETURNING id`,
        [`b-limit-${String(i).padStart(4, '0')}`, DEV_STUDIO, bob.userId],
      )
      await api.db.query(
        `INSERT INTO workspace_templates (workspace_id, board_id, name, added_by) VALUES ($1, $2, 'T', $3)`,
        [DEV_STUDIO, b.id, bob.userId],
      )
    }
    const full = await save(bob, source)
    expect(full.statusCode, full.body).toBe(409)
    expect(full.json().error.code).toBe('WS_TEMPLATES_LIMIT')
    // renaming one that is already a template is not a new one
    expect((await save(bob, 'b-limit-0000', 'Renamed')).statusCode).toBe(201)
  })

  it('a board whose copying is limited to its editors (export policy) cannot be saved: 403, nothing stored', async () => {
    expect(
      (await carol.req('PUT', `/api/boards/${source}/export-policy`, { exportPolicy: 'editors' })).statusCode,
    ).toBe(200)
    for (const who of [bob, owner]) {
      const res = await save(who, source)
      expect(res.statusCode, res.body).toBe(403)
      expect(res.json().error.message).toMatch(/limited to its editors/)
    }
    expect(await count('workspace_templates')).toBe(0)
    expect(
      (await carol.req('PUT', `/api/boards/${source}/export-policy`, { exportPolicy: 'everyone' }))
        .statusCode,
    ).toBe(200)
    expect((await save(bob, source)).statusCode).toBe(201)
  })

  it('DELETE answers 204, then 404; the board itself is untouched', async () => {
    expect((await save(bob, source)).statusCode).toBe(201)
    const del = await bob.req('DELETE', one(source))
    expect(del.statusCode, del.body).toBe(204)
    expect(del.body).toBe('')
    expect((await bob.req('DELETE', one(source))).statusCode).toBe(404)
    expect(await list(carol)).toEqual([])
    expect((await carol.req('GET', `/api/boards/${source}`)).statusCode).toBe(200)
  })
})

describe('listing', () => {
  it('members only: a workspace guest 403, a name-only guest 403, a stranger 404', async () => {
    expect((await save(bob, source)).statusCode).toBe(201)
    await api.db.query(
      `UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2`,
      [DEV_STUDIO, dave.userId],
    )
    expect((await dave.req('GET', ws)).statusCode).toBe(403)
    const sam = await joinAsGuest(api, (await guestLink(carol, source, { role: 'viewer' })).url, 'Sam')
    const g = await sam.req('GET', ws)
    expect(g.statusCode, g.body).toBe(403)
    expect(g.json().error.code).toBe('GUEST_ACCOUNT_REQUIRED')
    expect((await erin.req('GET', ws)).statusCode).toBe(404)
  })

  it('newest first; a trashed template board is not listed; a gone author reads as addedBy null', async () => {
    const second = await createBoard(bob, DEV_STUDIO, 'Kickoff')
    expect((await save(bob, source, 'Retro')).statusCode).toBe(201)
    api.clock.advance(1000)
    expect((await save(owner, second, 'Kickoff', 'plan')).statusCode).toBe(201)
    expect((await list(carol)).map((t) => t.name)).toEqual(['Kickoff', 'Retro'])
    await api.db.query('UPDATE workspace_templates SET added_by = NULL WHERE board_id = $1', [second])
    expect((await list(carol))[0]?.addedBy).toBeNull()
    expect((await bob.req('POST', `/api/boards/${second}/trash`)).statusCode).toBe(200)
    expect((await list(carol)).map((t) => t.name)).toEqual(['Retro'])
  })
})

describe('using a template', () => {
  beforeEach(async () => {
    // The source as it is in real life: shared, with a grant, a link, AI off and a stored export policy (the
    // link stored 'editors', DANA2-01; its owner then let everyone copy, guests included).
    expect(
      (await carol.req('PATCH', `/api/boards/${source}`, { visibility: 'workspace_edit' })).statusCode,
    ).toBe(200)
    expect(
      (await carol.req('PUT', `/api/boards/${source}/members/${dave.userId}`, { role: 'viewer' })).statusCode,
    ).toBe(200)
    expect(
      (await carol.req('POST', `/api/boards/${source}/review-links`, { role: 'viewer' })).statusCode,
    ).toBe(201)
    expect((await carol.req('PUT', `/api/boards/${source}/ai/settings`, { enabled: false })).statusCode).toBe(
      200,
    )
    expect(
      (
        await carol.req('PUT', `/api/boards/${source}/export-policy`, {
          exportPolicy: 'everyone-including-guests',
        })
      ).statusCode,
    ).toBe(200)
    // the template is then made private again: the person who uses it has no access to the board at all
    expect((await carol.req('PATCH', `/api/boards/${source}`, { visibility: 'private' })).statusCode).toBe(
      200,
    )
    expect((await save(bob, source)).statusCode).toBe(201)
    sync.seeds.length = 0
  })

  it('a member who is a creator gets a private copy of the content, owned by them, with none of the sharing', async () => {
    expect((await carol.req('DELETE', `/api/boards/${source}/members/${dave.userId}`)).statusCode).toBe(200)
    expect((await pat.req('GET', `/api/boards/${source}`)).statusCode).toBe(404) // no access to the source
    const res = await dave.req('POST', use(source), {})
    expect(res.statusCode, res.body).toBe(201)
    const made = HistoryBoardCreated.parse(res.json())
    expect(made.board).toMatchObject({ title: 'Team retro', visibility: 'private', role: 'owner' })
    const copy = made.board.id
    expect(copy).not.toBe(source)
    // the content, through the sync's seed
    expect(sync.seeds.map((s) => s.boardId)).toEqual([copy])
    expect(sync.records(copy).map((r) => r.id)).toEqual(sync.records(source).map((r) => r.id))
    // only the caller, no link, no export policy; AI off like the template (AIPV-04)
    expect(await membersOf(copy)).toEqual([{ user_id: dave.userId, role: 'owner' }])
    expect(await count('invitations WHERE board_id = $1', [copy])).toBe(0)
    expect(await count('board_export_policies WHERE board_id = $1', [copy])).toBe(0)
    const ai = await api.db.maybeOne<{ enabled: boolean }>(
      'SELECT enabled FROM board_ai_settings WHERE board_id = $1',
      [copy],
    )
    expect(ai).toEqual({ enabled: false })
    expect((await carol.req('GET', `/api/boards/${copy}`)).statusCode).toBe(404)
    // the audit says where it came from
    const audit = await api.db.one<{ detail: { via: string; fromBoard: string } }>(
      `SELECT detail FROM audit_events WHERE action = 'board.create' AND target = $1`,
      [copy],
    )
    expect(audit.detail).toMatchObject({ via: 'template', fromBoard: source })
  })

  it('a title and a project of the workspace; a project of elsewhere is a 400', async () => {
    const project = (await owner.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Q4' })).json()
      .id as string
    const res = await dave.req('POST', use(source), { projectId: project, title: 'Retro, week 41' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().board).toMatchObject({ title: 'Retro, week 41', projectId: project })
    const bad = await dave.req('POST', use(source), { projectId: 'prj_Nonexistent0000000000' })
    expect(bad.statusCode, bad.body).toBe(400)
  })

  it('a non-creator member: 403 CREATOR_REQUIRED; a workspace guest 403; a stranger 404; nothing is made', async () => {
    const before = await count('boards')
    const r1 = await pat.req('POST', use(source), {})
    expect(r1.statusCode, r1.body).toBe(403)
    expect(r1.json().error.code).toBe('CREATOR_REQUIRED')
    await api.db.query(
      `UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2`,
      [DEV_STUDIO, dave.userId],
    )
    expect((await dave.req('POST', use(source), {})).statusCode).toBe(403)
    expect((await erin.req('POST', use(source), {})).statusCode).toBe(404)
    expect(await count('boards')).toBe(before)
    expect(sync.seeds).toEqual([])
  })

  it('not a template (any more), trashed, or of another workspace: 404 and nothing is made', async () => {
    const before = await count('boards')
    const other = await createBoard(carol, DEV_STUDIO, 'Not a template')
    expect((await dave.req('POST', use(other), {})).statusCode).toBe(404)
    expect((await bob.req('DELETE', one(source))).statusCode).toBe(204)
    expect((await dave.req('POST', use(source), {})).statusCode).toBe(404)
    expect((await save(bob, source)).statusCode).toBe(201)
    expect((await carol.req('POST', `/api/boards/${source}/trash`)).statusCode).toBe(200)
    expect((await dave.req('POST', use(source), {})).statusCode).toBe(404)
    expect(
      (await erin.req('POST', `/api/workspaces/${erin.personalWorkspaceId}/templates/${source}/use`, {}))
        .statusCode,
    ).toBe(404)
    expect(await count('boards')).toBe(before + 1)
    expect(sync.seeds).toEqual([])
  })

  it('a removal between the first read and the transaction: 404, and no board row (the re-check under the lock)', async () => {
    const before = await count('boards')
    const grants = await count('board_members WHERE user_id = $1', [dave.userId])
    const snapshot = sync.snapshot.bind(sync)
    sync.snapshot = async (bid) => {
      const snap = await snapshot(bid)
      // the removal commits while the copy is being read from the sync server
      await api.db.query('DELETE FROM workspace_templates WHERE board_id = $1', [source])
      return snap
    }
    const res = await dave.req('POST', use(source), {})
    expect(res.statusCode, res.body).toBe(404)
    expect(await count('boards')).toBe(before)
    expect(await count('board_members WHERE user_id = $1', [dave.userId])).toBe(grants)
    // the seed ran before the transaction: that canvas is unused (and logged), as after any failed insert
    expect(sync.seeds).toHaveLength(1)
  })

  it('copying limited to editors after the save is read at use: 403 EXPORT_DISABLED below editor, as duplicate', async () => {
    expect(
      (await carol.req('PUT', `/api/boards/${source}/export-policy`, { exportPolicy: 'editors' })).statusCode,
    ).toBe(200)
    const before = await count('boards')
    // dave holds a viewer grant (his duplicate is refused too); a member with no grant at all is refused the same
    expect((await dave.req('POST', `/api/boards/${source}/duplicate`, {})).json().error?.code).toBe(
      'EXPORT_DISABLED',
    )
    const r1 = await dave.req('POST', use(source), {})
    expect(r1.statusCode, r1.body).toBe(403)
    expect(r1.json().error.code).toBe('EXPORT_DISABLED')
    expect((await carol.req('DELETE', `/api/boards/${source}/members/${dave.userId}`)).statusCode).toBe(200)
    expect((await dave.req('POST', use(source), {})).json().error.code).toBe('EXPORT_DISABLED')
    expect(await count('boards')).toBe(before)
    expect(sync.seeds).toEqual([])
    // its owner, and a workspace owner or admin (owners of every board), still copy it
    for (const who of [carol, bob]) expect((await who.req('POST', use(source), {})).statusCode).toBe(201)
  })

  it('two uses at once make two boards', async () => {
    const [a, b] = await Promise.all([dave.req('POST', use(source), {}), carol.req('POST', use(source), {})])
    expect([a.statusCode, b.statusCode]).toEqual([201, 201])
    expect(a.json().board.id).not.toBe(b.json().board.id)
  })
})

describe('a template in an internal-only project (IO-1: only owners and admins who are creators take content out)', () => {
  let inside: string
  let open: string
  beforeEach(async () => {
    inside = await newProject(owner, DEV_STUDIO, 'Client X')
    open = await newProject(owner, DEV_STUDIO, 'Open')
    expect((await move(carol, source, inside)).statusCode).toBe(200)
    expect((await setProject(owner, inside, true)).statusCode).toBe(200)
    expect((await save(bob, source)).statusCode, 'save').toBe(201)
  })

  it('a member: 409 INTERNAL_ONLY to no project or to a project that is not internal only; nothing is made', async () => {
    // the same member may not move the board out either (IO-1)
    refused(await move(carol, source, null), 'project')
    const before = await count('boards')
    refused(await carol.req('POST', use(source), {}), 'project')
    refused(await carol.req('POST', use(source), { projectId: null }), 'project')
    refused(await dave.req('POST', use(source), { projectId: open }), 'project')
    expect(await count('boards')).toBe(before)
    // into the project itself (where a duplicate lands): allowed
    const ok = await dave.req('POST', use(source), { projectId: inside })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(await projectOf(api, ok.json().board.id)).toBe(inside)
  })

  it('a workspace owner or admin who is a creator may take a copy out (as they may move the board)', async () => {
    for (const who of [bob, owner]) {
      const res = await who.req('POST', use(source), {})
      expect(res.statusCode, res.body).toBe(201)
      expect(await projectOf(api, res.json().board.id)).toBeNull()
    }
  })

  it('the template board moved into the project after the first read: refused (its project is read under the lock)', async () => {
    expect((await setProject(owner, inside, false)).statusCode).toBe(200)
    expect((await move(carol, source, null)).statusCode).toBe(200)
    const before = await count('boards')
    const snapshot = sync.snapshot.bind(sync)
    sync.snapshot = async (bid) => {
      const snap = await snapshot(bid)
      await api.db.query('UPDATE boards SET project_id = $1 WHERE id = $2', [inside, source])
      await api.db.query('UPDATE projects SET internal_only = true WHERE id = $1', [inside])
      return snap
    }
    refused(await carol.req('POST', use(source), {}), 'project')
    expect(await count('boards')).toBe(before)
  })
})

describe('lock order (the statements of each transaction, on PGlite)', () => {
  it('use: the workspace row, then the template row FOR SHARE, then the board and its owner grant; DELETE: the workspace row, then the row', async () => {
    await api.close()
    sync = createFakeSync()
    const { openTestDb } = await import('@draftroom/db/testing')
    const log = statementLog(await openTestDb())
    api = await createTestApi({ deps: { syncInternal: sync }, db: log.db })
    owner = await api.login('owner')
    dave = await api.login('dave')
    source = await createBoard(owner, DEV_STUDIO, 'Our retro')
    sync.setBoard(source, [...baseRecords(), noteRec('n1', 'What went well?')])
    expect((await owner.req('POST', ws, { boardId: source, name: 'Retro' })).statusCode).toBe(201)
    log.reset()
    expect((await dave.req('POST', use(source), {})).statusCode).toBe(201)
    const tx = log.transactions.find((t) => t.statements.some((s) => s.startsWith('INSERT INTO boards')))
    const at = (re: RegExp) => tx?.statements.findIndex((s) => re.test(s)) ?? -1
    const lock = at(/FROM workspaces WHERE id = \$1 FOR NO KEY UPDATE/)
    const template = at(/FROM workspace_templates t .* FOR SHARE OF t/)
    const board = at(/^INSERT INTO boards/)
    const grant = at(/^INSERT INTO board_members/)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(lock).toBeLessThan(template)
    expect(template).toBeLessThan(board)
    expect(board).toBeLessThan(grant)
    log.reset()
    expect((await owner.req('DELETE', one(source))).statusCode).toBe(204)
    const del = log.transactions.find((t) =>
      t.statements.some((s) => s.startsWith('DELETE FROM workspace_templates')),
    )
    const order = del?.statements.map((s) => (/FOR NO KEY UPDATE/.test(s) ? 'lock' : s.split(' ')[0])) ?? []
    expect(order).toEqual(['lock', 'DELETE'])
    await api.db.close()
  })
})

describe('shipping hidden (the gate rule: a route listed in PENDING_ROUTES again is not registered)', () => {
  it('Ask across boards and the four template routes answer the unknown route’s 404; the rest of the api is unchanged', async () => {
    const { PENDING_ROUTES } = await import('../../../src/features/pending-routes.ts')
    const pending = PENDING_ROUTES as Record<string, { owner: 'W8'; item: string }>
    const keys = [
      'POST /api/workspaces/:wid/ai/ask',
      'GET /api/workspaces/:wid/templates',
      'POST /api/workspaces/:wid/templates',
      'DELETE /api/workspaces/:wid/templates/:bid',
      'POST /api/workspaces/:wid/templates/:bid/use',
    ]
    await api.close()
    for (const k of keys) pending[k] = { owner: 'W8', item: 'hidden' }
    try {
      sync = createFakeSync()
      api = await createTestApi({ deps: { syncInternal: sync } })
      const alice = await api.login('alice')
      for (const k of keys) {
        const [method = '', url = ''] = k.split(' ')
        expect(api.app.hasRoute({ method: method as 'GET', url }), k).toBe(false)
      }
      const res = await alice.req('GET', ws)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
      expect(
        (await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/ai/ask`, { question: 'x' })).statusCode,
      ).toBe(404)
      expect((await alice.req('GET', `/api/workspaces/${DEV_STUDIO}/search?q=x`)).statusCode).toBe(200)
    } finally {
      for (const k of keys) delete pending[k]
    }
  })
})
