// The generated boards of the load runs and the §8.4 measurements (docs/EXCALIDRAW-MIGRATION.md §2.13,
// §8.3 B9, §8.4). Deterministic: the same spec gives the same elements (ids, indices, seeds, text).
//
//  - heavy: e2e/perf/seed.ts's heavy board, laid out exactly like spike A14's render-heavy page (20
//    frames, 4,500 sticky notes each with a bound label, 200 images; about 9,220 elements), for L2 and
//    the §8.4 render numbers;
//  - l1: the all-hands workshop board (about 2k objects, about 4k elements: 18 frames of 100 notes, so
//    one editor can drag a 100-note frame, §8.3 B9) with bound arrows, about one
//    per ten notes, a fifth of them elbow arrows (so B9 measures the server's re-snap cost, §2.9.4 rule 7);
//  - small: the 20 light boards of L1 (40 notes, 4 arrows, 1 frame);
//  - any of them with `deleted` tombstones (§8.4's "20k live plus 10,000 deleted").
//
// Notes and labels are built with Excalidraw's own code through canvas-schema's engine wrappers
// (buildStickyNote, the server's text metrics), frames, images and arrows as plain elements of the strict
// schema; every element passes `checkElement`. Image `fileId`s are generated `ver_…` ids, which the load
// runs' fake api resolves (file-refs `ok`); a real stack needs uploaded versions instead (`fileIds`).
import { checkElement, type WireElement } from '../../packages/canvas-schema/src/elements.ts'
import {
  buildStickyNote,
  indexKeysBetween,
  installedServerTextMetrics,
  installServerTextMetrics,
} from '../../packages/canvas-schema/src/engine/index.ts'

/** A fixed `updated` for generated elements (determinism; the server stamps its own on writes). */
export const GEN_UPDATED = 1_790_000_000_000

export interface BoardSpec {
  readonly id: string
  readonly kind: 'heavy' | 'l1' | 'small' | 'custom'
  readonly frames: number
  readonly notes: number
  readonly images: number
  /** arrows between notes (a fifth elbow) */
  readonly arrows: number
  /** tombstones added at the end (deleted rectangles) */
  readonly deleted?: number
  /** image version ids to use instead of generated ones (a real stack's uploads) */
  readonly fileIds?: readonly string[]
  readonly seed?: number
}

export interface GeneratedBoard {
  readonly spec: BoardSpec
  readonly elements: WireElement[]
  /** the image version ids the board references */
  readonly files: string[]
  readonly noteIds: string[]
  readonly arrowIds: string[]
  readonly frameIds: string[]
  /** note ids of frame 0 in creation order (the 100% view, the drag of a 100-note frame) */
  readonly frame0Notes: string[]
  /** JSON bytes of all elements */
  readonly bytes: number
}

export const HEAVY_SPEC = { frames: 20, notes: 4_500, images: 200, arrows: 0 } as const
export const L1_SPEC = { frames: 18, notes: 1_800, images: 0, arrows: 180 } as const
export const SMALL_SPEC = { frames: 1, notes: 40, images: 0, arrows: 4 } as const

// render-heavy.tsx's layout (e2e/perf/seed.ts's), colours as Lobby note colours
const NW = 200
const GAP = 24
const COLS = 15
const SUBJECTS = ['Hero shot', 'Opening title', 'Tagline', 'Moodboard', 'Casting note', 'Colour grade']
const SUBJECTS2 = ['Location idea', 'Social cutdown', 'Packaging', 'Type pairing', 'Music bed', 'Risk']
const DETAILS = [
  'golden hour rooftop, wide lens',
  'warm analog grain, teal shadows',
  'keep the logo small in the first 3 seconds',
  'slower push-in on the product before the reveal',
  'more contrast in the night exteriors',
  'two-word headline, lowercase',
  'shoot vertical-safe for 9:16 cutdowns',
  'legal needs the disclaimer for 2 seconds',
  'music drops out right before the tagline',
  'crop tighter so the product reads on a phone',
]
const COLORS = ['#ffdf6b', '#ffdf6b', '#9fd4ff', '#b8e994', '#d7b8ff', '#ffb870', '#ff9f9f']

