// Helpers for the ported mind-map specs (mindmap-*.spec.ts; the port of tests/support/mindmap.ts): the map
// as each browser holds it (topics, their structure from `customData.lobby.mindmap`, text, bounds, hidden
// state, and the lines' bindings), geometry checks, and the feature's own runtime for setup
// (`window.__lobbyMindmap`, behind the same local-dev guard as the board page's debug handle). Reads go
// through the facade (`window.lobbyCanvas`) and the board page's canvas (`window.__lobbyBoard.canvas`,
// for the wave-1 members 2E has not put on the facade yet: `isHidden`, `text`).
import { expect, type Page } from '@playwright/test'
import { editingId, TEXT_EDITOR } from '../tests/support/canvas.ts'

export interface BoxLike {
  x: number
  y: number
  w: number
  h: number
}

export interface TopicView {
  id: string
  type: string
  text: string
  rootId: string
  parentId: string | null
  side: string
  collapsed: boolean
  hidden: boolean
  strokeColor: string
  backgroundColor: string
  frameId: string | null
  box: BoxLike
}

export interface EdgeView {
  id: string
  parentId: string
  childId: string
  start: string | null
  end: string | null
  hidden: boolean
  elbowed: boolean
  strokeColor: string
}

export interface MapView {
  topics: TopicView[]
  edges: EdgeView[]
}

/** Every topic and line on the board, as this browser holds them. */
export function mapView(page: Page): Promise<MapView> {
  return page.evaluate(() => {
    type El = {
      id: string
      type: string
      isDeleted?: boolean
      containerId?: string | null
      originalText?: string
      strokeColor?: string
      backgroundColor?: string
      frameId?: string | null
      elbowed?: boolean
      boundElements?: { id: string; type: string }[] | null
      startBinding?: { elementId: string } | null
      endBinding?: { elementId: string } | null
      customData?: { lobby?: Record<string, unknown> }
    }
    const f = (
      window as unknown as {
        lobbyCanvas: {
          items(): El[]
          bounds(id: string): { x: number; y: number; width: number; height: number } | null
        }
      }
    ).lobbyCanvas
    const board = (window as unknown as { __lobbyBoard?: { canvas: { isHidden(id: string): boolean } } })
      .__lobbyBoard
    const all = f.items()
    const byId = new Map(all.map((e) => [e.id, e]))
    const textOf = (e: El) => {
      if (e.type === 'text') return e.originalText ?? ''
      const l = (e.boundElements ?? []).find((b) => b.type === 'text')
      const label = l ? byId.get(l.id) : undefined
      return label && !label.isDeleted ? (label.originalText ?? '') : ''
    }
    const topics: TopicView[] = []
    const edges: EdgeView[] = []
    for (const e of all) {
      if (e.isDeleted) continue
      const t = e.customData?.lobby?.mindmap as
        | { rootId: string; parentId: string | null; side: string; collapsed: boolean }
        | undefined
      const g = e.customData?.lobby?.mindmapEdge as { parentId: string; childId: string } | undefined
      if (t && !(e.type === 'text' && e.containerId)) {
        const b = f.bounds(e.id)
        if (!b) continue
        topics.push({
          id: e.id,
          type: e.type,
          text: textOf(e),
          rootId: t.rootId,
          parentId: t.parentId,
          side: t.side,
          collapsed: t.collapsed,
          hidden: board?.canvas.isHidden(e.id) ?? false,
          strokeColor: e.strokeColor ?? '',
          backgroundColor: e.backgroundColor ?? '',
          frameId: e.frameId ?? null,
          box: { x: b.x, y: b.y, w: b.width, h: b.height },
        })
      } else if (g && e.type === 'arrow') {
        edges.push({
          id: e.id,
          parentId: g.parentId,
          childId: g.childId,
          start: e.startBinding?.elementId ?? null,
          end: e.endBinding?.elementId ?? null,
          hidden: board?.canvas.isHidden(e.id) ?? false,
          elbowed: e.elbowed === true,
          strokeColor: e.strokeColor ?? '',
        })
      }
    }
    return { topics, edges }
  })
}

export const byText = (view: MapView, text: string): TopicView => {
  const t = view.topics.find((x) => x.text === text)
  if (!t) throw new Error(`no topic "${text}" in ${JSON.stringify(view.topics.map((x) => x.text))}`)
  return t
}

/** "parent > child" pairs of the map by text, sorted (a structure fingerprint independent of ids). */
export function structure(view: MapView): string[] {
  const text = new Map(view.topics.map((t) => [t.id, t.text]))
  return view.topics
    .map((t) => (t.parentId ? `${text.get(t.parentId) ?? '?'} > ${t.text}` : `(root) ${t.text}`))
    .sort()
}

