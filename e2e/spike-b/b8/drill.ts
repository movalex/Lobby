// B8's rollback drill (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "Rollback drill", §5.9 step 6). O4.
//
//   node e2e/spike-b/b8/drill.ts --board <board-*.sqlite> --work <folder> --out <report.json>
//        [--excalidraw store|room] [--staging]
//
//  1. convert (the sync's migration service: the capped worker, one job at a time);
//  2. edit on Excalidraw (A): move a frame's child, recolour an element, create one, delete one;
//     `room` (the b8-drill specs) makes them in a browser on the Excalidraw build (O1's room, which also
//     converts and rolls forward on open), one edit at a time until Saved, each checked in the room's test
//     snapshot; `store` (this CLI's default, superseded) writes them as the room's store does;
//  3. run the R0 stand-in (the spike branch's tldraw sync with the born-after check, port 7900) on the
//     same file and edit (B) through today's tldraw client: an add, a delete (captured into dr_deleted_*),
//     a z-order change, an edit on page 2, a move of the frame whose child A moved, and a planted
//     same-group conflict (both recolour one element); it serves, backs up (a 1.5 s pass) and trims;
//     R0 never writes lb_*: every lb_* table has the same schema SQL and digest before and after, and
//     dr_deleted_* changed only by R0's own new rows; a board born on the new canvas (`room`: created on
//     the Excalidraw build), in the same data folder, is refused through a socket (4099 NEW_CANVAS_BOARD)
//     and every internal route (409 new-canvas), is byte-identical afterwards, gets no WAL frame, and never
//     appears in the backups, while a backup pass after the refusal backs the converted board up;
//  4. roll forward (the room-open path: `prepare`), and check §8.3's pass list (`room`: plus the rolled-
//     forward keys as a client sees them, and A's tab converging with the snapshot with 0 pushes);
//  5. once more (the second cycle): the merge runs against the refreshed lb_source.
//
// --staging (a restored staging copy, §8.6.7): SPIKE_B8_DIR must be set and --work inside it; the
// stand-in's data dir, TEMP/TMP and log stay inside it. The report holds ids, group names, counts and
// hashes only; nothing is printed but counts.

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import type { ConvertReport } from '../../../apps/sync/src/room/migrate/convert-board.ts'
import { lbDigests, tableDigest } from '../../../apps/sync/src/room/migrate/digest.ts'
import type { RollForwardReport } from '../../../apps/sync/src/room/migrate/rollforward.ts'
import { MigrationService } from '../../../apps/sync/src/room/migrate/service.ts'
import type { ConvertedFrom } from '../../../apps/sync/src/room/schema.ts'
import type { ShapeRecord } from '../../../apps/sync/test/harness/records.ts'
import { NodeSyncClient } from '../../../apps/sync/test/harness/sync-client.ts'
import { mintTicket } from '../../../apps/sync/test/harness/tickets.ts'
import {
  excalidrawCreate,
  excalidrawEdit,
  fileSha256,
  type LbRow,
  lbRows,
  makeBornAfterFile,
  readDb,
  tablesOf,
  walBytes,
} from '../../../apps/sync/test/migrate/board-files.ts'
import { indexKeyBetween } from '../../../packages/canvas-schema/src/engine/fractional.ts'
import { elementIdOf } from '../../../packages/tldraw-import/src/convert.ts'
import { callInternal, startSync } from './stand-in.ts'

/** O4 runs the stand-in on 7900; the lead's integration pass sets SPIKE_B8_STANDIN_PORT inside 7850-7859 (§8.6.8). */
export const STAND_IN_PORT = Number(process.env.SPIKE_B8_STANDIN_PORT ?? 7900)
const USER = 'usr_b8drill00001'

type Rec = Record<string, unknown> & { id: string; typeName: string }
interface Check {
  readonly name: string
  readonly pass: boolean
  /** ids or counts only */
  readonly detail?: string
}

export interface DrillReport {
  readonly boardId: string
  readonly ok: boolean
  readonly excalidraw: 'store' | 'room'
  /** the conversion (counts and timings only) */
  readonly conversion: {
    readonly ok: boolean
    readonly recordsIn: number
    readonly elementsOut: number
    readonly ms: number
    readonly wallMs: number
    readonly invariants: string | null
    readonly violations: number | null
    readonly peakHeapTotalMb: number
  } | null
  readonly setup: readonly Check[]
  readonly cycles: readonly {
    readonly cycle: number
    readonly checks: readonly Check[]
    readonly conflicts: RollForwardReport['conflicts']
    readonly counts: RollForwardReport['counts'] | null
    readonly resnap: string | null
    readonly invariants: string | null
    readonly violations: number | null
    readonly ms: number | null
    /** wall times: A's edits, the stand-in (start, B, born-after, stop), the roll-forward on open */
    readonly wallMs: { readonly a: number | null; readonly standIn: number; readonly rollForward: number }
    readonly aPushes: number | null
    readonly aClock: { readonly at: number; readonly quiet: number } | null
    /** the WAL the stand-in left beside the board file (bytes; null: none) */
    readonly walAfterStandIn: number | null
    readonly afterRollForward: {
      readonly trigger: string
      readonly elements: number
      readonly snapshotHash: string
      readonly mergedHash: string | null
      readonly snapshotEqualsMerged: boolean
    } | null
  }[]
  /** the board the born-after refusal used (a board created on the Excalidraw build with `room`) */
  readonly bornAfterBoard: string
  /** both cycles' born-after checks, prefixed `cycle <n>: ` */
  readonly bornAfter: readonly Check[]
  readonly applicable: Readonly<Record<string, boolean>>
}

