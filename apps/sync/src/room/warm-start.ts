// The restart's warm start (CAP-L1, wave J; docs/research/excalidraw/spike-b/B9.md "Wave J"): work every
// reconnect after a crash pays for at once, done before the port opens instead (server-main.ts calls this
// between building the server and `listen()`, after the staged restores are known and before any socket).
//
// After a SIGKILL (an OOM kill, a host restart) every board that was open left its WAL file next to it
// (SQLite removes it when the last connection closes cleanly). Its sessions are reconnecting already. B9's
// restart profile (L1: 260 sessions on 21 boards) put the first second after `listen` at about 500 ms of
// main-thread work on the workstation, at the whole 0.5 CPU quota on the NAS, and the report's event-loop
// value is that second's: the rooms opened by their first joiner (file open, compaction, the caches: about
// 90 ms, the 4,000-element board alone 30-40 ms in one task), zod compiling every client message schema on
// its first parse (about 100 ms), the first `fetch` to the api loading undici and node:dns (about 30 ms),
// and the presence relay's first ranks (PRES-2 shares those). So, before the port opens:
//
//  - `crashedBoards`: the boards whose WAL is still there, newest first, at most WARM_START.maxBoards; a
//    board with a staged restore is left alone (the restore runs at listen, with no room open), and so is
//    one that needs a conversion (a tldraw file: its first joiner starts that, as before);
//  - each one's room is opened through the service (`prepareBoard`, as an internal route opens a board):
//    the same open as a joiner's, evicted after IDLE_EVICT_MS when nobody comes back;
//  - `warmParsers`: every client message type through the same zod schemas the room parses with, the ops
//    built from up to WARM_START.elementsPerType stored elements of each type of those boards;
//  - `warmFetch`: node:dns and the global fetch (undici) loaded.
//
// Bounded by WARM_START.budgetMs (boards past it open on demand, as before). Off with
// DRAFTROOM_WARM_START=off. Nothing here is written to a board (opening one is what a joiner does) and
// nothing of a board's content is logged: counts and times only.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ClientEnvelope,
  ELEMENT_SCHEMA_VERSION,
  GROUP_FIELDS,
  Op,
  PROTO,
} from '@draftroom/canvas-schema/protocol'
import { BOARD_FILE_RE, BOARD_ID_RE } from '../rooms.ts'
import { boardFileState } from './migrate/board-state.ts'

export const WARM_START = {
  /** boards opened at most (the newest WAL files first) */
  maxBoards: 64,
  /** the whole warm start's time, at most; a board past it opens on its first joiner, as before */
  budgetMs: 3_000,
  /** stored elements of each type whose create and patch ops warm the parsers */
  elementsPerType: 1,
  /** stored elements sampled in all (the schemas compile per element type, not per element) */
  maxSamples: 24,
} as const

/** The ids of the boards in `roomsDir` whose WAL file is still there (a crash left them open), newest first. */
export function crashedBoards(roomsDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(roomsDir)
  } catch {
    return []
  }
  const found: { id: string; at: number }[] = []
  for (const n of names) {
    if (!n.endsWith('.sqlite-wal')) continue
    const id = BOARD_FILE_RE.exec(n.slice(0, -'-wal'.length))?.[1]
    if (!id || !BOARD_ID_RE.test(id)) continue
    try {
      const st = statSync(join(roomsDir, n))
      if (st.size > 0) found.push({ id, at: st.mtimeMs })
    } catch {
      // gone meanwhile
    }
  }
  return found.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).map((f) => f.id)
}

/** Up to `perType` stored live elements of each type of one board file, read-only (the parsers' warm-up). */
export function sampleElements(path: string, perType: number): Record<string, unknown>[] {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const rows = db
      .prepare(
        `SELECT data FROM (SELECT data, row_number() OVER (PARTITION BY json_extract(data, '$.type')) AS n
           FROM lb_elements WHERE deleted = 0) WHERE n <= ?`,
      )
      .all(perType) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Record<string, unknown>)
  } catch {
    return []
  } finally {
    db?.close()
  }
}

/** A stored element as a client sends it in a create: without the server-owned `customData.lobbyServer`. */
function asClientElement(el: Record<string, unknown>): Record<string, unknown> {
  const cd = el.customData as Record<string, unknown> | undefined
  if (!cd || !('lobbyServer' in cd)) return el
  const { lobbyServer: _server, ...rest } = cd
  return { ...el, customData: rest }
}

/**
 * Parses one of every client message type, and the create and patch ops of `elements`, with the schemas the
 * room parses with (element-room.ts `message`), so zod compiles them now and not in the first reconnects.
 * Returns how many messages and ops went through (whatever their verdict: a refused one compiled too).
 */
