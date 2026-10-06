// CAP-L1 (wave J, apps/sync/src/room/warm-start.ts): after a crash the restarted sync opens the rooms the crash
// left open (their WAL is still there) and warms the parsers BEFORE its port opens, so that work is not inside
// the reconnect storm (B9's restarted process's first event-loop scrape). A board with a staged restore and a
// file that needs a conversion are left alone; a clean shutdown leaves no WAL, so nothing is opened then.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { crashedBoards, warmParsers, warmStart } from '../../src/room/warm-start.ts'
import { callInternal } from '../harness/tickets.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const T = 120_000

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'dr-j6-warm-'))
  dirs.push(d)
  return d
}

async function roomsOpen(url: string): Promise<number> {
  const text = await (await callInternal(url, 'GET', '/internal/metrics')).text()
  return Number(/^lobby_rooms_open (\d+)$/m.exec(text)?.[1] ?? Number.NaN)
}

describe('the warm start (CAP-L1)', () => {
  it('lists the boards whose WAL is still there, newest first; nothing else', () => {
    const d = tempDir()
    writeFileSync(join(d, 'board-aaa1.sqlite'), '')
    writeFileSync(join(d, 'board-aaa1.sqlite-wal'), 'x')
    writeFileSync(join(d, 'board-bbb2.sqlite'), '')
    writeFileSync(join(d, 'board-bbb2.sqlite-wal'), '') // an empty WAL: nothing to recover
    writeFileSync(join(d, 'board-ccc3.sqlite'), '') // no WAL: closed cleanly
    writeFileSync(join(d, 'board-ddd4.sqlite-wal'), 'y')
    writeFileSync(join(d, 'notes.txt-wal'), 'z')
    writeFileSync(join(d, 'board-BAD.sqlite-wal'), 'z')
    expect(crashedBoards(d).sort()).toEqual(['aaa1', 'ddd4'])
    expect(crashedBoards(join(d, 'missing'))).toEqual([])
  })

  it('opens what a crash left (not a staged restore, not a tldraw file), and warms every client message type', async () => {
    const d = tempDir()
    for (const id of ['brd-open', 'brd-staged', 'brd-tldraw']) {
      const db = new DatabaseSync(join(d, `board-${id}.sqlite`))
      if (id === 'brd-tldraw') db.exec('CREATE TABLE documents (id TEXT PRIMARY KEY, state BLOB)')
      else db.exec('CREATE TABLE lb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      db.close()
      // what a crash leaves next to the file (SQLite ignores a WAL without a valid header)
      writeFileSync(join(d, `board-${id}.sqlite-wal`), 'wal')
    }
    const opened: string[] = []
    const logs: string[] = []
    const r = await warmStart({
      roomsDir: d,
      open: async (b) => {
        opened.push(b)
        return true
      },
      staged: new Set(['brd-staged']),
      log: (...a) => logs.push(a.join(' ')),
    })
    expect(opened).toEqual(['brd-open'])
    expect(r).toMatchObject({ boards: 3, opened: 1, skipped: 2 })
    expect(r.parsed).toBeGreaterThan(5)
    expect(logs.join('\n')).toMatch(/warm start: 1 of 3 boards/)
    // nothing is opened without an opener (an engine without prepareBoard)
    expect((await warmStart({ roomsDir: d, open: undefined, staged: new Set(), log: () => {} })).opened).toBe(
      0,
    )
    // the parsers' warm-up takes any element shape (a refused one compiles too)
    expect(
      warmParsers([{ id: 'x', type: 'rectangle' }, rect('r1') as Record<string, unknown>]),
    ).toBeGreaterThan(10)
  })

  it(
    'after a SIGKILL the restarted server has the board’s room open before anyone reconnects; after a clean stop it has none',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create([rect('r1'), rect('r2', { x: 200 })])
      await st.server.kill('SIGKILL')
      await st.server.restart()
      // nobody reconnected yet: the warm start opened it
      expect(await roomsOpen(st.server.url)).toBe(1)
      expect(st.server.logs()).toMatch(/\[room\] warm start: 1 of 1 boards a crash left open opened/)
      // and it serves the board as before
      const again = await st.client({ boardId: b, user: 'alice' })
      expect([...again.confirmed.keys()].sort()).toEqual(['r1', 'r2'])
      again.close()
      // a clean stop closes the board file (SQLite removes its WAL): the next start opens nothing
      await st.server.kill('SIGTERM')
      await st.server.restart()
      expect(await roomsOpen(st.server.url)).toBe(0)
    },
    T,
  )

  it(
    'DRAFTROOM_WARM_START=off: the restarted server opens nothing until a joiner comes',
    async () => {
      const st = await h.stack({ env: { DRAFTROOM_WARM_START: 'off' } })
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create([rect('r1')])
      await st.server.kill('SIGKILL')
      await st.server.restart()
      expect(await roomsOpen(st.server.url)).toBe(0)
      expect(st.server.logs()).not.toMatch(/warm start/)
    },
    T,
  )
})
