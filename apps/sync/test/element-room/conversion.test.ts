// Conversion on room open (docs/EXCALIDRAW-MIGRATION.md §5.3 "Lazy", §5.9 step 3, §2.13; §6.2
// `conversion`), through the real server process: O1's room calls O4's MigrationService before a board's
// room opens. A tldraw board is converted once, in the capped worker, while its joiners are held (notice
// PREPARING) and then admitted; a converted board whose tldraw side moved is rolled forward on open; a
// failed job (a worker over its heap cap) leaves the board on its tldraw tables, closes its joiners 4099
// CONVERSION_FAILED, is not re-queued by later joiners, and the process keeps serving other boards.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashElements } from '@draftroom/canvas-schema/hash'
import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { boardDbPath } from '../../src/rooms.ts'
import { callInternal } from '../harness/tickets.ts'
import {
  fileSha256,
  fixtureRecords,
  r0Edit,
  readDb,
  seedBoardRecords,
  tablesOf,
} from '../migrate/board-files.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

/** sha256 over the tldraw `documents` rows in id order (as the backup manifest's recordsSha256). */
const documentsDigest = (path: string) =>
  readDb(path, (db) => {
    const hash = createHash('sha256')
    for (const r of db.prepare('SELECT id, state FROM documents ORDER BY id').all() as {
      id: string
      state: string
    }[])
      hash.update(`${r.id}\n${r.state}\n`)
    return hash.digest('hex')
  })

const convertedFrom = (path: string) =>
  readDb(path, (db) => {
    const row = db.prepare("SELECT value FROM lb_meta WHERE key = 'converted_from'").get() as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as { cycle: number; documentClock: number }) : null
  })

const status = async (url: string) => {
  const res = await callInternal(url, 'GET', '/internal/migrate/status')
  expect(res.status).toBe(200)
  return (await res.json()) as {
    running: string | null
    queued: string[]
    boards: { boardId: string; kind: string; state: string; reason?: string }[]
  }
}