const overlap = (a: BoxLike, b: BoxLike) =>
  a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5

/** Problems with the map as shown: overlapping topics, lines not bound to their parent and child. */
export function mapProblems(view: MapView): string[] {
  const out: string[] = []
  const shown = view.topics.filter((t) => !t.hidden)
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i] as TopicView
      const b = shown[j] as TopicView
      if (overlap(a.box, b.box)) out.push(`"${a.text}" overlaps "${b.text}"`)
    }
  }
  for (const t of view.topics) {
    if (!t.parentId) continue
    const lines = view.edges.filter((e) => e.childId === t.id)
    if (lines.length !== 1) out.push(`"${t.text}" has ${lines.length} lines`)
    const l = lines[0]
    if (l && (l.start !== t.parentId || l.end !== t.id))
      out.push(`the line to "${t.text}" is not bound to it`)
    if (l && l.hidden !== t.hidden) out.push(`the line to "${t.text}" is ${l.hidden ? 'hidden' : 'shown'}`)
  }
  return out
}

/** Waits until this browser's map has no overlaps and every line is bound. */
export async function expectTidy(page: Page, timeout = 15_000) {
  await expect.poll(async () => mapProblems(await mapView(page)), { timeout }).toEqual([])
}

/** The text in the open editor (null when none is open). */
export const editingText = (page: Page) =>
  page.evaluate((sel) => {
    const ta = document.querySelector<HTMLTextAreaElement>(sel)
    return ta ? ta.value : null
  }, TEXT_EDITOR)

/** Waits until a topic is being edited and its editor has the keyboard (the lease is granted). */
export async function waitForTyping(page: Page, timeout = 15_000) {
  await expect.poll(() => editingId(page), { timeout }).not.toBeNull()
  const editor = page.locator(TEXT_EDITOR)
  await expect(editor).toBeFocused({ timeout })
  await expect(editor).toHaveJSProperty('readOnly', false, { timeout })
}

/** A map to build for setup: text, or [text, children]. */
export type MapSpec = string | [string, MapSpec[]]

/**
 * Builds a map through the feature's own runtime (window.__lobbyMindmap): the same operations the keys
 * run, with each topic's words written by the runtime (`setTopicText`: through the lease for a topic that
 * has a label) instead of typing. Returns topic ids by text.
 */
export async function buildMap(page: Page, spec: MapSpec): Promise<Record<string, string>> {
  return page.evaluate(async (json) => {
    type Spec = string | [string, Spec[]]
    const s = JSON.parse(json) as Spec
    const m = (
      window as unknown as {
        __lobbyMindmap?: {
          rt: {
            createMap(): string | null
            addChild(id: string): string | null
            setTopicText(id: string, text: string): Promise<boolean>
            canvas: { select(ids: string[]): void }
            fresh: unknown
          }
        }
      }
    ).__lobbyMindmap
    if (!m) throw new Error('no mind-map runtime (window.__lobbyMindmap)')
    const { rt } = m
    const ids: Record<string, string> = {}
    const settle = () => new Promise((r) => setTimeout(r, 30))
    const setText = async (id: string, text: string) => {
      for (let i = 0; i < 100 && !(await rt.setTopicText(id, text)); i++) await settle()
      ids[text] = id
    }
    const [rootText, kids] = typeof s === 'string' ? [s, [] as Spec[]] : s
    const root = rt.createMap()
    if (!root) throw new Error('no map')
    await setText(root, rootText)
    const add = async (parent: string, list: Spec[]) => {
      for (const k of list) {
        const [text, sub] = typeof k === 'string' ? [k, [] as Spec[]] : k
        const id = rt.addChild(parent)
        if (!id) throw new Error(`no child of ${parent}`)
        rt.fresh = null
        await setText(id, text)
        await add(id, sub)
      }
    }
    await add(root, kids)
    rt.canvas.select([])
    return ids
  }, JSON.stringify(spec))
}

/** Selects one element (and gives the board the keyboard, as a click would). */
export async function selectOnly(page: Page, id: string) {
  await page.evaluate((elementId) => {
    const f = (window as unknown as { lobbyCanvas: { select(ids: string[]): void } }).lobbyCanvas
    f.select([elementId])
    document.querySelector<HTMLElement>('.excalidraw')?.focus()
  }, id)
}

/** Whether an element is hidden by a collapse on this browser. */
export const hidden = (page: Page, id: string) =>
  page.evaluate(
    (elementId) =>
      (
        window as unknown as { __lobbyBoard: { canvas: { isHidden(id: string): boolean } } }
      ).__lobbyBoard.canvas.isHidden(elementId),
    id,
  )

/** Gives the board the keyboard without a click (a click could land on a topic). */
export async function focusCanvas(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
}