const inside = (child: string, parent: string) => {
  const r = relative(resolve(parent), resolve(child))
  return !!r && !r.startsWith('..') && !r.includes(':')
}

function sourceRecords(path: string): Rec[] {
  return readDb(path, (db) =>
    (
      db.prepare('SELECT state FROM documents ORDER BY id').all() as Array<{ state: Uint8Array | string }>
    ).map(
      (r) => JSON.parse(typeof r.state === 'string' ? r.state : Buffer.from(r.state).toString('utf8')) as Rec,
    ),
  )
}

const cfOf = (path: string) =>
  readDb(
    path,
    (db) =>
      JSON.parse(
        (db.prepare("SELECT value FROM lb_meta WHERE key = 'converted_from'").get() as { value: string })
          .value,
      ) as ConvertedFrom,
  )

/** tldraw geos the converter maps to one native element (the others become a container plus an outline line). */
const NATIVE_GEOS = new Set(['rectangle', 'ellipse', 'diamond'])

/**
 * Picks the drill's targets by structure only (ids, types, parents, the lock flag, the geo kind): never by
 * content. Each role takes a different shape; a role with no candidate is reported as not applicable for
 * that board and cycle. Locked shapes are never picked (the room refuses A's edits of them, LOCKED, as the
 * product does; a user unlocks first). The planted conflict takes a shape whose colour lives on the element
 * A recolours (a note, or a geo the converter maps to one native element: a polygon geo's colour is on its
 * outline line, so A's recolour of the container and B's recolour of the outline are different elements).
 * No other role takes a descendant of the moved frame (B's frame move moves them all).
 */
function pickTargets(records: readonly Rec[], used: ReadonlySet<string>) {
  const shapes = records.filter((r) => r.typeName === 'shape').sort((a, b) => (a.id < b.id ? -1 : 1))
  const pages = records
    .filter((r) => r.typeName === 'page')
    .sort((a, b) => (String(a.index) < String(b.index) ? -1 : 1))
  const pageIds = new Set(pages.map((p) => p.id))
  const open = (s: Rec) => s.isLocked !== true
  const box = (s: Rec) => ['note', 'geo', 'text'].includes(String(s.type)) && open(s)
  const coloured = (s: Rec) =>
    open(s) &&
    (s.type === 'note' ||
      (s.type === 'geo' && NATIVE_GEOS.has(String((s.props as Record<string, unknown> | undefined)?.geo))))
  const descendantsOf = (id: string): Set<string> => {
    const out = new Set<string>()
    let frontier = [id]
    while (frontier.length) {
      const next: string[] = []
      for (const s of shapes)
        if (frontier.includes(String(s.parentId)) && !out.has(s.id)) {
          out.add(s.id)
          next.push(s.id)
        }
      frontier = next
    }
    return out
  }
  const pageOf = (s: Rec): string | undefined => {
    let cur: Rec | undefined = s
    for (let i = 0; cur && i < 64; i++) {
      if (pageIds.has(String(cur.parentId))) return String(cur.parentId)
      cur = shapes.find((x) => x.id === cur?.parentId)
    }
    return undefined
  }
  const firstPage = pages[0]?.id
  const frame = shapes.find(
    (f) =>
      f.type === 'frame' &&
      open(f) &&
      !used.has(f.id) &&
      shapes.some((c) => c.parentId === f.id && box(c) && !used.has(c.id)),
  )
  const child = frame ? shapes.find((c) => c.parentId === frame.id && box(c) && !used.has(c.id)) : undefined
  const frameDescendants = frame ? descendantsOf(frame.id) : new Set<string>()
  const taken = new Set([...used, frame?.id, child?.id].filter(Boolean) as string[])
  const next = (pred: (s: Rec) => boolean) => {
    const s = shapes.find((r) => !taken.has(r.id) && !frameDescendants.has(r.id) && pred(r))
    if (s) taken.add(s.id)
    return s
  }
  const page2 = pages[1] ? next((s) => box(s) && pageOf(s) === pages[1]?.id) : undefined
  const bReorder = next((s) => (box(s) || (s.type === 'frame' && open(s))) && pageIds.has(String(s.parentId)))
  const conflict = next(coloured)
  const aDelete = next(box)
  const bDelete = next(box)
  const siblings = bReorder
    ? shapes
        .filter((x) => x.parentId === bReorder.parentId)
        .map((x) => String(x.index))
        .sort()
    : []
  const template = shapes.find((x) => box(x))
  return {
    frame,
    child,
    frameDescendants: [...frameDescendants].sort(),
    conflict,
    aDelete,
    bDelete,
    bReorder,
    page2,
    firstPage,
    lowest: siblings[0] ?? null,
    template,
  }
}