describe('conversion on room open', () => {
  it('holds the joiners of a tldraw board (PREPARING), converts it once and admits them; the tldraw tables stay untouched', async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    const boardId = newBoardId()
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
    const docsBefore = documentsDigest(path)
    const st = await h.stack({ dataDir })
    const a = await st.socket({ boardId, user: 'alice' })
    const b = await st.socket({ boardId, user: 'bob', tab: 'tab-bob' })
    const [wa, wb] = await Promise.all([a.hello(), b.hello()])
    for (const c of [a, b]) {
      expect(c.received[0]).toEqual({ type: 'notice', code: 'PREPARING' })
      expect(c.schemaErrors).toEqual([])
    }
    expect(wa.epoch).toBe(wb.epoch)
    const snap = await st.snapshot(boardId)
    expect(snap.elements.filter((e) => !e.isDeleted).length).toBeGreaterThan(10)
    const digest = await hashElements(snap.elements)
    expect(await a.hash()).toBe(digest)
    expect(await b.hash()).toBe(digest)
    // one job, done; the report next to the rooms folder
    const s = await status(st.server.url)
    expect(s.boards.filter((x) => x.boardId === boardId)).toEqual([
      expect.objectContaining({ boardId, kind: 'convert', state: 'done' }),
    ])
    const report = JSON.parse(readFileSync(join(dataDir, 'migration', `${boardId}.json`), 'utf8')) as {
      ok: boolean
    }
    expect(report.ok).toBe(true)
    // a later joiner is admitted at once, with no PREPARING
    const c = await st.client({ boardId, user: 'carol', tab: 'tab-carol' })
    expect(c.of('notice')).toEqual([])
    expect(await c.hash()).toBe(digest)
    // an edit lands as on any board
    const ack = await a.create([rect('after-conversion', { x: 10, y: 10 })])
    expect(ack.r.every((r) => r.ok)).toBe(true)
    await b.untilClock(ack.clock)
    expect(b.confirmed.has('after-conversion')).toBe(true)
    // the tldraw tables are untouched; converted_from is recorded
    await st.server.kill('SIGTERM')
    expect(documentsDigest(path)).toBe(docsBefore)
    expect(convertedFrom(path)).toMatchObject({ cycle: 0 })
  })

  it('the internal snapshot route converts a board it opens (and waits for a running job)', async () => {
    const dataDir = h.dataDir()
    const boardId = newBoardId()
    seedBoardRecords(join(dataDir, 'rooms'), boardId, fixtureRecords('kitchen-sink'))
    const st = await h.stack({ dataDir })
    const [live, test] = await Promise.all([
      callInternal(st.server.url, 'GET', `/internal/boards/${boardId}/snapshot`),
      st.snapshot(boardId),
    ])
    expect(live.status).toBe(200)
    const body = (await live.json()) as { elements: unknown[] }
    expect(body.elements.length).toBe(test.elements.filter((e) => !e.isDeleted).length)
    expect((await status(st.server.url)).boards.filter((x) => x.boardId === boardId)).toHaveLength(1)
  })

  it('rolls a converted board forward on open when its tldraw side moved during a rollback', async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    const boardId = newBoardId()
    seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
    const st1 = await h.stack({ dataDir })
    const a = await st1.client({ boardId, user: 'alice' })
    const before = a.confirmed.get('rect') as { x: number }
    expect(before).toBeTruthy()
    const epoch1 = a.epoch
    a.close()
    await st1.server.kill('SIGTERM')
    // R0 edits the tldraw side (the rollback)
    r0Edit(rooms, boardId, (txn) => {
      const r = txn.get('shape:rect') as TLRecord & { x: number }
      txn.set('shape:rect', { ...r, x: r.x + 250 } as TLRecord)
    })
    const st2 = await h.stack({ dataDir })
    const b = await st2.socket({ boardId, user: 'bob', tab: 'tab-bob' })
    await b.hello()
    expect(b.received[0]).toEqual({ type: 'notice', code: 'PREPARING' })
    expect((b.confirmed.get('rect') as { x: number }).x).toBeCloseTo(before.x + 250, 6)
    expect(b.epoch).not.toBe(epoch1)
    expect(await b.hash()).toBe(await hashElements((await st2.snapshot(boardId)).elements))
    expect(
      (await status(st2.server.url)).boards
        .filter((x) => x.boardId === boardId)
        .map((x) => [x.kind, x.state]),
    ).toEqual([['rollforward', 'done']])
    await st2.server.kill('SIGTERM')
    expect(convertedFrom(boardDbPath(rooms, boardId))).toMatchObject({ cycle: 1 })
  })

  it('a worker over its heap cap: joiners get 4099 CONVERSION_FAILED, the board stays on its tldraw tables and is not re-queued; other boards keep serving', async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    const boardId = newBoardId()
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
    const fileBefore = fileSha256(path)
    const tablesBefore = tablesOf(path)
    // a tiny runtime cap (test-only knob behind DRAFTROOM_TEST_HOOKS=1): the worker runs out of memory
    const st = await h.stack({ dataDir, env: { DRAFTROOM_TEST_MIGRATE_CAP_MB: '4' } })
    const other = await st.client({ boardId: newBoardId(), user: 'dave', tab: 'tab-dave' })
    const a = await st.socket({ boardId, user: 'alice' })
    a.send({ type: 'hello', proto: 1, schema: 1, since: 0, epoch: null, tab: a.tab })
    expect(await a.untilClosed(60_000)).toEqual({ code: 4099, reason: 'CONVERSION_FAILED' })
    // the CLOSING notice names the reason in band before the 4099 (SMK-2, CONTRACTS_REV 9)
    expect(a.received).toEqual([
      { type: 'notice', code: 'PREPARING' },
      { type: 'notice', code: 'CLOSING', detail: 'CONVERSION_FAILED' },
    ])
    const s1 = await status(st.server.url)
    expect(s1.boards.filter((x) => x.boardId === boardId)).toEqual([
      expect.objectContaining({ state: 'failed', reason: 'out-of-memory' }),
    ])
    // a later joiner is refused at once: no PREPARING, no second job
    const b = await st.socket({ boardId, user: 'bob', tab: 'tab-bob' })
    expect(await b.untilClosed()).toEqual({ code: 4099, reason: 'CONVERSION_FAILED' })
    expect(b.received).toEqual([{ type: 'notice', code: 'CLOSING', detail: 'CONVERSION_FAILED' }])
    expect((await status(st.server.url)).boards.filter((x) => x.boardId === boardId)).toEqual(
      s1.boards.filter((x) => x.boardId === boardId),
    )
    // the internal snapshot answers 503 unavailable
    const snap = await callInternal(st.server.url, 'GET', `/internal/boards/${boardId}/snapshot`)
    expect(snap.status).toBe(503)
    // the process and its other rooms keep serving
    const ack = await other.create([rect('still-serving', { x: 1, y: 1 })])
    expect(ack.clock).toBeGreaterThan(0)
    await st.server.kill('SIGTERM')
    expect(fileSha256(path)).toBe(fileBefore)
    expect(tablesOf(path)).toEqual(tablesBefore)
    expect(existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`).length : 0).toBe(0)
  })
})
