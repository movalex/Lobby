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
import type { BrowserContext } from '@playwright/test'
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

// ---- seeding on a real stack (the N1 specs) ------------------------------------------------------------------

/** The part of a Playwright page the seed uses (the page of a signed-in editor, on the board). */
interface SeedPage {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>
}

/**
 * Uploads `count` small JPEGs from `page` (as a drop does: POST /api/boards/:bid/assets) and waits for their previews,
 * so the big board's images pass the room's file-refs check. Small on purpose (320 x 240): the N1 specs measure the
 * board's elements, not image decoding.
 */
export async function uploadBigBoardImages(
  page: SeedPage,
  boardId: string,
  count: number,
): Promise<ImageFileFacts[]> {
  return page.evaluate(
    async ({ boardId, count }) => {
      const out: {
        assetId: string
        versionId: string
        kind: 'image'
        name: string
        mimeType: string
        sizeBytes: number
      }[] = []
      let next = 0
      const one = async (i: number) => {
        const canvas = new OffscreenCanvas(320, 240)
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        ctx.fillStyle = `hsl(${(i * 47) % 360} 55% 50%)`
        ctx.fillRect(0, 0, 320, 240)
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 40px sans-serif'
        ctx.fillText(`img ${i + 1}`, 20, 140)
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
        const name = `big-${String(i + 1).padStart(3, '0')}.jpg`
        let res: Response
        for (let attempt = 1; ; attempt++) {
          res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/assets`, {
            method: 'POST',
            body: blob,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent(name) },
          })
          if (![429, 502, 503].includes(res.status) || attempt >= 20) break
          const wait = Number(res.headers.get('retry-after') ?? '5')
          await new Promise((r) => setTimeout(r, Math.min(65, Math.max(1, wait)) * 1000))
        }
        if (!res.ok) throw new Error(`upload ${name}: ${res.status}`)
        const meta = (await res.json()) as { assetId: string; versionId: string }
        out[i] = {
          assetId: meta.assetId,
          versionId: meta.versionId,
          kind: 'image',
          name,
          mimeType: 'image/jpeg',
          sizeBytes: blob.size,
        }
      }
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < count) await one(next++)
        }),
      )
      const pending = new Set(out.map((_, i) => i))
      const deadline = performance.now() + 300_000
      while (pending.size) {
        for (const i of [...pending]) {
          const u = out[i]
          if (!u) continue
          const r = await fetch(
            `/api/boards/${encodeURIComponent(boardId)}/assets/${u.assetId}/${u.versionId}`,
            {
              credentials: 'same-origin',
            },
          )
          const meta = (await r.json()) as { status?: string }
          if (meta.status === 'ready') pending.delete(i)
          else if (meta.status === 'failed') throw new Error(`preview failed for ${u.name}`)
        }
        if (performance.now() > deadline) throw new Error(`${pending.size} previews not ready in 5 min`)
        if (pending.size) await new Promise((r) => setTimeout(r, 500))
      }
      return out
    },
    { boardId, count },
  )
}

export interface SeededBigBoard {
  readonly board: BigBoard
  readonly elements: number
  readonly ms: { images: number; elements: number }
}

/**
 * Fills `boardId` (open in `page` on Lobby's board page, signed in as an editor) with the 10k big board through the
 * real protocol: the images uploaded (`uploadBigBoardImages`), then every element pushed as creates on a raw socket
 * with the page's own ticket (e2e/load/seed.ts: at most 500 ops a push, each acked), so the room stores what a user's
 * pushes would. Throws when the room refused any create.
 */
export async function seedBigBoard(page: SeedPage, boardId: string): Promise<SeededBigBoard> {
  const [{ seedElements }, { forgeSession }] = await Promise.all([
    import('../../load/seed.ts'),
    import('../../tests/support/excalidraw.ts'),
  ])
  const t0 = Date.now()
  const fileFacts = await uploadBigBoardImages(page, boardId, BIG_BOARD_SPEC.images)
  const t1 = Date.now()
  const board = bigBoard(boardId, { fileFacts })
  const { socket, welcome } = await forgeSession(page as never, boardId)
  let pushed: Awaited<ReturnType<typeof seedElements>>
  try {
    pushed = await seedElements(socket, board.elements, welcome.clock)
  } finally {
    await socket.close()
  }
  if (pushed.ok !== pushed.ops)
    throw new Error(
      `seeding ${boardId}: ${pushed.ops - pushed.ok} of ${pushed.ops} creates refused ${JSON.stringify(pushed.rejected)} (${pushed.rejectedIds.join(', ')})`,
    )
  return { board, elements: board.elements.length, ms: { images: t1 - t0, elements: Date.now() - t1 } }
}

// ---- what the N1 specs watch in the page ----------------------------------------------------------------------

/** What `watchOpen` records in a page, from its navigation start (performance.now() ms). */
export interface OpenWatch {
  /** every long task (over 50 ms) of the page's main thread */
  readonly longTasks: { readonly start: number; readonly duration: number }[]
  /** the first frame the canvas held an element */
  readonly firstElements: number | null
  /** the first frame the board was editable: welcomed, not read-only, ready, Saved */
  readonly editable: number | null
  /** user-timing marks of the board page (lobby.snapshot.received / .decoded, lobby.cachedPaint) */
  readonly marks: Record<string, number>
  /** the scene's element count at the end */
  readonly elements: number
  /** N1-4: frames in which the board was installing a snapshot in chunks (snapshot.applying) */
  readonly applyingFrames: number
  /** N1-4: frames in which it was installing chunks while the canvas was writable (must be 0) */
  readonly writableWhileApplying: number
}

/** Before every page load of `context`: a long-task observer and a per-frame watch of the open (read `readOpen`). */
interface InitScriptContext {
  addInitScript(fn: () => void): Promise<unknown>
}
export async function watchOpen(context: InitScriptContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __n1: {
        longTasks: { start: number; duration: number }[]
        firstElements: number | null
        editable: number | null
        applyingFrames: number
        writableWhileApplying: number
      }
      __lobbyBoard?: {
        api?: { getSceneElements(): readonly unknown[] }
        session: {
          snapshot: {
            welcomed: boolean
            readonly: boolean
            phase: string
            save: { state: string }
            applying?: boolean
          }
        }
      }
    }
    w.__n1 = {
      longTasks: [],
      firstElements: null,
      editable: null,
      applyingFrames: 0,
      writableWhileApplying: 0,
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__n1.longTasks.push({ start: e.startTime, duration: e.duration })
      }).observe({ type: 'longtask', buffered: true })
    } catch {
      // no long-task timing in this browser
    }
    const tick = () => {
      const b = w.__lobbyBoard
      if (b) {
        if (w.__n1.firstElements === null && (b.api?.getSceneElements().length ?? 0) > 0)
          w.__n1.firstElements = performance.now()
        const s = b.session.snapshot
        if (s.applying) {
          w.__n1.applyingFrames++
          if (!s.readonly) w.__n1.writableWhileApplying++
        }
        if (
          w.__n1.editable === null &&
          s.welcomed &&
          !s.readonly &&
          s.phase === 'ready' &&
          s.save.state === 'saved'
        )
          w.__n1.editable = performance.now()
      }
      if (w.__n1.editable === null || w.__n1.firstElements === null) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

interface EvalPage {
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>
}
/** What `watchOpen` recorded on the current page. */
export const readOpen = (page: EvalPage): Promise<OpenWatch> =>
  page.evaluate(() => {
    const w = window as unknown as {
      __n1?: {
        longTasks: { start: number; duration: number }[]
        firstElements: number | null
        editable: number | null
        applyingFrames: number
        writableWhileApplying: number
      }
      __lobbyBoard?: { api?: { getSceneElements(): readonly unknown[] } }
    }
    const marks: Record<string, number> = {}
    for (const m of performance.getEntriesByType('mark'))
      if (m.name.startsWith('lobby.') && !(m.name in marks)) marks[m.name] = m.startTime
    return {
      longTasks: w.__n1?.longTasks ?? [],
      firstElements: w.__n1?.firstElements ?? null,
      editable: w.__n1?.editable ?? null,
      marks,
      elements: w.__lobbyBoard?.api?.getSceneElements().length ?? 0,
      applyingFrames: w.__n1?.applyingFrames ?? 0,
      writableWhileApplying: w.__n1?.writableWhileApplying ?? 0,
    }
  })

export const median = (xs: readonly number[]): number => {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : Number.NaN
}

// ---- the speed parts a spec turns on (apps/web/src/canvas/sync/flags.ts) ------------------------------------------

/** The speed parts by name (sync/flags.ts SPEED_FLAGS); a part that ships off is on for the specs that gate it. */
export type SpeedFlags = Partial<
  Record<'WORKER_DECODE' | 'DIFF_APPLY' | 'CHUNKED_APPLY' | 'SIZE_AWARE_LOD', boolean>
>

/** sync/flags.ts SPEED_FLAGS_KEY: the localStorage key a dev-auth page reads its overrides from. */
export const SPEED_FLAGS_KEY = 'lobby.speedFlags'

/**
 * Before every page load of `context` from now on (the board session reads them when it starts; dev-auth builds only,
 * so the e2e build): these speed parts on or off. The open in the fixture has already happened; the spec's own
 * navigation after this call is the one that takes them.
 */
export async function speedFlags(
  context: Pick<BrowserContext, 'addInitScript'>,
  flags: SpeedFlags,
): Promise<void> {
  await context.addInitScript(
    ({ key, value }) => {
      try {
        localStorage.setItem(key, value)
      } catch {
        // no storage: the page runs the shipped values
      }
    },
    { key: SPEED_FLAGS_KEY, value: JSON.stringify(flags) },
  )
}