/** The WAL beside a board file: its size and digest (0 and null without one). */
function walState(path: string): { bytes: number; sha: string | null } {
  const wal = `${path}-wal`
  return existsSync(wal) ? { bytes: walBytes(path), sha: fileSha256(wal) } : { bytes: 0, sha: null }
}

const backupNames = (dir: string): Set<string> =>
  new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sqlite')) : [])

async function standInEdits(
  work: string,
  dataDir: string,
  boardId: string,
  t: ReturnType<typeof pickTargets>,
  cycle: number,
  staging: boolean,
  bornId: string,
): Promise<{ added: string; bornAfter: Check[]; ms: number }> {
  const t0 = Date.now()
  const bornPath = join(dataDir, 'rooms', `board-${bornId}.sqlite`)
  if (!existsSync(bornPath)) makeBornAfterFile(bornPath)
  const bornBefore = { sha: fileSha256(bornPath), tables: tablesOf(bornPath), wal: walState(bornPath) }
  const backups = join(dataDir, 'backups')
  const sync = await startSync({
    port: STAND_IN_PORT,
    dataDir,
    engine: 'tldraw',
    ...(staging ? { tempDir: join(work, 'tmp') } : {}),
    logFile: join(work, 'logs', `stand-in-cycle${cycle}.log`),
    env: { DRAFTROOM_BACKUP_INTERVAL_MS: '1500', IDLE_EVICT_MS: '60000' },
  })
  const added = `shape:drill-b-add-${cycle}`
  const bornAfter: Check[] = []
  let addedMade = false
  try {
    const c = new NodeSyncClient({ wsUrl: sync.wsUrl, boardId, user: USER, name: 'B', autoReconnect: false })
    try {
      await c.waitForSynced(30_000)
      const get = (id: string) => c.get(id) as unknown as Rec | undefined
      const put = (r: Rec) => c.put(r as unknown as ShapeRecord)
      const template = t.template ? get(t.template.id) : undefined
      addedMade = !!(template && t.firstPage)
      if (template && t.firstPage)
        put({
          ...template,
          id: added,
          parentId: t.firstPage,
          x: 5_000 + cycle * 300,
          y: 5_000,
          index: 'a1V',
          meta: {},
        })
      if (t.bDelete) c.remove(t.bDelete.id)
      if (t.bReorder && t.lowest)
        put({ ...(get(t.bReorder.id) as Rec), index: indexKeyBetween(null, t.lowest) })
      if (t.page2) put({ ...(get(t.page2.id) as Rec), x: Number(get(t.page2.id)?.x) + 40 })
      if (t.frame) put({ ...(get(t.frame.id) as Rec), x: Number(get(t.frame.id)?.x) + 120 })
      if (t.conflict) {
        const r = get(t.conflict.id) as Rec
        const props = r.props as Record<string, unknown>
        put({ ...r, props: { ...props, color: props.color === 'red' ? 'green' : 'red' } })
      }
      await c.waitForAcked(30_000)
    } finally {
      c.dispose()
    }
    // a backup pass runs while the board is open (every 1.5 s; the room stays open for IDLE_EVICT_MS)
    await new Promise((r) => setTimeout(r, 2_500))
    // born after the cut-over: refused through a socket and every internal route
    // Node's own WebSocket client (the page's socket, as a browser opens it)
    const closed = await new Promise<{ code: number; reason: string }>((done) => {
      const ws = new WebSocket(
        `${sync.wsUrl}/connect/${bornId}?sessionId=s1&ticket=${encodeURIComponent(mintTicket(bornId, USER))}`,
      )
      ws.addEventListener('close', (ev) => done({ code: ev.code, reason: ev.reason }))
    })
    bornAfter.push({
      name: 'socket refused 4099 NEW_CANVAS_BOARD',
      pass: closed.code === 4099 && closed.reason === 'NEW_CANVAS_BOARD',
    })
    const routes: Array<[string, string, unknown?]> = [
      ['GET', 'snapshot'],
      ['GET', 'text'],
      ['GET', 'asset-refs'],
      ['GET', 'deleted'],
      ['POST', 'deleted/restore', { ids: ['shape:x'] }],
      ['POST', 'seed', { snapshot: { schema: { schemaVersion: 2, sequences: {} }, documents: [] } }],
      [
        'POST',
        'place-notes',
        {
          sessionId: 'pbs_0000000000',
          anonymous: true,
          frame: { id: 'shape:f', pageId: 'page:page', x: 0, y: 0, w: 400, h: 300, name: 'F' },
          notes: [{ id: 'pnt_0000000000', text: 'n', color: 'yellow', authorId: null }],
          authors: [],
        },
      ],
    ]
    for (const [method, route, body] of routes) {
      const res = await callInternal(sync, method, `/internal/boards/${bornId}/${route}`, body)
      const code =
        res.status === 409 ? ((await res.json()) as { error?: { code?: string } }).error?.code : undefined
      bornAfter.push({
        name: `${method} ${route} → 409 new-canvas`,
        pass: res.status === 409 && code === 'new-canvas',
        detail: String(res.status),
      })
    }
    // The backup timer after the refusal (§8.3 B8 "That covers the periodic backup timer"): B changes its
    // added shape once more, so the next pass has a changed open board to back up; a new backup of the
    // converted board must appear (the timer ran after the refusal) while the refused board gets none.
    const namesBefore = backupNames(join(backups, boardId))
    let passAfter = false
    if (addedMade) {
      const c2 = new NodeSyncClient({
        wsUrl: sync.wsUrl,
        boardId,
        user: USER,
        name: 'B',
        autoReconnect: false,
      })
      try {
        await c2.waitForSynced(30_000)
        const cur = c2.get(added) as unknown as Rec | undefined
        if (cur) c2.put({ ...cur, x: Number(cur.x) + 10 } as unknown as ShapeRecord)
        await c2.waitForAcked(30_000)
      } finally {
        c2.dispose()
      }
      const deadline = Date.now() + 15_000
      while (!passAfter && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
        passAfter = [...backupNames(join(backups, boardId))].some((f) => !namesBefore.has(f))
      }
    }
    bornAfter.push({
      name: 'the backup timer ran after the refusal (a new backup of the converted board)',
      pass: passAfter,
      ...(addedMade ? {} : { detail: 'no shape to change' }),
    })
  } finally {
    await sync.stop('SIGINT')
  }
  const walAfter = walState(bornPath)
  bornAfter.push(
    { name: 'born-after file byte-identical (sha256)', pass: fileSha256(bornPath) === bornBefore.sha },
    {
      name: 'born-after tables unchanged (no documents, metadata, dr_deleted_*)',
      pass: JSON.stringify(tablesOf(bornPath)) === JSON.stringify(bornBefore.tables),
    },
    {
      // an empty WAL (a read-only open may leave one, with its -shm) holds no frames; a non-empty one must
      // be the one that was there before, untouched
      name: 'born-after: no WAL frames written',
      pass:
        walAfter.bytes === 0 ||
        (walAfter.bytes === bornBefore.wal.bytes && walAfter.sha === bornBefore.wal.sha),
      detail: `${bornBefore.wal.bytes} -> ${walAfter.bytes} bytes`,
    },
    { name: 'born-after: never in the stand-in backups', pass: !existsSync(join(backups, bornId)) },
    {
      name: 'the stand-in backed the converted board up while serving it',
      pass: backupNames(join(backups, boardId)).size > 0,
    },
  )
  return { added, bornAfter, ms: Date.now() - t0 }
}

