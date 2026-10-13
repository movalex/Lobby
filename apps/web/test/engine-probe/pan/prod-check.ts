/**
 * Wave O (WO-PAN), run by pan-prod.test.ts in a child `node`: the element patch's A1/A4, A2 and C in the production
 * build, loaded as the sync server loads it. The server (`node src/server.ts`) imports @excalidraw/element once, in
 * packages/canvas-schema/src/engine/raw.ts, and Node resolves the package's exports to `default`, dist/prod (the web
 * build's `production` condition gives the same file; the test runs this both ways). Vitest loads dist/dev for the
 * package, so this is the gate's one run of the server's own module. Each speed-up is compared with the engine's own
 * unpatched answer:
 *  - A1/A4: isElementInViewportAt with isElementInViewport, on the 10k board and a corpus of every kind, over cameras at
 *    Lobby's zooms, cameras whose edge lies exactly on a bound, and render offsets (the LOD's cull offset among them);
 *  - A2: a bound text's bounds through the cache with an uncached computation (ElementBounds.calculateBounds), after each
 *    change of its container (moved, resized, mutated in place, an undo, a remote copy, gone and back) and of itself;
 *  - C: shouldApplyFrameClip with the engine's three tests (corpus.ts engineFrameClip) and their group bookkeeping, on
 *    the 10k board's frame children and an edge sweep, dragging and not.
 * Prints one JSON line (ProdCheck).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { BIG_BOARD_ID, bigBoard } from '../../../../../e2e/excalidraw/support/big-board.ts'
import { raw } from '../../../../../packages/canvas-schema/src/engine/raw.ts'
import {
  answers,
  cameras,
  clipState,
  corpus,
  edgeSweep,
  type El,
  type Engine,
  engineFrameClip,
  mapOf,
  STYLE,
} from './corpus.ts'

export interface CheckResult {
  compared: number
  mismatches: number
  /** the first few mismatches, for the report */
  sample: string[]
}

export interface ProdCheck {
  conditions: string[]
  /** the file the server's import resolved to, and the sync app's own resolution of the package */
  resolved: string
  resolvedFromSync: string
  /** the module raw.ts holds is the one at `resolved` */
  sameInstance: boolean
  /** the build carries the element patch (its prod hunks and the export) */
  patched: boolean
  visibleA1: number
  cacheHitA2: boolean
  fastC: number
  checks: Record<'A1' | 'A2' | 'C', CheckResult>
}

const root = new URL('../../../../../', import.meta.url)
const resolveFrom = (path: string) => createRequire(new URL(path, root)).resolve('@excalidraw/element')
const resolved = resolveFrom('packages/canvas-schema/src/engine/raw.ts')
const loaded = await import(pathToFileURL(resolved).href)
const X: Engine = raw
X.setCustomTextMetricsProvider({ getLineWidth: (t: string) => t.length * 10 })
const source = readFileSync(resolved, 'utf8')

