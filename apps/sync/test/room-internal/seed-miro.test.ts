// POST /internal/boards/:bid/seed with a `miro-v2` body (wave R, WS1; room-internal/seed.ts, convert-miro.ts), against
// the REAL sync server process: the fixture board in Miro's documented shapes is converted in a worker thread and
// stored through the seed's own validation; the answer carries the report; bound arrow ends are exactly where the
// room's own re-snap puts them; no `import` doc key; an invalid body creates nothing; the worker's limits refuse.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type ArrowElementLike, boundEndsOffEdge, type EngineElement } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import type { ImportBoardReport } from '@draftroom/contracts'
import { fixtureBoards, fixtureSeedBody, SPRINT_ID, SPRINT_IDS } from '@draftroom/miro-import/fixtures'
import { describe, expect, it } from 'vitest'
import {
  convertMiroInWorker,
  miroRefusalError,
  miroSeedLimits,
} from '../../src/room-internal/convert-miro.ts'
import { Gate } from '../../src/room-internal/gate.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { call } from './support.ts'

const h = useElementHarness()

const sprint = () => {
  const b = fixtureBoards().find((x) => x.id === SPRINT_ID)
  if (!b) throw new Error('no fixture')
  return b
}

type Seeded = { boardId?: string; records?: number; report?: ImportBoardReport; error?: { code: string } }

describe('seed (miro-v2)', () => {
  it('converts the fixture board in a worker, stores what passes the room’s checks, answers with the report', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const body = fixtureSeedBody(sprint(), {
      [SPRINT_IDS.image]: {
        stored: {
          assetId: 'ast_Image000000001',
          versionId: 'ver_Image000000001',
          kind: 'image',
          name: 'diagram.png',
          mimeType: 'image/png',
          sizeBytes: 10,
        },
      },
    })
    const res = await call<Seeded>(st, 'POST', `/internal/boards/${b}/seed`, body)
    expect(res.status).toBe(201)
    const report = res.body.report as ImportBoardReport
    expect(report.total).toBe(body.items.length + body.connectors.length)
    expect(report.counts.native).toBeGreaterThan(10)
    const snap = await st.snapshot(b)
    expect(snap.elements.length).toBe(res.body.records)
    expect(checkInvariants(snap.elements)).toEqual([])
    // bound ends: exactly where the room's own re-snap would put them
    const map = new Map(snap.elements.map((e) => [e.id, e])) as unknown as ReadonlyMap<string, EngineElement>
    const arrows = snap.elements.filter((e) => e.type === 'arrow')
    expect(arrows.length).toBeGreaterThanOrEqual(4)
    for (const a of arrows) expect(boundEndsOffEdge(a as unknown as ArrowElementLike, map)).toBe(0)
    // the stored image is the version the api gave, nothing else is a file
    const images = snap.elements.filter((e) => e.type === 'image') as unknown as { fileId: string }[]
    expect(images.map((i) => i.fileId)).toEqual(['ver_Image000000001'])
    // a client opening the board reads it, with the board's tags and no `import` doc key
    const c = await st.client({ boardId: b, user: 'reader' })
    expect(c.welcome?.doc).toMatchObject({ 'tagDef:urgent': { name: 'Urgent', color: 'red' } })
    expect(Object.keys(c.welcome?.doc ?? {})).not.toContain('import')
  })

  it('an invalid body creates nothing (the id stays seedable)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const file = join(st.server.dataDir, 'rooms', `board-${b}.sqlite`)
    const bad = await call<Seeded>(st, 'POST', `/internal/boards/${b}/seed`, {
      format: 'miro-v2',
      items: 'x',
    })
    expect(bad.status).toBe(400)
    expect(existsSync(file)).toBe(false)
    const ok = await call<Seeded>(st, 'POST', `/internal/boards/${b}/seed`, fixtureSeedBody(sprint()))
    expect(ok.status).toBe(201)
    // and never over an existing board
    const again = await call<Seeded>(st, 'POST', `/internal/boards/${b}/seed`, fixtureSeedBody(sprint()))
    expect(again.status).toBe(409)
  })
})

describe('the Miro worker’s limits', () => {
  const body = () => fixtureSeedBody(sprint())
  const gate = () => new Gate({ concurrent: 1, maxQueue: 0 })

  it('converts within its budget', async () => {
    const out = await convertMiroInWorker(body(), 1, miroSeedLimits({}), gate())
    expect(out.ok).toBe(true)
  })

  it('refuses a body over its bytes, a worker over its time, an answer over its bytes, and when busy', async () => {
    const limits = miroSeedLimits({})
    expect(await convertMiroInWorker(body(), 1, { ...limits, maxBytes: 100 }, gate())).toEqual({
      ok: false,
      reason: 'too-large',
    })
    expect(await convertMiroInWorker(body(), 1, { ...limits, timeoutMs: 5 }, gate())).toEqual({
      ok: false,
      reason: 'time',
    })
    expect(await convertMiroInWorker(body(), 1, { ...limits, maxResultBytes: 100 }, gate())).toEqual({
      ok: false,
      reason: 'result-too-large',
    })
    expect(await convertMiroInWorker(body(), 1, limits, gate(), undefined, async () => false)).toEqual({
      ok: false,
      reason: 'busy',
    })
    expect(miroRefusalError('busy').status).toBe(503)
    expect(miroRefusalError('time').status).toBe(422)
    expect(miroRefusalError('memory').status).toBe(413)
  })

  it('environment overrides stay in range', () => {
    expect(miroSeedLimits({ DRAFTROOM_MIRO_SEED_TIMEOUT_MS: '2000' }).timeoutMs).toBe(2000)
    expect(miroSeedLimits({ DRAFTROOM_MIRO_SEED_TIMEOUT_MS: '999999' }).timeoutMs).toBe(30_000)
    expect(miroSeedLimits({ DRAFTROOM_MIRO_SEED_HEAP_MB: 'x' }).maxHeapMb).toBe(384)
  })
})
