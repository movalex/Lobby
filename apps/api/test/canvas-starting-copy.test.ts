// K6-1, wave K integration (the K6 review): a copy (duplicate, import, template, restore as new) asks which canvas
// sync runs BEFORE it seeds the new board's canvas. While the engine is unknown (the api just started and has
// not reached sync), the copy answers 503 CANVAS_STARTING and no canvas file was made: before, the seed ran
// first and the 503 came after it, leaving an orphan canvas file that no board row points at.
import { CANVAS_STARTING_ERROR } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasEngineProbe } from '../src/canvas-engine.ts'
import { baseRecords, createFakeSync, noteRec } from './features/history/helpers.ts'
import { createBoard, createTestApi, DEV_STUDIO, type TestApi } from './helpers.ts'

const UNKNOWN: CanvasEngineProbe = { current: async () => 'unknown', known: () => 'unknown' }
const apis: TestApi[] = []
afterEach(async () => {
  for (const api of apis.splice(0).reverse()) await api.close()
})

describe('K6-1: a copy while the engine is unknown', () => {
  it('duplicate answers 503 CANVAS_STARTING before any seed: no orphan canvas, no board row', async () => {
    const sync = createFakeSync()
    const first = await createTestApi({ deps: { syncInternal: sync } })
    apis.push(first)
    await first.login('alice')
    const bob = await first.login('bob')
    const board = await createBoard(bob, DEV_STUDIO, 'Source')
    sync.setBoard(board, [...baseRecords(), noteRec('n1', 'content')])
    // the same database, an api whose engine is still unknown (the deploy window)
    const api = await createTestApi({ db: first.db, deps: { syncInternal: sync, canvasEngine: UNKNOWN } })
    apis.push(api)
    const bob2 = await api.login('bob')
    const seeds = sync.seeds.length
    const rows = (await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')).n
    const res = await bob2.req('POST', `/api/boards/${board}/duplicate`, {})
    expect(res.statusCode, res.body).toBe(503)
    expect(res.json().error.code).toBe(CANVAS_STARTING_ERROR)
    // before the fix: one more seed (a canvas file for a board that was never made)
    expect(sync.seeds.length).toBe(seeds)
    expect((await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')).n).toBe(rows)
  })
})