/** A's edits of one cycle (element ids; the drill checks their effects). */
export interface AEdits {
  readonly cycle: number
  /** move +60 in x */
  readonly move: string | null
  /** set backgroundColor to `color` */
  readonly recolor: string | null
  readonly color: string
  readonly remove: string | null
  /** create a copy of `templateId` with this id at (-9000, -9000), at the top of the order */
  readonly create: { readonly id: string; readonly templateId: string }
}

/** What A's edits of one cycle did. */
export interface AResult {
  /** the id of the element A created */
  readonly createdId: string
  /** per edit (move, recolor, remove, create): whether the room stored it (`room`: its test snapshot) */
  readonly stored?: Readonly<Record<string, boolean>>
  /** edits whose tab never showed Saved: what it showed instead (state, pending, reject code) */
  readonly notSaved?: Readonly<Record<string, string>>
  readonly ms?: number
  /** pushes of A's tab since it opened the board (`room`) */
  readonly pushes?: number | null
  /** the tab's server clock at its welcome and when the board went quiet, before A's first edit */
  readonly clock?: { readonly at: number; readonly quiet: number }
}

/** A's tab on the rolled-forward board (`room`). */
export interface AfterRollForward {
  readonly converged: boolean
  readonly pushes: number
  /** the pushed ops: ids, kinds, group and field names only */
  readonly ops: readonly string[]
  /** what ran the roll-forward: the test snapshot route before any tab, or A's tab as the joiner */
  readonly trigger: 'snapshot-route' | 'joiner'
  /** the rolled-forward board's z-order key problems as the room serves it (ids and reasons) */
  readonly indexProblems: readonly string[]
  readonly snapshotHash: string
  readonly elements: number
}

/**
 * How the Excalidraw side runs. `room` (the evidence since conversion on open, B8 phase 3): the spec
 * passes these hooks (e2e/spike-b/b8/excalidraw-side.ts), which make A's edits through the Excalidraw
 * build (its browser and the facade) and run the conversion and the roll-forward by opening the board on
 * the Excalidraw stack (O1's room calling the migration service). `store` (before M1, superseded): A's
 * edits written as the room's store writes them, conversion and roll-forward through the migration
 * service in this process; its delete does not cascade to a container's label as the room does.
 */
export interface ExcalidrawSide {
  /** the board file is in place and nothing holds it: convert it (open the board) */
  convert(boardId: string): Promise<void>
  /**
   * A board created on the Excalidraw build, for the born-after refusal (`room`); without it the drill
   * writes a born-after file itself (an lb_* file with no converted_from).
   */
  bornAfter?(): Promise<string>
  applyA(boardId: string, edits: AEdits): Promise<AResult>
  /** stop everything that holds the board file on the Excalidraw side (before the stand-in opens it) */
  release(boardId: string): Promise<void>
  /** roll forward (open the board on the Excalidraw side again) */
  rollForward(boardId: string): Promise<void>
  /** after `rollForward`: A's tab against the room's test snapshot */
  afterRollForward?(boardId: string): Promise<AfterRollForward>
}

