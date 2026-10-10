// Wave M (M8-3, owner W8): starting a board from a workspace template against the races that matter, on a real
// Postgres (PGlite has one connection, so two transactions never wait for each other there): set
// DRAFTROOM_TEST_DATABASE_URL to a database these tests may create and drop schemas in. Skipped otherwise.
//
// A use is createBoardFrom's transaction: the workspace row FOR NO KEY UPDATE first (requireCreatingRoleLocked),
// the template row FOR SHARE under it, then the board row and its owner grant. A template removal takes the same
// workspace row before it deletes, and so does a member removal. So each pair runs one after the other, in either
// order, and never leaves a board without its template check, nor an owner grant of someone who is no member.
// Each test stops the REAL route midway (race-support.ts pausingDb) and runs the REAL other route against it.

import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { orphanGrants, type PausingDb, pausingDb, waitedOrFinished } from '../../race-support.ts'
import { baseRecords, createFakeSync, noteRec } from '../history/helpers.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 10)

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

interface World {
  api: TestApi
  paused: PausingDb
  owner: Client // owns Dev Studio (saves and removes templates, removes members)
  bob: Client // a member who uses the template
  carol: Client // another member
  template: string
}

const ws = `/api/workspaces/${DEV_STUDIO}/templates`

async function world(): Promise<World> {
  const base = await openTestDb()
  const paused = pausingDb(base)
  const sync = createFakeSync()
  const api = await createTestApi({ db: paused.db, deps: { syncInternal: sync } })
  cleanup.push(async () => {
    await api.close()
    await base.close()
  })
  const owner = await api.login('owner')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const template = await createBoard(owner, DEV_STUDIO, 'Our retro')
  sync.setBoard(template, [...baseRecords(), noteRec('n1', 'What went well?')])
  const saved = await owner.req('POST', ws, { boardId: template, name: 'Retro', category: 'review' })
  expect(saved.statusCode, saved.body).toBe(201)
  return { api, paused, owner, bob, carol, template }
}

const use = (c: Client, template: string) => c.req('POST', `${ws}/${template}/use`, {})
const removeTemplate = (c: Client, template: string) => c.req('DELETE', `${ws}/${template}`)
const removeMember = (c: Client, uid: string) =>
  c.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${uid}`)
const boardsOf = async (api: TestApi, uid: string) =>
  (
    await api.db.query<{ id: string }>(
      `SELECT b.id FROM boards b WHERE b.workspace_id = $1 AND b.created_by = $2 ORDER BY b.id`,
      [DEV_STUDIO, uid],
    )
  ).rows.map((r) => r.id)

/** The use's transaction, stopped once it holds the workspace row and the template row. */
const USE_HOLDS = /FROM workspace_templates t[\s\S]*FOR SHARE OF t/
/** The removal's transaction, stopped once it has deleted the template row (and holds the workspace row). */
const REMOVAL_HOLDS = /DELETE FROM workspace_templates/

describe.skipIf(!PG)('workspace templates: use against removals (real Postgres)', () => {
  it('a use under way, then the template is removed: the removal waits; the board is made, then the template goes', async () => {
    const w = await world()
    const pause = w.paused.arm(USE_HOLDS, 'after')
    const using = use(w.bob, w.template)
    const pid = await pause.reached
    const removing = removeTemplate(w.owner, w.template)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [used, removed] = await Promise.all([using, removing])
    expect(used.statusCode, used.body).toBe(201)
    expect(removed.statusCode, removed.body).toBe(204)
    expect(await boardsOf(w.api, w.bob.userId)).toEqual([used.json().board.id])
    expect((await use(w.carol, w.template)).statusCode).toBe(404)
  })

  it('a removal under way, then a use: the use waits, then answers 404 and makes no board (no orphan board)', async () => {
    const w = await world()
    const pause = w.paused.arm(REMOVAL_HOLDS, 'after')
    const removing = removeTemplate(w.owner, w.template)
    const pid = await pause.reached
    const using = use(w.bob, w.template)
    try {
      // the use read the template before the removal committed, seeded the copy and now waits for the
      // workspace row in its transaction
      expect(await waitedOrFinished(w.api.db, pid, using)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, used] = await Promise.all([removing, using])
    expect(removed.statusCode, removed.body).toBe(204)
    expect(used.statusCode, used.body).toBe(404)
    expect(await boardsOf(w.api, w.bob.userId)).toEqual([])
  })

  it('a use under way, then the user is removed from the workspace: the removal waits and sweeps the new owner grant', async () => {
    const w = await world()
    const pause = w.paused.arm(USE_HOLDS, 'after')
    const using = use(w.bob, w.template)
    const pid = await pause.reached
    const removing = removeMember(w.owner, w.bob.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [used, removed] = await Promise.all([using, removing])
    expect(used.statusCode, used.body).toBe(201)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.bob.userId)).toEqual([])
  })

  it('a member removal under way, then that member uses a template: the use waits, then 404, no board and no grant', async () => {
    const w = await world()
    const pause = w.paused.arm(/DELETE FROM workspace_members/, 'after')
    const removing = removeMember(w.owner, w.bob.userId)
    const pid = await pause.reached
    const using = use(w.bob, w.template)
    try {
      expect(await waitedOrFinished(w.api.db, pid, using)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, used] = await Promise.all([removing, using])
    expect(removed.statusCode, removed.body).toBe(200)
    expect(used.statusCode, used.body).toBe(404)
    expect(await boardsOf(w.api, w.bob.userId)).toEqual([])
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.bob.userId)).toEqual([])
  })

  it('uses at once give one board each, and a removal raced in at random never leaves a board after a 404', async () => {
    const w = await world()
    for (let i = 0; i < ITER; i++) {
      const before =
        (await boardsOf(w.api, w.bob.userId)).length + (await boardsOf(w.api, w.carol.userId)).length
      const res = await Promise.all([
        use(w.bob, w.template),
        use(w.carol, w.template),
        use(w.bob, w.template),
      ])
      for (const r of res) expect(r.statusCode, r.body).toBe(201)
      const ids = res.map((r) => r.json().board.id as string)
      expect(new Set(ids).size).toBe(3)
      const after =
        (await boardsOf(w.api, w.bob.userId)).length + (await boardsOf(w.api, w.carol.userId)).length
      expect(after - before).toBe(3)
    }
    // the last round with a removal in the middle: each use is made before it or refused after it
    const before = (await boardsOf(w.api, w.carol.userId)).length
    const [a, del, b] = await Promise.all([
      use(w.carol, w.template),
      removeTemplate(w.owner, w.template),
      use(w.carol, w.template),
    ])
    expect(del.statusCode, del.body).toBe(204)
    const made = [a, b].filter((r) => r.statusCode === 201).length
    for (const r of [a, b]) expect([201, 404], r.body).toContain(r.statusCode)
    expect((await boardsOf(w.api, w.carol.userId)).length - before).toBe(made)
  })
})