export function warmParsers(elements: readonly Record<string, unknown>[]): number {
  const ops: unknown[] = []
  for (const raw of elements) {
    const el = asClientElement(raw)
    ops.push({ k: 'c', el })
    const pv = typeof el.version === 'number' ? el.version : 1
    for (const [group, fields] of Object.entries(GROUP_FIELDS)) {
      const g: Record<string, unknown> = {}
      for (const f of fields) if (f in el) g[f] = el[f]
      if (Object.keys(g).length) ops.push({ k: 'p', id: el.id, pv, g: { [group]: g } })
    }
    ops.push({ k: 'p', id: el.id, pv, c: { 'tag:warm': null } })
  }
  const view = { x: 0, y: 0, w: 1_920, h: 1_080 }
  const messages: unknown[] = [
    { type: 'hello', proto: PROTO, schema: ELEMENT_SCHEMA_VERSION, since: 1, epoch: 'warm' },
    { type: 'hello', proto: PROTO, schema: ELEMENT_SCHEMA_VERSION, since: 0, epoch: null },
    { type: 'presence', pointer: { x: 1, y: 2 }, button: 'up', sel: [], view, idle: false, editing: null },
    {
      type: 'presence',
      pointer: null,
      button: 'down',
      sel: ['warm'],
      view: { ...view, z: 1 },
      idle: true,
      editing: null,
      f: null,
      drag: { d: 1, ids: ['warm'], dx: 1, dy: 1 },
    },
    {
      type: 'presence',
      pointer: { x: 3, y: 4 },
      button: 'up',
      sel: [],
      view,
      idle: false,
      editing: 'warm',
      f: 'w:1',
      drag: { d: 1, dx: 2, dy: 2 },
    },
    { type: 'ping', n: 1 },
    { type: 'lease.acquire', req: 1, id: 'warm' },
    { type: 'lease.release', id: 'warm' },
    { type: 'receipts', req: 1, ids: ['warm.1'] },
    { type: 'push', seq: 1, base: 1, ops, rid: 'warm.1' },
    {
      type: 'push',
      seq: 2,
      base: 1,
      ops: [],
      doc: { set: { 'tagDef:warm': { name: 'warm', color: 'red' } } },
    },
  ]
  let n = 0
  for (const m of messages) {
    ClientEnvelope.safeParse(m)
    n++
  }
  for (const o of ops) {
    Op.safeParse(o)
    n++
  }
  return n
}

/** Loads node:dns and the global fetch (undici) now: the first access check would, inside the reconnects. */
export async function warmFetch(): Promise<void> {
  await import('node:dns')
  void (globalThis as { fetch?: unknown }).fetch
}

export interface WarmStartReport {
  readonly boards: number
  readonly opened: number
  readonly skipped: number
  readonly parsed: number
  /** of `ms`, the rooms' opening (and the samples' reads) */
  readonly opensMs: number
  readonly ms: number
}

/**
 * The warm start (the header): opens the rooms a crash left (`open`, the service's `prepareBoard`), skipping
 * `staged` boards and files that need a conversion, then warms the parsers and fetch. Never throws.
 */
export async function warmStart(o: {
  roomsDir: string
  open: ((boardId: string) => Promise<boolean>) | undefined
  staged: ReadonlySet<string>
  log: (...a: unknown[]) => void
  now?: () => number
}): Promise<WarmStartReport> {
  const now = o.now ?? (() => performance.now())
  const t0 = now()
  let opened = 0
  let skipped = 0
  const samples: Record<string, unknown>[] = []
  const boards = o.open ? crashedBoards(o.roomsDir).slice(0, WARM_START.maxBoards) : []
  for (const id of boards) {
    if (now() - t0 > WARM_START.budgetMs) {
      skipped++
      continue
    }
    const path = join(o.roomsDir, `board-${id}.sqlite`)
    const state = o.staged.has(id) ? 'staged' : boardFileState(path)
    if (state !== 'element' && state !== 'converted') {
      skipped++
      continue
    }
    try {
      // the room opens synchronously in this call (an element file needs no preparation)
      if (await (o.open as (b: string) => Promise<boolean>)(id)) opened++
      if (samples.length < WARM_START.maxSamples)
        samples.push(...sampleElements(path, WARM_START.elementsPerType))
    } catch (e) {
      skipped++
      o.log('[room] warm start: a board did not open', (e as Error)?.name ?? 'error')
    }
  }
  const opensMs = Math.round(now() - t0)
  let parsed = 0
  try {
    parsed = warmParsers(samples)
    await warmFetch()
  } catch (e) {
    o.log('[room] warm start: warm-up failed', (e as Error)?.name ?? 'error')
  }
  const report = { boards: boards.length, opened, skipped, parsed, opensMs, ms: Math.round(now() - t0) }
  o.log(
    `[room] warm start: ${opened} of ${boards.length} boards a crash left open opened, ${skipped} skipped, ${parsed} messages parsed, ${report.ms} ms (opening ${opensMs})`,
  )
  return report
}