export async function runDrill(opts: {
  board: string
  work: string
  excalidraw: 'store' | 'room'
  staging?: boolean
  cycles?: number
  /** required with `excalidraw: 'room'` */
  side?: ExcalidrawSide
  /** the data dir the board lives in (default <work>/data; the Excalidraw stack's with `room`) */
  dataDir?: string
  /** the board id to drill under (default: from the file name; a board the stack's api knows with `room`) */
  boardId?: string
}): Promise<DrillReport> {
  if (opts.excalidraw === 'room' && !opts.side)
    throw new Error(
      "excalidraw 'room' needs the Excalidraw side's hooks (the b8-drill spec passes them, from M1)",
    )
  if (opts.staging) {
    const b8 = process.env.SPIKE_B8_DIR
    if (!b8 || !inside(opts.work, b8))
      throw new Error('--staging needs SPIKE_B8_DIR and a --work folder inside it')
    const tmp = join(opts.work, 'tmp')
    mkdirSync(tmp, { recursive: true })
    process.env.TEMP = tmp
    process.env.TMP = tmp
  }
  const boardId =
    opts.boardId ?? ((/^board-(.+)\.sqlite$/.exec(basename(opts.board)) as RegExpExecArray)[1] as string)
  const dataDir = opts.dataDir ?? join(opts.work, 'data')
  if (!opts.dataDir) rmSync(opts.work, { recursive: true, force: true })
  const rooms = join(dataDir, 'rooms')
  mkdirSync(rooms, { recursive: true })
  const path = join(rooms, `board-${boardId}.sqlite`)
  cpSync(opts.board, path)
  if (existsSync(`${opts.board}-wal`)) cpSync(`${opts.board}-wal`, `${path}-wal`)
  const reportDir = join(dataDir, 'migration')
  const svc = new MigrationService({ roomsDir: rooms, reportDir, verifyLocalMode: true })
  const cycles: DrillReport['cycles'][number][] = []
  let bornAfter: Check[] = []
  const applicable: Record<string, boolean> = {}
  const used = new Set<string>()
  const side: ExcalidrawSide = opts.side ?? {
    convert: async (id) => {
      const conv = await svc.prepare(id)
      if (!conv.ready || conv.did !== 'converted')
        throw new Error(`conversion failed (${conv.ready ? conv.did : conv.reason})`)
    },
    applyA: async (_id, e): Promise<AResult> => {
      if (e.move)
        excalidrawEdit(path, e.move, ['pos'], (x) => {
          x.x = Number(x.x) + 60
        })
      if (e.recolor)
        excalidrawEdit(path, e.recolor, ['style'], (x) => {
          x.backgroundColor = e.color
        })
      if (e.remove)
        excalidrawEdit(path, e.remove, ['life'], (x) => {
          x.isDeleted = true
        })
      const rows = lbRows(path)
      const lastIdx =
        [...rows.values()]
          .map((r) => r.idx)
          .sort()
          .at(-1) ?? 'a0'
      excalidrawCreate(path, {
        ...JSON.parse(rows.get(e.create.templateId)?.data ?? '{}'),
        id: e.create.id,
        x: -9_000,
        y: -9_000,
        groupIds: [],
        frameId: null,
        boundElements: null,
        customData: undefined,
        index: indexKeyBetween(lastIdx, null),
        version: 1,
      })
      return { createdId: e.create.id }
    },
    release: async () => {},
    rollForward: async (id) => {
      const rf = await svc.prepare(id)
      if (!rf.ready || rf.did !== 'rolled-forward')
        throw new Error(`roll-forward failed (${rf.ready ? rf.did : rf.reason})`)
    },
  }
  const setup: Check[] = []
  let conversion: DrillReport['conversion'] = null
  let bornId = 'b8-born-after'
  try {
    const tc = Date.now()
    await side.convert(boardId)
    const convertWallMs = Date.now() - tc
    const conv = readConvertReport(reportDir, boardId)
    conversion = conv
      ? {
          ok: conv.ok,
          recordsIn: conv.recordsIn,
          elementsOut: conv.elementsOut,
          ms: conv.ms,
          wallMs: convertWallMs,
          invariants: conv.invariants ?? null,
          violations: conv.violations?.length ?? null,
          peakHeapTotalMb: conv.peakHeapTotalMb,
        }
      : null
    setup.push({
      name: 'converted on open: report ok, the invariant checker ran, 0 violations',
      pass: !!conv?.ok && conv.invariants === 'ran' && (conv.violations?.length ?? 0) === 0,
    })
    if (side.bornAfter) bornId = await side.bornAfter()
    await side.release(boardId)
    for (let cycle = 1; cycle <= (opts.cycles ?? 2); cycle++) {
      const checks: Check[] = []
      const recordsBefore = sourceRecords(path)
      const t = pickTargets(recordsBefore, used)
      for (const s of [t.frame, t.child, t.conflict, t.aDelete, t.bDelete, t.bReorder, t.page2])
        if (s) used.add(s.id)
      Object.assign(applicable, {
        [`cycle${cycle}:frame-move-with-child`]: !!(t.frame && t.child),
        [`cycle${cycle}:conflict`]: !!t.conflict,
        [`cycle${cycle}:page-2-edit`]: !!t.page2,
        [`cycle${cycle}:z-order`]: !!(t.bReorder && t.lowest),
        [`cycle${cycle}:delete`]: !!t.bDelete,
      })
      const el = (id: string) => elementIdOf(id)
      const before0 = lbRows(path)
      const x0 = (id: string) => Number(JSON.parse(before0.get(el(id))?.data ?? '{}').x)
      void pickTargets
      // ---- A (Excalidraw)
      const wantNew = `drill-a-new-${cycle}`
      const templateId =
        [...before0.values()].find((r) => !r.deleted && (r.type === 'rectangle' || r.type === 'stickynote'))
          ?.id ?? ''
      const aRes = await side.applyA(boardId, {
        cycle,
        move: t.child ? el(t.child.id) : null,
        recolor: t.conflict ? el(t.conflict.id) : null,
        color: `#1234${cycle}${cycle}`,
        remove: t.aDelete ? el(t.aDelete.id) : null,
        create: { id: wantNew, templateId },
      })
      const aNew = aRes.createdId
      if (aRes.stored)
        checks.push({
          name: "A's edits stored before R0 (the room's test snapshot)",
          pass: Object.values(aRes.stored).every(Boolean),
          detail: [
            ...Object.entries(aRes.stored).map(([k, v]) => `${k} ${v}`),
            ...Object.entries(aRes.notSaved ?? {}).map(([k, v]) => `${k} not saved: ${v}`),
          ].join(', '),
        })
      await side.release(boardId)
      const beforeR0 = lbRows(path)
      const lbBefore = readDb(path, lbDigests)
      const drBefore = readDb(path, (db) => ({
        max: Number(
          (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM dr_deleted_records').get() as { m: number }).m,
        ),
      }))
      const drOld = readDb(path, (db) => tableDigestUpTo(db, drBefore.max))
      // ---- B (R0 stand-in)
      const {
        added,
        bornAfter: born,
        ms: standInMs,
      } = await standInEdits(opts.work, dataDir, boardId, t, cycle, !!opts.staging, bornId)
      bornAfter = [...bornAfter, ...born.map((c) => ({ ...c, name: `cycle ${cycle}: ${c.name}` }))]
      const walAfterStandIn = existsSync(`${path}-wal`) ? walBytes(path) : null
      checks.push({
        name: 'R0 never wrote lb_* (schema SQL and digest of every lb_* table)',
        pass: JSON.stringify(readDb(path, lbDigests)) === JSON.stringify(lbBefore),
      })
      checks.push({
        name: "dr_deleted_* changed only by R0's own rows",
        pass: readDb(path, (db) => tableDigestUpTo(db, drBefore.max)) === drOld,
      })
      // ---- roll forward (the room-open path)
      let rfError: string | null = null
      const tr = Date.now()
      try {
        await side.rollForward(boardId)
      } catch (e) {
        rfError = (e as Error).message.replace(/[^a-z0-9 ():_-]/gi, '').slice(0, 80)
      }
      const rollForwardWallMs = Date.now() - tr
      const report = JSON.parse(readReport(reportDir, boardId)) as RollForwardReport
      checks.push({
        name: 'roll-forward ran',
        pass: rfError === null && report.ok === true && report.cycle === cycle,
        ...(rfError || report.reason
          ? {
              detail: [rfError, report.reason, report.failures?.map((f) => `${f.id} ${f.code}`).join(' ')]
                .filter(Boolean)
                .join('; '),
            }
          : {}),
      })
      let afterRf: AfterRollForward | null = null
      if (side.afterRollForward && rfError === null) {
        afterRf = await side.afterRollForward(boardId)
        checks.push(
          {
            name: 'after the roll-forward: every z-order key valid and unique (live and tombstones), labels after their containers',
            pass: afterRf.indexProblems.length === 0,
            detail: afterRf.indexProblems.slice(0, 10).join('; '),
          },
          {
            name: "after the roll-forward: A's tab converges with the room's test snapshot",
            pass: afterRf.converged,
          },
          {
            name: 'after the roll-forward: A pushed 0 ops on opening the board',
            pass: afterRf.pushes === 0,
            detail: [String(afterRf.pushes), ...afterRf.ops].join('; '),
          },
        )
      }
      await side.release(boardId)
      const after = lbRows(path)
      const data = (id: string) => JSON.parse(after.get(id)?.data ?? 'null') as Record<string, unknown> | null
      // A's edits
      if (t.child)
        checks.push({
          name: 'A moved a frame child; B moved the frame: both survive (+60 +120)',
          pass: near(Number(data(el(t.child.id))?.x), x0(t.child.id) + 60 + (t.frame ? 120 : 0)),
        })
      if (t.aDelete)
        checks.push({
          name: 'A deleted an element: still deleted',
          pass: after.get(el(t.aDelete.id))?.deleted === 1,
        })
      checks.push({
        name: 'A created an element: present and byte-identical',
        pass:
          beforeR0.get(aNew)?.deleted === 0 &&
          JSON.stringify(after.get(aNew)) === JSON.stringify(beforeR0.get(aNew)),
      })
      // B's edits
      checks.push({ name: 'B added a shape: present', pass: after.get(el(added))?.deleted === 0 })
      if (t.bDelete)
        checks.push({ name: 'B deleted a shape: deleted', pass: after.get(el(t.bDelete.id))?.deleted === 1 })
      if (t.page2)
        checks.push({
          name: 'B edited page 2: moved +40',
          pass: near(Number(data(el(t.page2.id))?.x), x0(t.page2.id) + 40),
        })
      if (t.frame) {
        checks.push({
          name: 'B moved the frame: +120',
          pass: near(Number(data(el(t.frame.id))?.x), x0(t.frame.id) + 120),
        })
        // every other descendant (children of nested frames and groups included) moved with it; arrows
        // are re-snapped to their targets, so they are left out
        const moved = t.frameDescendants
          .filter((id) => id !== t.child?.id)
          .map((id) => el(id))
          .filter((id) => beforeR0.get(id)?.deleted === 0 && beforeR0.get(id)?.type !== 'arrow')
        const off = moved.filter(
          (id) => !near(Number(data(id)?.x), Number(JSON.parse(beforeR0.get(id)?.data ?? '{}').x) + 120),
        )
        checks.push({
          name: 'B moved the frame: every other descendant moved with it (+120)',
          pass: off.length === 0,
          detail: `${moved.length} descendants, ${off.length} off${off.length ? `: ${off.slice(0, 10).join(', ')}` : ''}`,
        })
      }
      if (t.bReorder && t.lowest) {
        // below every sibling it had in tldraw (the same parent), in ours' order
        const me = el(t.bReorder.id)
        const sib = new Set(
          recordsBefore
            .filter(
              (r) => r.typeName === 'shape' && r.parentId === t.bReorder?.parentId && r.id !== t.bReorder?.id,
            )
            .map((r) => el(r.id)),
        )
        const others = [...after.values()].filter((r) => !r.deleted && sib.has(r.id.split('.')[0] as string))
        checks.push({
          name: 'B re-ordered a shape to the bottom of its page',
          pass: others.every((r) => (after.get(me)?.idx ?? '') < r.idx),
          detail: me,
        })
      }
      if (t.conflict) {
        const id = el(t.conflict.id)
        checks.push({
          name: 'the planted conflict is listed (element, style)',
          pass: report.conflicts.some((c) => c.elementId === id && c.group === 'style'),
          detail: `${id} (${beforeR0.get(id)?.type ?? 'missing'})`,
        })
        const prev = readDb(
          path,
          (db) =>
            (db
              .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(`lb_prev_${report.cycle}_elements`)
              ? db.prepare(`SELECT data FROM lb_prev_${report.cycle}_elements WHERE id = ?`).get(id)
              : undefined) as { data: string } | undefined,
        )
        checks.push({
          name: "ours' value of the conflict is kept in lb_prev_<cycle>_elements",
          pass: JSON.parse(prev?.data ?? '{}').backgroundColor === `#1234${cycle}${cycle}`,
        })
      }
      // untouched rows byte-identical; A-era order kept except where B re-ordered
      const touchedOwners = new Set<string>([
        aNew,
        el(added),
        ...[t.frame, t.child, t.conflict, t.aDelete, t.bDelete, t.bReorder, t.page2]
          .filter(Boolean)
          .map((s) => el((s as Rec).id)),
      ])
      // the moved frame's members (its elements' frameId) and every tldraw descendant (nested frames and
      // groups included): B's frame move moves them all
      const frameKids = new Set(
        t.frame
          ? [...beforeR0.values()]
              .filter((r) => JSON.parse(r.data).frameId === el(t.frame?.id ?? ''))
              .map((r) => r.id)
          : [],
      )
      const frameDesc = new Set(t.frameDescendants.map((id) => el(id)))
      const touchedShape = (id: string) =>
        touchedOwners.has(id.split('.')[0] as string) ||
        frameDesc.has(id.split('.')[0] as string) ||
        frameKids.has(id)
      // an arrow is touched only when an end is bound to a touched element (the room re-snaps it, and its
      // label follows); every other arrow must be byte-identical too (V3: every arrow was left out)
      const arrowTouched = (id: string) => {
        const r = beforeR0.get(id)
        if (r?.type !== 'arrow') return false
        const d = JSON.parse(r.data) as {
          startBinding?: { elementId?: string } | null
          endBinding?: { elementId?: string } | null
        }
        return [d.startBinding?.elementId, d.endBinding?.elementId].some((e) => !!e && touchedShape(e))
      }
      const isTouched = (id: string) =>
        touchedShape(id) || arrowTouched(id) || arrowTouched(id.split('.')[0] as string)
      const untouched = [...beforeR0.keys()].filter((id) => !isTouched(id))
      const changed = untouched.filter(
        (id) => JSON.stringify(after.get(id)) !== JSON.stringify(beforeR0.get(id)),
      )
      checks.push({
        name: 'untouched elements byte-identical',
        pass: changed.length === 0,
        detail: `${untouched.length} untouched, ${changed.length} changed${
          changed.length
            ? `: ${changed
                .slice(0, 10)
                .map((id) => `${id} [${changedKeys(beforeR0.get(id), after.get(id)).join(' ')}]`)
                .join(', ')}`
            : ''
        }`,
      })
      const kept = [...beforeR0.keys()].filter(
        (id) => !(t.bReorder && id.split('.')[0] === el(t.bReorder.id)),
      )
      const order = (m: typeof after) =>
        [...kept].sort((a, b) => ((m.get(a)?.idx ?? '') < (m.get(b)?.idx ?? '') ? -1 : 1))
      checks.push({
        name: 'A-era z-order unchanged except where B re-ordered',
        pass: JSON.stringify(order(after)) === JSON.stringify(order(beforeR0)),
      })
      const cf = cfOf(path)
      checks.push({
        name: 'lb_source refreshed (converted_from.cycle, digest of documents)',
        pass: cf.cycle === cycle && cf.sourceSha256 === readDb(path, (db) => recordsSha(db)),
      })
      cycles.push({
        cycle,
        checks,
        conflicts: report.conflicts,
        counts: report.counts,
        resnap: report.resnap,
        invariants: report.invariants,
        violations: report.violations?.length ?? null,
        ms: report.ms,
        wallMs: { a: aRes.ms ?? null, standIn: standInMs, rollForward: rollForwardWallMs },
        aPushes: aRes.pushes ?? null,
        aClock: aRes.clock ?? null,
        walAfterStandIn,
        afterRollForward: afterRf
          ? {
              trigger: afterRf.trigger,
              elements: afterRf.elements,
              snapshotHash: afterRf.snapshotHash.slice(0, 16),
              mergedHash: report.mergedHash ? report.mergedHash.slice(0, 16) : null,
              snapshotEqualsMerged: report.mergedHash === afterRf.snapshotHash,
            }
          : null,
      })
    }
  } finally {
    await svc.close()
  }
  const ok =
    setup.every((k) => k.pass) &&
    cycles.every((c) => c.checks.every((k) => k.pass)) &&
    bornAfter.every((k) => k.pass)
  return {
    boardId,
    ok,
    excalidraw: opts.excalidraw,
    conversion,
    setup,
    cycles,
    bornAfterBoard: bornId,
    bornAfter,
    applicable,
  }
}

const near = (a: number, b: number) => Number.isFinite(a) && Math.abs(a - b) < 0.01
/** The row columns and top-level element keys that differ (names only, never values). */
function changedKeys(a: LbRow | undefined, b: LbRow | undefined): string[] {
  if (!a || !b) return [a ? 'removed' : 'added']
  const cols = (['clock', 'idx', 'deleted', 'type', 'version', 'gclock'] as const).filter(
    (k) => a[k] !== b[k],
  )
  const da = JSON.parse(a.data) as Record<string, unknown>
  const db = JSON.parse(b.data) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(da), ...Object.keys(db)])].filter(
    (k) => JSON.stringify(da[k]) !== JSON.stringify(db[k]),
  )
  return [...cols.map((c) => `col:${c}`), ...keys]
}
function readConvertReport(dir: string, boardId: string): ConvertReport | null {
  const p = join(dir, `${boardId}.json`)
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as ConvertReport) : null
}
function readReport(dir: string, boardId: string): string {
  const p = join(dir, `${boardId}.rollforward.json`)
  return existsSync(p) ? readFileSync(p, 'utf8') : '{}'
}
function tableDigestUpTo(db: DatabaseSync, maxSeq: number): string {
  const rows = db.prepare('SELECT * FROM dr_deleted_records WHERE seq <= ? ORDER BY seq').all(maxSeq)
  return JSON.stringify(rows) + JSON.stringify(tableDigest(db, 'dr_deleted_schemas'))
}
function recordsSha(db: DatabaseSync): string {
  const h = createHash('sha256')
  for (const r of db.prepare('SELECT id, state FROM documents ORDER BY id').iterate() as Iterable<{
    id: string
    state: Uint8Array | string
  }>) {
    h.update(r.id)
    h.update('\n')
    h.update(typeof r.state === 'string' ? Buffer.from(r.state) : r.state)
    h.update('\n')
  }
  return h.digest('hex')
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      board: { type: 'string' },
      work: { type: 'string' },
      out: { type: 'string' },
      excalidraw: { type: 'string', default: 'store' },
      staging: { type: 'boolean', default: false },
    },
  })
  if (!values.board || !values.work || !values.out) throw new Error('--board, --work and --out are required')
  const report = await runDrill({
    board: resolve(values.board),
    work: resolve(values.work),
    excalidraw: values.excalidraw === 'room' ? 'room' : 'store',
    staging: values.staging,
  })
  mkdirSync(dirname(resolve(values.out)), { recursive: true })
  writeFileSync(resolve(values.out), `${JSON.stringify(report, null, 1)}\n`)
  const all = [...report.setup, ...report.cycles.flatMap((c) => c.checks), ...report.bornAfter]
  console.log(
    `drill ${report.boardId}: ${report.ok ? 'PASS' : 'FAIL'} (${all.filter((c) => c.pass).length}/${all.length} checks)`,
  )
}
