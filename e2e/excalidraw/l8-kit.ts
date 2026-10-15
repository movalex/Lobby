// Helpers of the wave L W8 specs (l8-*.spec.ts): the sort feature's dev hook (window.__lobbySort: its commands,
// and a stand-in for W2's runAi and showAiPreview until the AI feature's bodies are on the page), notes in
// frames made through the page's canvas, push inspection, and the arrow re-derivation check.

import { expect, type Page } from '@playwright/test'
import type { LobbyCanvas } from '../../apps/web/src/canvas/api/lobby-canvas.ts'
import type { FakeAiConfig, SortDevHook } from '../../apps/web/src/features/sort/dev-hook-types.ts'
import {
  boundEndsOffEdge,
  type EngineElement,
  installServerTextMetrics,
} from '../../packages/canvas-schema/src/engine/index.ts'
import {
  type CanvasElement,
  createItem,
  createNote,
  expectSaved,
  items,
  pushedOps,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { bindArrow, setFrame } from './navigation-kit.ts'

export type { FakeAiConfig }

/** The note palette's light fills by name (canvas-ux/palette.ts NOTE_PALETTE). */
export const FILL = {
  butter: '#f8e48f',
  sky: '#a6d8f3',
  coral: '#ef8c82',
  fern: '#93cfa6',
  stone: '#d6d9de',
} as const

/** Runs `fn` in the page with its canvas (window.__lobbyBoard.canvas, dev-auth builds). */
export async function withCanvas<T, A>(
  page: Page,
  fn: (canvas: LobbyCanvas, arg: A) => T,
  arg: A,
): Promise<T> {
  return (await page.evaluate(
    ({ src, arg }) => {
      const b = (window as unknown as { __lobbyBoard?: { canvas: unknown } }).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      const f = new Function(`return (${src})`)() as (c: unknown, a: unknown) => unknown
      return f(b.canvas, arg)
    },
    { src: fn.toString(), arg },
  )) as T
}

/** The sort feature is mounted on this page (its dev hook is there). */
export async function waitForSort(page: Page): Promise<void> {
  await waitForCanvas(page)
  await page.waitForFunction(
    () => !!(window as unknown as { __lobbySort?: unknown }).__lobbySort,
    undefined,
    {
      timeout: 30_000,
    },
  )
}

/** Runs a sort command by id through the page's registry; false when it is disabled or unknown. */
export const sortRun = (page: Page, id: string, args?: unknown): Promise<boolean> =>
  page.evaluate(
    ([commandId, a]) =>
      (window as unknown as { __lobbySort: SortDevHook }).__lobbySort.run(commandId as string, a),
    [id, args] as const,
  )

/** Stands in for the AI feature's calls on this page (null puts the real ones back). */
export const fakeAi = (page: Page, config: FakeAiConfig | null): Promise<void> =>
  page.evaluate((c) => (window as unknown as { __lobbySort: SortDevHook }).__lobbySort.fakeAi(c), config)

export const aiRequests = (page: Page) =>
  page.evaluate(() => (window as unknown as { __lobbySort: SortDevHook }).__lobbySort.requests())
export const aiPreviews = (page: Page) =>
  page.evaluate(() => (window as unknown as { __lobbySort: SortDevHook }).__lobbySort.previews())
export const sortMenuState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __lobbySort: SortDevHook }).__lobbySort.menu())

export interface NoteSpec {
  x: number
  y: number
  text: string
  fill?: string
}

/** Notes made through the facade, each Saved, then put into `frameId` when given. Returns their ids. */
export async function makeNotes(page: Page, specs: readonly NoteSpec[], frameId?: string): Promise<string[]> {
  const ids: string[] = []
  for (const s of specs) {
    ids.push(await createNote(page, { x: s.x, y: s.y, text: s.text, ...(s.fill ? { color: s.fill } : {}) }))
    await expectSaved(page)
  }
  if (frameId) await setFrame(page, ids, frameId)
  return ids
}

export async function makeFrame(page: Page, x: number, y: number, w: number, h: number, name: string) {
  const id = await createItem(page, 'frame', { x, y, width: w, height: h, name })
  await expectSaved(page)
  return id
}

