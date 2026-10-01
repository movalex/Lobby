// `POST /internal/migrate/drop-legacy` in the REAL Excalidraw sync process (docs/EXCALIDRAW-MIGRATION.md
// §5.9 step 5; the cut-over runbook's D7): the command needs an explicit confirmation, runs through the
// migration queue's worker one board at a time, refuses the boards whose window is open unless forced,
// shows every board's outcome at GET /internal/migrate/status, and the board it stripped still opens on
// the new canvas with every element. On 5caee00 the route did not exist (404).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { callInternal, errorCode } from '../harness/tickets.ts'
import { fixtureRecords, lbRows, readDb, seedBoardRecords, tablesOf } from './board-files.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Status {
  running: string | null
  queued: string[]
  convertAll: 'running' | 'idle'
  dropLegacy: 'running' | 'idle'
  boards: Array<{ boardId: string; kind: string; state: string; reason?: string }>
}

async function status(url: string): Promise<Status> {
  const res = await callInternal(url, 'GET', '/internal/migrate/status')
  expect(res.status).toBe(200)
  return (await res.json()) as Status
}

async function waitIdle(url: string, key: 'convertAll' | 'dropLegacy', timeoutMs = 60_000): Promise<Status> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = await status(url)
    if (s[key] === 'idle' && s.running === null && s.queued.length === 0) return s
    if (Date.now() > deadline) throw new Error(`${key} still running after ${timeoutMs} ms`)
    await sleep(50)
  }
}

describe('POST /internal/migrate/drop-legacy', () => {
  it('needs the confirmation, refuses inside the window, drops when forced, and the board still opens', {
    timeout: 120_000,
  }, async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    const boardId = newBoardId()
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
    const st = await h.stack({ dataDir })
    const url = st.server.url

    // the cut-over's conversion (confirmed: this stack is not in maintenance; audit L6), then the board's
    // lb_* state
    expect(
      (await callInternal(url, 'POST', '/internal/migrate/convert-all', { body: { confirm: true } })).status,
    ).toBe(202)
    await waitIdle(url, 'convertAll')
    expect(tablesOf(path)).toContain('documents')
    const rows = lbRows(path)
    expect(rows.size).toBeGreaterThan(0)

    // no confirmation, a wrong field, a bad board list: refused before anything starts
    expect(
      await errorCode(await callInternal(url, 'POST', '/internal/migrate/drop-legacy', { body: {} })),
    ).toBe('CONFIRM_REQUIRED')
    expect(
      await errorCode(
        await callInternal(url, 'POST', '/internal/migrate/drop-legacy', {
          body: { confirm: 'drop-legacy', yes: true },
        }),
      ),
    ).toBe('BAD_REQUEST')
    expect(
      await errorCode(
        await callInternal(url, 'POST', '/internal/migrate/drop-legacy', {
          body: { confirm: 'drop-legacy', boards: ['../x'] },
        }),
      ),
    ).toBe('BAD_REQUEST')
    expect((await status(url)).dropLegacy).toBe('idle')

    // confirmed, just converted: refused (the 7-day window), nothing dropped
    const first = await callInternal(url, 'POST', '/internal/migrate/drop-legacy', {
      body: { confirm: 'drop-legacy' },
    })
    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ started: true, boards: 1, force: false, dryRun: false })
    const refused = await waitIdle(url, 'dropLegacy')
    expect(refused.boards.find((b) => b.boardId === boardId)).toMatchObject({
      kind: 'drop-legacy',
      state: 'failed',
      reason: 'window',
    })
    expect(tablesOf(path)).toContain('documents')
    expect(st.server.logs()).toMatch(/\[drop-legacy\] .*: refused \(window\)/)

    // forced (the owner's call): the tldraw side goes; the report says it was forced
    const second = await callInternal(url, 'POST', '/internal/migrate/drop-legacy', {
      body: { confirm: 'drop-legacy', force: true, boards: [boardId] },
    })
    expect(second.status).toBe(202)
    const done = await waitIdle(url, 'dropLegacy')
    expect(done.boards.find((b) => b.boardId === boardId)).toMatchObject({
      kind: 'drop-legacy',
      state: 'done',
    })
    const tables = tablesOf(path)
    for (const t of [
      'documents',
      'metadata',
      'objects',
      'tombstones',
      'dr_deleted_records',
      'dr_deleted_schemas',
    ])
      expect(tables).not.toContain(t)
    const report = JSON.parse(
      readFileSync(join(dataDir, 'migration', `${boardId}.drop-legacy.json`), 'utf8'),
    ) as Record<string, unknown>
    expect(report).toMatchObject({ ok: true, forced: true, dryRun: false })
    expect(report.dropped).toContain('documents')
    expect(st.server.logs()).toMatch(/\[drop-legacy\] .*: dropped \d+ table\(s\) \(forced\)/)

    // the board still opens on the new canvas, with every live element
    const live = [...rows.values()].filter((r) => r.deleted === 0).length
    const a = await st.client({ boardId, user: 'alice' })
    expect([...a.confirmed.values()].filter((e) => e.isDeleted !== true)).toHaveLength(live)
    a.close()
    // the room recreated an empty lb_source; a third run has nothing to do
    expect(readDb(path, (db) => db.prepare('SELECT count(*) AS n FROM lb_source').get())).toEqual({ n: 0 })
    const third = await callInternal(url, 'POST', '/internal/migrate/drop-legacy', {
      body: { confirm: 'drop-legacy', dryRun: true },
    })
    expect(third.status).toBe(202)
    await waitIdle(url, 'dropLegacy')
    expect(st.server.logs()).toMatch(/\[drop-legacy\] .*: nothing to drop/)
  })
})
