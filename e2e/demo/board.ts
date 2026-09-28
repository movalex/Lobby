// Reading the board (and moving the camera) for the demo's choreography. Content only ever changes
// through the UI; these helpers read where things are so the cursor can go there, and frame the view
// the way a person would by scrolling and zooming. `window.editor` exists in builds made with
// VITE_DRAFTROOM_DEV_AUTH=1 (the local-dev guard), which the demo stack uses.
import type { Page } from '@playwright/test'
import type { Point } from './human.ts'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface DemoShape {
  id: string
  type: string
  parentId: string
  props: Record<string, unknown>
  meta: Record<string, unknown>
}

/** The slice of tldraw 5.4.2's Editor used here (node_modules/@tldraw/editor/dist-esm/index.d.mts). */
export interface DemoEditor {
  getCurrentPageShapes(): DemoShape[]
  getShapePageBounds(id: string): Box | undefined
  pageToScreen(p: Point): Point
  zoomToBounds(
    b: Box,
    opts?: { inset?: number; targetZoom?: number; animation?: { duration: number } },
  ): unknown
  getViewportScreenBounds(): Box
  getViewportPageBounds(): Box
  getSelectedShapeIds(): string[]
  getEditingShapeId(): string | null
  getCurrentToolId(): string
  selectNone(): unknown
  getZoomLevel(): number
}

/** The editor is mounted and the sync socket is live. */
export async function boardReady(page: Page, timeout = 60_000) {
  await page.waitForFunction(() => window.editor !== undefined, undefined, { timeout })
  await page.waitForFunction(
    () => document.querySelector('[data-testid="conn-status"]')?.getAttribute('data-state') === 'online',
    undefined,
    { timeout },
  )
}

/** Shapes of the current page with their plain text and page bounds. */
export interface ShapeInfo {
  id: string
  type: string
  parentId: string
  text: string
  name: string
  box: Box
  meta: Record<string, unknown>
  props: Record<string, unknown>
}

export function shapes(page: Page): Promise<ShapeInfo[]> {
  return page.evaluate(() => {
    const ed = window.editor as unknown as DemoEditor | undefined
    if (!ed) return []
    const flat = (doc: unknown): string => {
      const blocks: string[] = []
      const walk = (n: unknown, into: string[]) => {
        if (!n || typeof n !== 'object') return
        const o = n as { text?: unknown; content?: unknown }
        if (typeof o.text === 'string') into.push(o.text)
        if (Array.isArray(o.content)) for (const c of o.content) walk(c, into)
      }
      const root = doc as { content?: unknown } | undefined
      for (const b of Array.isArray(root?.content) ? root.content : []) {
        const parts: string[] = []
        walk(b, parts)
        blocks.push(parts.join(''))
      }
      return blocks.join('\n')
    }
    return ed.getCurrentPageShapes().map((s) => {
      const b = ed.getShapePageBounds(s.id) ?? { x: 0, y: 0, w: 0, h: 0 }
      return {
        id: s.id,
        type: s.type,
        parentId: s.parentId,
        text: flat(s.props.richText),
        name: typeof s.props.name === 'string' ? s.props.name : '',
        box: { x: b.x, y: b.y, w: b.w, h: b.h },
        meta: s.meta,
        props: s.props,
      }
    })
  })
}

export async function shapeByText(page: Page, text: string, type?: string): Promise<ShapeInfo> {
  const all = await shapes(page)
  const hit = all.find((s) => s.text.replace(/\s+/g, ' ').trim() === text && (!type || s.type === type))
  if (!hit) throw new Error(`no ${type ?? 'shape'} with text "${text}"`)
  return hit
}

export async function frameByName(page: Page, name: RegExp | string): Promise<ShapeInfo> {
  const all = await shapes(page)
  const hit = all.find(
    (s) => s.type === 'frame' && (typeof name === 'string' ? s.name === name : name.test(s.name)),
  )
  if (!hit) throw new Error(`no frame named ${name}`)
  return hit
}

/** A page point as client (mouse) coordinates. */
export function toScreen(page: Page, p: Point): Promise<Point> {
  return page.evaluate((pt) => {
    const ed = window.editor as unknown as DemoEditor
    const s = ed.pageToScreen(pt)
    return { x: s.x, y: s.y }
  }, p)
}

export const center = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

export const union = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.w))
  const btm = Math.max(...boxes.map((b) => b.y + b.h))
  return { x, y, w: r - x, h: btm - y }
}

/** Frames the view on `b` (page space), like scrolling and zooming there. */
export async function view(page: Page, b: Box, opts: { inset?: number; ms?: number } = {}) {
  await page.evaluate(
    ([box, inset, ms]) => {
      const ed = window.editor as unknown as DemoEditor
      ed.zoomToBounds(box, { inset, ...(ms ? { animation: { duration: ms } } : {}) })
    },
    [b, opts.inset ?? 40, opts.ms ?? 0] as const,
  )
  if (opts.ms) await page.waitForTimeout(opts.ms + 50)
}

/** Centres the view on `p` (page space) at `zoom`, like scrolling there. */
export async function centerView(page: Page, p: Point, zoom: number, ms = 0) {
  const vp = await viewport(page)
  const w = vp.w / zoom
  const h = vp.h / zoom
  await view(page, { x: p.x - w / 2, y: p.y - h / 2, w, h }, { inset: 0, ms })
}

/** The visible canvas area in client coordinates (left of it: the dock; above it: the top bar). */
export function viewport(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const ed = window.editor as unknown as DemoEditor
    const b = ed.getViewportScreenBounds()
    return { x: b.x, y: b.y, w: b.w, h: b.h }
  })
}

export const editingId = (page: Page) =>
  page.evaluate(() => (window.editor as unknown as DemoEditor | undefined)?.getEditingShapeId() ?? null)