const BASE_FIELDS = {
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid' as const,
  strokeWidth: 2,
  strokeStyle: 'solid' as const,
  roundness: null,
  roughness: 0,
  opacity: 100,
  version: 1,
  isDeleted: false,
  groupIds: [] as string[],
  frameId: null as string | null,
  boundElements: null as { id: string; type: 'arrow' | 'text' }[] | null,
  updated: GEN_UPDATED,
  created: GEN_UPDATED as number | null,
  link: null,
  locked: false,
}

function rng(seed: number) {
  let s = seed % 2147483647 || 1
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

/** A generated image version id (`ver_` + 16 characters). */
export const genFileId = (board: string, i: number) =>
  `ver_${board
    .replace(/[^0-9A-Za-z]/g, '')
    .slice(0, 6)
    .padEnd(6, 'x')}${String(i).padStart(10, '0')}`

export function generateBoard(spec: BoardSpec): GeneratedBoard {
  if (!installedServerTextMetrics()) installServerTextMetrics()
  const rand = rng(spec.seed ?? 99)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const ordered: WireElement[] = [] // paint order; indices assigned at the end
  const byId = new Map<string, Record<string, unknown>>()
  const noteIds: string[] = []
  const frameIds: string[] = []
  const frame0Notes: string[] = []
  const files: string[] = []
  const p = spec.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'b'

  const frames = Math.max(1, spec.frames)
  const perFrame = Math.ceil(spec.notes / frames)
  const imgsPerFrame = Math.ceil(spec.images / frames)
  const rows = Math.ceil(perFrame / COLS)
  const FW = COLS * (NW + GAP) + GAP + (spec.images > 0 ? 520 : 0)
  const FH = Math.max(60 + rows * (NW + GAP) + GAP, 60 + imgsPerFrame * 340 + 20)
  const PER_ROW = Math.ceil(Math.sqrt(frames * 1.25))
  let notesLeft = spec.notes
  let img = 0
  const notePos = new Map<string, { f: number; k: number; x: number; y: number }>()

  const push = (el: Record<string, unknown>) => {
    ordered.push(el as WireElement)
    byId.set(el.id as string, el)
  }

  for (let f = 0; f < frames; f++) {
    const fx = (f % PER_ROW) * (FW + 400)
    const fy = Math.floor(f / PER_ROW) * (FH + 400)
    const frameId = `${p}-f${f}`
    const n = Math.min(perFrame, notesLeft)
    notesLeft -= n
    for (let k = 0; k < n; k++) {
      const id = `${p}-n${f}-${k}`
      const x = fx + GAP + (k % COLS) * (NW + GAP)
      const y = fy + 60 + Math.floor(k / COLS) * (NW + GAP)
      const text = `${pick(rand() < 0.5 ? SUBJECTS : SUBJECTS2)}: ${pick(DETAILS)}`
      const { note, label } = buildStickyNote({
        id,
        x,
        y,
        text,
        backgroundColor: pick(COLORS),
        seed: 1 + ((f * 1000 + k) % 100_000),
      })
      push({
        ...note,
        versionNonce: (f * 7919 + k) | 0,
        frameId,
        updated: GEN_UPDATED,
        customData: undefined,
      })
      if (label)
        push({
          ...label,
          versionNonce: (f * 7919 + k + 1) | 0,
          frameId,
          updated: GEN_UPDATED,
          customData: undefined,
        })
      noteIds.push(id)
      notePos.set(id, { f, k, x, y })
      if (f === 0) frame0Notes.push(id)
    }
    for (let k = 0; k < imgsPerFrame && img < spec.images; k++, img++) {
      const fileId = spec.fileIds?.[img] ?? genFileId(p, img)
      files.push(fileId)
      push({
        ...BASE_FIELDS,
        id: `${p}-i${f}-${k}`,
        type: 'image',
        x: fx + FW - 500,
        y: fy + 60 + k * 340,
        width: 480,
        height: 300,
        seed: 5000 + img,
        versionNonce: 5000 + img,
        index: null,
        frameId,
        fileId,
        status: 'saved',
        scale: [1, 1],
        crop: null,
      })
    }
    push({
      ...BASE_FIELDS,
      id: frameId,
      type: 'frame',
      x: fx,
      y: fy,
      width: FW,
      height: FH,
      seed: 9000 + f,
      versionNonce: 9000 + f,
      index: null,
      name: `Workstream ${f + 1}`,
    })
    frameIds.push(frameId)
  }

  // arrows between neighbouring notes of a frame: straight (right neighbour) or elbow (next row, next column)
  const arrowIds: string[] = []
  const bind = (targetId: string, arrowId: string) => {
    const t = byId.get(targetId) as { boundElements: { id: string; type: string }[] | null }
    t.boundElements = [...(t.boundElements ?? []), { id: arrowId, type: 'arrow' }]
  }
  const candidates = noteIds.filter((id) => {
    const q = notePos.get(id) as { k: number }
    return q.k % COLS < COLS - 1
  })
  const step = Math.max(1, Math.floor(candidates.length / Math.max(1, spec.arrows)))
  // walk the candidates with a stride (wrapping once), skipping notes whose neighbour does not exist
  let a = 0
  for (let c = 0; a < spec.arrows && c < 2 * candidates.length; c += step) {
    const fromId = candidates[c % candidates.length] as string
    const from = notePos.get(fromId) as { f: number; k: number; x: number; y: number }
    const elbow = a % 5 === 4
    // an elbow arrow goes to the next column one row down (or, on the last row, one row up)
    const down = notePos.has(`${p}-n${from.f}-${from.k + COLS + 1}`)
    const toK = elbow ? from.k + (down ? COLS : -COLS) + 1 : from.k + 1
    const toId = `${p}-n${from.f}-${toK}`
    const to = notePos.get(toId)
    if (!to) continue
    const id = `${p}-a${a}`
    const sx = from.x + NW + 4
    const sy = from.y + NW / 2
    const ex = elbow ? to.x + NW / 2 : to.x - 4
    const ey = elbow ? (down ? to.y - 4 : to.y + NW + 4) : to.y + NW / 2
    const dx = Math.round((ex - sx) * 100) / 100
    const dy = Math.round((ey - sy) * 100) / 100
    const points: [number, number][] = elbow
      ? [
          [0, 0],
          [dx, 0],
          [dx, dy],
        ]
      : [
          [0, 0],
          [dx, dy],
        ]
    push({
      ...BASE_FIELDS,
      id,
      type: 'arrow',
      x: sx,
      y: sy,
      width: Math.abs(dx),
      height: Math.abs(dy),
      seed: 7000 + a,
      versionNonce: 7000 + a,
      index: null,
      frameId: `${p}-f${from.f}`,
      points,
      startBinding: { elementId: fromId, fixedPoint: [1, 0.5], mode: 'orbit' },
      endBinding: { elementId: toId, fixedPoint: elbow ? [0.5, down ? 0 : 1] : [0, 0.5], mode: 'orbit' },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: elbow,
      ...(elbow ? { fixedSegments: null, startIsSpecial: null, endIsSpecial: null } : {}),
    })
    bind(fromId, id)
    bind(toId, id)
    arrowIds.push(id)
    a++
  }

  for (let d = 0; d < (spec.deleted ?? 0); d++)
    push({
      ...BASE_FIELDS,
      id: `${p}-d${d}`,
      type: 'rectangle',
      x: -5_000 - (d % 100) * 120,
      y: -5_000 - Math.floor(d / 100) * 120,
      width: 100,
      height: 100,
      seed: 20_000 + d,
      versionNonce: 20_000 + d,
      version: 2,
      index: null,
      isDeleted: true,
    })

  const keys = indexKeysBetween(null, null, ordered.length)
  const elements = ordered.map((el, i) => ({ ...el, index: keys[i] as string }) as WireElement)
  for (const el of elements) {
    const check = checkElement(el)
    if (!check.ok) throw new Error(`generated element ${el.id} fails the element schema: ${check.detail}`)
  }
  return {
    spec,
    elements,
    files,
    noteIds,
    arrowIds,
    frameIds,
    frame0Notes,
    bytes: Buffer.byteLength(JSON.stringify(elements)),
  }
}

/** The boards of a load profile, by id. */
export function heavyBoard(id: string, extra: Partial<BoardSpec> = {}): GeneratedBoard {
  return generateBoard({ id, kind: 'heavy', ...HEAVY_SPEC, ...extra })
}
export function l1Board(id: string, extra: Partial<BoardSpec> = {}): GeneratedBoard {
  return generateBoard({ id, kind: 'l1', ...L1_SPEC, ...extra })
}
export function smallBoard(id: string, seed: number): GeneratedBoard {
  return generateBoard({ id, kind: 'small', ...SMALL_SPEC, seed })
}
