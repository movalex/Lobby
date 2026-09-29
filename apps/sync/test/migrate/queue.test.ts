// The capped conversion worker and its process-wide queue (docs/EXCALIDRAW-MIGRATION.md §5.3 "Worker
// limits", §2.13, §6.2 "Conversion"): one job at a time; a planted job over the heap cap terminates only
// its worker (ERR_WORKER_OUT_OF_MEMORY) while this process keeps serving; the 60 s budget terminates a
// runaway job; the runtime RSS gate delays a job; a real conversion runs in the worker; a worker killed
// mid-job leaves the board on its tldraw tables.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tableDigest, tableNames } from '../../src/room/migrate/digest.ts'
import { MigrationQueue } from '../../src/room/migrate/queue.ts'
import { boardFileState, MigrationService } from '../../src/room/migrate/service.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { fixtureRecords, makeBornAfterFile, readDb, seedBoardRecords, tempDir } from './support.ts'

describe('MigrationQueue', () => {
  it('runs one job at a time, process-wide, in FIFO order; a second request for a board joins the first', async () => {
    const q = new MigrationQueue({ allowTestJobs: true })
    const seen: (string | null)[] = []
    const jobs = ['b-one', 'b-two', 'b-three'].map((boardId) =>
      q.enqueue({ kind: 'test-ok', boardId }, 'maintenance'),
    )
    const dup = q.enqueue({ kind: 'test-ok', boardId: 'b-two' }, 'maintenance')
    expect(dup).toBe(jobs[1])
    const poll = setInterval(() => seen.push(q.status().running), 1)
    const results = await Promise.all(jobs)
    clearInterval(poll)
    expect(results.every((r) => r.ok)).toBe(true)
    // never two running: the running id only ever moves forward through the FIFO
    const order = seen.filter((s, i) => s !== null && s !== seen[i - 1])
    expect(order.filter((s, i) => order.indexOf(s) !== i)).toEqual([])
    expect(q.status().boards.map((b) => [b.boardId, b.state])).toEqual([
      ['b-one', 'done'],
      ['b-three', 'done'],
      ['b-two', 'done'],
    ])
    await q.close()
  })

  it('a planted job over the heap cap terminates only its worker (out-of-memory); the next job runs', async () => {
    const q = new MigrationQueue({ allowTestJobs: true, runtimeCapMb: 32, timeBudgetMs: 60_000 })
    const alive = setInterval(() => {}, 5) // this process keeps its event loop
    const oom = await q.enqueue({ kind: 'test-oom', boardId: 'b-huge' }, 'runtime')
    expect(oom).toMatchObject({ ok: false, reason: 'out-of-memory' })
    const next = await q.enqueue({ kind: 'test-ok', boardId: 'b-small' }, 'runtime')
    expect(next.ok).toBe(true)
    clearInterval(alive)
    expect(q.status().boards.find((b) => b.boardId === 'b-huge')).toMatchObject({
      state: 'failed',
      reason: 'out-of-memory',
      capMb: 32,
    })
    await q.close()
  }, 60_000)

  it('the time budget terminates a runaway job', async () => {
    const q = new MigrationQueue({ allowTestJobs: true, timeBudgetMs: 400 })
    const r = await q.enqueue({ kind: 'test-spin', boardId: 'b-spin' }, 'maintenance')
    expect(r).toMatchObject({ ok: false, reason: 'time-budget' })
    await q.close()
  })

  it('the runtime gate waits while RSS + the cap is above 440 MB (after flushing caches), then runs', async () => {
    let rss = 400 * 1024 * 1024
    let flushes = 0
    const q = new MigrationQueue({
      allowTestJobs: true,
      runtimeCapMb: 64,
      rss: () => rss,
      flushCaches: () => {
        flushes++
      },
      gatePollMs: 20,
    })
    const job = q.enqueue({ kind: 'test-ok', boardId: 'b-wait' }, 'runtime')
    await new Promise((r) => setTimeout(r, 100))
    expect(q.status().boards[0]).toMatchObject({ boardId: 'b-wait', state: 'waiting-memory' })
    expect(flushes).toBeGreaterThan(1)
    rss = 300 * 1024 * 1024
    expect((await job).ok).toBe(true)
    // a maintenance job ignores the gate
    rss = 10_000 * 1024 * 1024
    expect((await q.enqueue({ kind: 'test-ok', boardId: 'b-maint' }, 'maintenance')).ok).toBe(true)
    await q.close()
  })

  it('refuses test jobs unless the queue allows them', async () => {
    const q = new MigrationQueue()
    expect(await q.enqueue({ kind: 'test-ok', boardId: 'b-x' }, 'maintenance')).toMatchObject({ ok: false })
    await q.close()
  })
})