/** A connector from `from` to `to`, bound at both ends (the server fits it to the notes). */
export async function makeArrow(page: Page, from: string, to: string): Promise<string> {
  const arrow = await createItem(page, 'arrow', {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    points: [
      [0, 0],
      [100, 100],
    ],
  })
  await expectSaved(page)
  await bindArrow(page, arrow, from, to)
  return arrow
}

/** The twelve notes of the sort specs: three colours cycling, a grid of 6 by 2 at (x0, y0). */
export function twelve(x0: number, y0: number): NoteSpec[] {
  const fills = [FILL.butter, FILL.sky, FILL.coral]
  return Array.from({ length: 12 }, (_, i) => ({
    x: x0 + (i % 6) * 230,
    y: y0 + Math.floor(i / 6) * 230,
    text: `idea ${i + 1}`,
    fill: fills[i % 3] as string,
  }))
}

/** Live headings the sort made (kind 'sort-label' or 'ai-sort-label'), by their words. */
export async function headings(page: Page): Promise<CanvasElement[]> {
  return (await items(page)).filter((e) => {
    const kind = (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind
    return e.type === 'text' && (kind === 'sort-label' || kind === 'ai-sort-label')
  })
}

export const wordsOf = (e: CanvasElement) => (e as { originalText?: string }).originalText ?? ''

// ---- pushes ---------------------------------------------------------------------------------------------------------

export type PushedOps = Awaited<ReturnType<typeof pushedOps>>

/** The ops of the pushes after the first `already`, flattened. */
export async function opsSince(page: Page, already: number) {
  return (await pushedOps(page)).slice(already).flatMap((p) => p.ops)
}

/** The ops among `ops` that write an arrow: a patch of one of `arrowIds`, or the creation of any arrow. */
export function arrowOps(
  ops: Awaited<ReturnType<typeof opsSince>>,
  arrowIds: readonly string[],
): Awaited<ReturnType<typeof opsSince>> {
  const ids = new Set(arrowIds)
  return ops.filter((op) =>
    op.k === 'c' ? (op.el as { type?: string }).type === 'arrow' : ids.has((op as { id: string }).id),
  )
}

// ---- the server's re-derivation of a bound arrow --------------------------------------------------------------------

let metrics = false

/**
 * How far each arrow's bound ends are from where the server's own re-snap puts them against the stored
 * targets (canvas-schema `boundEndsOffEdge`, the helper the room's protocol tests use): 0 is "equal to the
 * server's re-derivation". Read from the page's current copy of the board.
 */
export async function arrowErrors(page: Page, arrowIds: readonly string[]): Promise<Record<string, number>> {
  if (!metrics) {
    installServerTextMetrics()
    metrics = true
  }
  const all = await items(page)
  const map = new Map(all.map((e) => [e.id, structuredClone(e) as unknown as EngineElement]))
  const out: Record<string, number> = {}
  for (const id of arrowIds) {
    const a = map.get(id)
    if (!a) throw new Error(`no arrow ${id}`)
    out[id] = boundEndsOffEdge(a as never, map as never)
  }
  return out
}

/** Waits until every arrow in `arrowIds` is where the server's re-derivation puts it (within `tolerance`). */
export async function expectArrowsDerived(page: Page, arrowIds: readonly string[], tolerance = 0.75) {
  await expect
    .poll(async () => Math.max(...Object.values(await arrowErrors(page, arrowIds))), {
      message: 'the arrows’ bound ends equal the server’s re-derivation',
      timeout: 20_000,
    })
    .toBeLessThanOrEqual(tolerance)
}

/**
 * Wave Q: the Shapes (Pieces) dock panel retired when ELEMENTS_PANEL turned on (the Elements panel's Shapes tab has the
 * pieces); it is the board's again whenever that switch is off. The specs of that panel turn the switch off for their
 * page (the dev-auth override, localStorage lobby.elementsPanel = '0') and reload, so the fallback stays tested.
 */
export async function withShapesPanel(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem('lobby.elementsPanel', '0')
    } catch {
      // no storage: the page runs the shipped value
    }
  })
  await page.reload()
  await waitForCanvas(page)
  await expect(page.getByTestId('dock-tab-pieces')).toBeVisible({ timeout: 30_000 })
}
