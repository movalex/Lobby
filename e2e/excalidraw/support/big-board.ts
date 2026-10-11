// OWNER: WS1 (wave N, big boards; landed by the wave N foundation). The 10k-element board of the N1 specs (10k
// elements at 60 fps, fast warm and cold opens; n1-*.spec.ts, navigation-lod-fps.spec.ts on it): exactly
// BIG_BOARD_ELEMENTS elements, deterministic (the same board id gives the same elements: ids, indices, seeds, text,
// positions), every one passing canvas-schema's checkElement:
//  - 20 frames, each a grid of sticky notes with their bound labels (4,400 notes: 8,800 elements);
//  - 400 bound arrows between notes (a fifth of them elbow arrows: the server's re-snap cost);
//  - 50 images, placeholders unless the caller passes real uploads (`fileFacts`: a real stack's file-refs check
//    refuses a version that was never uploaded; e2e/perf/seed.ts uploads them the way a drop does);
//  - 730 loose shapes (rectangles, ellipses, diamonds) outside every frame, below them (LOD's loose-element tiles).
// Built on e2e/load/boards.ts `generateBoard` (its notes, frames, images and arrows) plus the loose shapes here.
// BIG_BOARD_HASH is the hash.ts hash of the GENERATED elements of BIG_BOARD_ID with placeholder images (a change to
// the generator or to this file changes it, and ./big-board.test.ts says so); the room stamps its own `updated`,
// `lobbyServer` and index keys on a seed, so a seeded board's hash is read from the room, never compared with this.
import type { WireElement } from '../../../packages/canvas-schema/src/elements.ts'
import { checkElement } from '../../../packages/canvas-schema/src/elements.ts'
import { indexKeysBetween } from '../../../packages/canvas-schema/src/engine/index.ts'
import { hashElements } from '../../../packages/canvas-schema/src/hash.ts'
import { GEN_UPDATED, type GeneratedBoard, generateBoard, type ImageFileFacts } from '../../load/boards.ts'

/** The board's parts. */
export const BIG_BOARD_SPEC = { frames: 20, notes: 4_400, arrows: 400, images: 50, shapes: 730 } as const
/** Elements in all: frames + notes and labels + arrows + images + loose shapes. */
export const BIG_BOARD_ELEMENTS =
  BIG_BOARD_SPEC.frames +
  BIG_BOARD_SPEC.notes * 2 +
  BIG_BOARD_SPEC.arrows +
  BIG_BOARD_SPEC.images +
  BIG_BOARD_SPEC.shapes
/** The board id the fixture's hash is pinned for. */
export const BIG_BOARD_ID = 'b-big10k0001'
/** hash.ts `hashElements` of `bigBoard(BIG_BOARD_ID).elements` (placeholder images). */
export const BIG_BOARD_HASH = '48bad97fdded30ce3a8685bf8c4e44074b2b440c4be0ded7632373806bff0691'

export interface BigBoard extends GeneratedBoard {
  /** the loose shapes' ids, in paint order */
  readonly shapeIds: string[]
}

const SHAPE_TYPES = ['rectangle', 'ellipse', 'diamond'] as const
const SHAPE_FILLS = ['transparent', '#a5d8ff', '#b2f2bb', '#ffec99', '#ffc9c9']

/** The 10k board for `boardId` (see the header); `fileFacts`: the 50 images' real uploads, in order. */
export function bigBoard(boardId: string, opts: { fileFacts?: readonly ImageFileFacts[] } = {}): BigBoard {
  const base = generateBoard({
    id: boardId,
    kind: 'custom',
    frames: BIG_BOARD_SPEC.frames,
    notes: BIG_BOARD_SPEC.notes,
    images: BIG_BOARD_SPEC.images,
    arrows: BIG_BOARD_SPEC.arrows,
    seed: 10_000,
    ...(opts.fileFacts ? { fileFacts: opts.fileFacts } : {}),
  })
  const p = boardId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'b'
  // below every frame, with a margin: a grid of loose shapes
  let maxY = 0
  let minX = 0
  for (const el of base.elements) {
    maxY = Math.max(maxY, el.y + el.height)
    minX = Math.min(minX, el.x)
  }
  const top = maxY + 800
  const COLS = 40
  const last = base.elements.at(-1)?.index ?? null
  const keys = indexKeysBetween(last, null, BIG_BOARD_SPEC.shapes)
  const shapeIds: string[] = []
  const shapes: WireElement[] = []
  for (let s = 0; s < BIG_BOARD_SPEC.shapes; s++) {
    const id = `${p}-s${s}`
    const el = {
      id,
      type: SHAPE_TYPES[s % SHAPE_TYPES.length],
      x: minX + (s % COLS) * 260,
      y: top + Math.floor(s / COLS) * 200,
      width: 200,
      height: 140,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: SHAPE_FILLS[s % SHAPE_FILLS.length],
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roundness: s % 2 ? { type: 3 } : null,
      roughness: 0,
      opacity: 100,
      seed: 30_000 + s,
      version: 1,
      versionNonce: 30_000 + s,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      updated: GEN_UPDATED,
      created: GEN_UPDATED,
      link: null,
      locked: false,
      index: keys[s] as string,
    } as unknown as WireElement
    const check = checkElement(el)
    if (!check.ok) throw new Error(`big board shape ${id} fails the element schema: ${check.detail}`)
    shapes.push(el)
    shapeIds.push(id)
  }
  const elements = [...base.elements, ...shapes]
  if (elements.length !== BIG_BOARD_ELEMENTS)
    throw new Error(`the big board has ${elements.length} elements, not ${BIG_BOARD_ELEMENTS}`)
  return {
    ...base,
    elements,
    shapeIds,
    bytes: Buffer.byteLength(JSON.stringify(elements)),
  }
}

/** hash.ts's hash of a big board's generated elements (BIG_BOARD_HASH for BIG_BOARD_ID). */
export const bigBoardHash = (board: Pick<BigBoard, 'elements'>): Promise<string> =>
  hashElements(board.elements)