describe('conversion in the worker', () => {
  it('converts a real board file in a fresh worker and reports its peak heap', async () => {
    const dataDir = tempDir()
    const rooms = join(dataDir, 'rooms')
    seedBoardRecords(rooms, 'b-tour00001', fixtureRecords('lobby-tour'))
    const svc = new MigrationService({ roomsDir: rooms, verifyLocalMode: true })
    const res = await svc.prepare('b-tour00001')
    expect(res).toEqual({ ready: true, did: 'converted' })
    expect(boardFileState(boardDbPath(rooms, 'b-tour00001'))).toBe('converted')
    const st = svc.status().boards.find((b) => b.boardId === 'b-tour00001')
    expect(st?.state).toBe('done')
    expect(st?.peakHeapUsedMb).toBeGreaterThan(0)
    // prepared again: nothing to do
    expect(await svc.prepare('b-tour00001')).toEqual({ ready: true, did: 'none' })
    await svc.close()
  }, 60_000)

  it('a worker terminated mid-job leaves the board on its tldraw tables', async () => {
    const dataDir = tempDir()
    const rooms = join(dataDir, 'rooms')
    // a board big enough that the job is still converting after 150 ms
    const base = fixtureRecords('lobby-tour')
    const many = [...base]
    for (let k = 0; k < 40; k++)
      for (const r of base)
        if (r.typeName === 'shape' && (r as unknown as { parentId: string }).parentId === 'page:page')
          many.push({
            ...r,
            id: `${r.id}-${k}`,
            y: ((r as unknown as { y: number }).y ?? 0) + k * 3000,
          } as never)
    const path = seedBoardRecords(rooms, 'b-slow00001', many)
    const before = readDb(path, (db) => ({ t: tableNames(db), d: tableDigest(db, 'documents') }))
    const svc = new MigrationService({ roomsDir: rooms, timeBudgetMs: 150, verifyLocalMode: true })
    const res = await svc.prepare('b-slow00001')
    expect(res).toEqual({ ready: false, reason: 'time-budget' })
    // give the terminated worker's handle a moment to be released, then check the file
    await new Promise((r) => setTimeout(r, 200))
    const after = readDb(path, (db) => ({ t: tableNames(db), d: tableDigest(db, 'documents') }))
    expect(after).toEqual(before)
    expect(boardFileState(path)).toBe('tldraw')
    await svc.close()
  }, 60_000)
})

describe('MigrationService.prepare', () => {
  it('leaves missing boards and boards born on the new canvas alone', async () => {
    const dataDir = tempDir()
    const rooms = join(dataDir, 'rooms')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(rooms, { recursive: true })
    makeBornAfterFile(boardDbPath(rooms, 'b-born00001'))
    const svc = new MigrationService({ roomsDir: rooms })
    expect(await svc.prepare('b-none00001')).toEqual({ ready: true, did: 'none' })
    expect(await svc.prepare('b-born00001')).toEqual({ ready: true, did: 'none' })
    expect(boardFileState(boardDbPath(rooms, 'b-born00001'))).toBe('element')
    expect(await svc.prepare('../etc')).toEqual({ ready: false, reason: 'bad-board-id' })
    await svc.close()
  })
})

describe('the migration routes (mounted behind the internal secret by the room)', () => {
  const call = async (route: { handle: (req: never, res: never, p: string[]) => unknown }) => {
    let status = 0
    let body = ''
    const res = {
      writeHead: (s: number) => {
        status = s
        return res
      },
      end: (b: string) => {
        body = b
      },
    }
    await route.handle({} as never, res as never, [])
    return { status, body: JSON.parse(body) as Record<string, unknown> }
  }

  it('POST convert-all starts the maintenance run (202) and GET status reports every board', async () => {
    const dataDir = tempDir()
    const rooms = join(dataDir, 'rooms')
    seedBoardRecords(rooms, 'b-rt0000001', fixtureRecords('retrospective'))
    seedBoardRecords(rooms, 'b-rt0000002', fixtureRecords('brainstorm'))
    const svc = new MigrationService({ roomsDir: rooms })
    const [all, status] = svc.routes()
    expect(all?.method).toBe('POST')
    expect(all?.path.test('/internal/migrate/convert-all')).toBe(true)
    expect(status?.path.test('/internal/migrate/status')).toBe(true)
    expect((await call(all as never)).status).toBe(202)
    for (let i = 0; i < 200 && svc.status().convertAll === 'running'; i++)
      await new Promise((r) => setTimeout(r, 50))
    const st = await call(status as never)
    expect(st.status).toBe(200)
    expect(
      (st.body.boards as { boardId: string; state: string; mode: string }[]).map((b) => [
        b.boardId,
        b.state,
        b.mode,
      ]),
    ).toEqual([
      ['b-rt0000001', 'done', 'maintenance'],
      ['b-rt0000002', 'done', 'maintenance'],
    ])
    expect(boardFileState(boardDbPath(rooms, 'b-rt0000001'))).toBe('converted')
    await svc.close()
  }, 60_000)
})