const result = (): CheckResult => ({ compared: 0, mismatches: 0, sample: [] })
const checks = { A1: result(), A2: result(), C: result() }
const tally = (r: CheckResult, ok: boolean, what: () => string) => {
  r.compared++
  if (ok) return
  r.mismatches++
  if (r.sample.length < 5) r.sample.push(what())
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// A1 / A4
const BOARD = bigBoard(BIG_BOARD_ID).elements as unknown as El[]
const boardMap = mapOf(BOARD)
let visibleA1 = 0
for (const [els, map, seed] of [
  [BOARD, boardMap, 11],
  [corpus(X), null, 5],
] as const) {
  const m = map ?? mapOf(els)
  const cams = cameras(X, els, m, seed)
  for (const [k, cam] of cams.entries())
    for (const offset of [{ x: 0, y: 0 }, ...(k < 8 ? [{ x: 1e9, y: 1e9 }, { x: 37.25, y: -12.5 }] : [])]) {
      const a = answers(X, els, m, cam, offset)
      visibleA1 += offset.x === 0 ? a.visible : 0
      for (let i = 0; i < a.engine.length; i++)
        tally(
          checks.A1,
          a.engine[i] === a.patch[i],
          () => `${els[i]?.id} at ${JSON.stringify({ cam, offset })}`,
        )
    }
}

// A2: an arrow's label and a note's label through the changes of their containers
let cacheHitA2 = false
{
  const check = (label: El, map: Map<string, El>, what: string) => {
    const truth = X.ElementBounds.calculateBounds(label, map)
    const got = X.getElementBounds(label, map)
    tally(checks.A2, same(got, truth), () => `${what}: ${JSON.stringify(got)}, not ${JSON.stringify(truth)}`)
    return got
  }
  const arrow0 = X.newArrowElement({
    ...STYLE,
    type: 'arrow',
    x: 100,
    y: 100,
    width: 400,
    height: 0,
    points: [
      [0, 0],
      [400, 0],
    ],
  })
  let label = X.newTextElement({ ...STYLE, x: 0, y: 0, text: 'label', containerId: arrow0.id })
  let arrow = { ...arrow0, boundElements: [{ id: label.id, type: 'text' }] }
  const map = new Map<string, El>([
    [arrow.id, arrow],
    [label.id, label],
  ])
  const first = check(label, map, 'first')
  // the patch's point: the label's entry is served again (an unpatched build computes a new array every time)
  cacheHitA2 = X.getElementBounds(label, map) === first
  const before = arrow
  arrow = X.newElementWith(arrow, { x: 260, y: -40 })
  map.set(arrow.id, arrow)
  const moved = check(label, map, 'arrow moved')
  tally(
    checks.A2,
    Math.abs(moved[0] - first[0] - 160) < 1e-6,
    () => `moved by ${moved[0] - first[0]}, not 160`,
  )
  arrow = X.newElementWith(arrow, {
    width: 800,
    height: 300,
    points: [
      [0, 0],
      [800, 300],
    ],
  })
  map.set(arrow.id, arrow)
  check(label, map, 'arrow resized')
  X.mutateElement(arrow, map, {
    points: [
      [0, 0],
      [200, 600],
    ],
    width: 200,
    height: 600,
  })
  check(label, map, 'arrow mutated in place')
  label = X.newElementWith(label, { text: 'a much longer label', width: 190 })
  map.set(label.id, label)
  check(label, map, 'label text edited')
  map.set(before.id, before)
  check(label, map, 'undo: the earlier arrow object back')
  const remote = { ...before, x: before.x - 75, version: arrow.version + 1, versionNonce: 42 }
  map.set(remote.id, remote)
  check(label, map, 'remote change')
  map.set(remote.id, { ...remote })
  check(label, map, 'the same remote copy again (a new object at the same version)')
  map.delete(remote.id)
  check(label, map, 'container gone')
  map.set(remote.id, remote)
  check(label, map, 'container back')

  let note = X.newElement({ ...STYLE, type: 'rectangle', x: 0, y: 0, width: 220, height: 160 })
  let noteLabel = X.newTextElement({ ...STYLE, x: 10, y: 60, text: 'note', containerId: note.id })
  note = { ...note, boundElements: [{ id: noteLabel.id, type: 'text' }] }
  const notes = new Map<string, El>([
    [note.id, note],
    [noteLabel.id, noteLabel],
  ])
  check(noteLabel, notes, 'note label')
  note = X.newElementWith(note, { x: 500, angle: 0.5 })
  notes.set(note.id, note)
  check(noteLabel, notes, 'note moved and rotated')
  noteLabel = X.newElementWith(noteLabel, { x: 510, angle: 0.5 })
  notes.set(noteLabel.id, noteLabel)
  check(noteLabel, notes, 'note label moved with it')
  X.mutateElement(note, notes, { width: 600 })
  check(noteLabel, notes, 'note resized in place')
}

// C: the 10k board's frame children, and every kind swept across each edge of a frame
let fastC = 0
{
  const compare = (element: El, frame: El, map: Map<string, El>, dragging: boolean) => {
    const appState = clipState(dragging)
    const gotGroups = new Map<string, boolean>()
    const wantGroups = new Map<string, boolean>()
    const got = X.shouldApplyFrameClip(element, frame, appState, map, gotGroups)
    const want = engineFrameClip(X, element, frame, appState, map, wantGroups)
    tally(
      checks.C,
      got === want && same([...gotGroups], [...wantGroups]),
      () => `${element.id} in ${frame.id} (dragging ${dragging}): ${got}, not ${want}`,
    )
    return want
  }
  for (const e of BOARD) {
    if (!e.frameId || e.type === 'frame' || (e.type === 'text' && e.containerId)) continue
    if (!compare(e, boardMap.get(e.frameId), boardMap, false)) fastC++
  }
  const { frame, els } = edgeSweep(X)
  const map = mapOf([frame, ...els])
  for (const e of els) for (const dragging of [false, true]) compare(e, frame, map, dragging)
}

const out: ProdCheck = {
  conditions: process.execArgv.filter((a) => a.startsWith('--conditions')),
  resolved,
  resolvedFromSync: resolveFrom('apps/sync/package.json'),
  sameInstance: loaded === raw,
  patched:
    typeof X.isElementInViewportAt === 'function' &&
    source.includes('(!ye(t)||lobbyBoundTextCacheHit(o,t,n))') &&
    source.includes('if(lobbyFrameClipNotNeeded(e,t,i))return!1;'),
  visibleA1,
  cacheHitA2,
  fastC,
  checks,
}
console.log(JSON.stringify(out))
