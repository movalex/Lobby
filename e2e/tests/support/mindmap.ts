// Helpers for the mind-map suite (mindmap.spec.ts): the map as each browser holds it (topics, their
// structure from meta, text, page bounds, hidden state, and the lines' bindings), geometry checks and
// the UI entry points. Editor methods used here exist in tldraw 5.4.2
// (node_modules/@tldraw/editor/dist-esm/index.d.mts).
import { expect, type Page } from '@playwright/test'
import { read } from './board.ts'
import { type BoxLike, type EditorLike, plainText, type ShapeLike } from './editor.ts'

export interface MindmapEditor extends EditorLike {
  isShapeHidden(id: string): boolean
  getSvgString(ids: string[], opts?: Record<string, unknown>): Promise<{ svg: string } | undefined>
  getOnlySelectedShape(): ShapeLike | null
  getCanUndo(): boolean
  undo(): EditorLike
  getCurrentPageId(): string
  getCamera(): { x: number; y: number; z: number }
  zoomToFit(opts?: Record<string, unknown>): EditorLike
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
  color: string | null
  box: BoxLike
}

export interface EdgeView {
  id: string
  parentId: string
  childId: string
  start: string | null
  end: string | null
  hidden: boolean
  kind: string
}

export interface MapView {
  topics: TopicView[]
  edges: EdgeView[]
}

/** Every topic and line on the current page, as this browser holds them. */
export function mapView(page: Page): Promise<MapView> {
  return read(page, (ed) => {
    const e = ed as unknown as MindmapEditor
    const toText = (doc: unknown) => {
      const blocks: string[] = []
      const walk = (node: unknown, into: string[]) => {
        if (!node || typeof node !== 'object') return
        const n = node as { text?: unknown; content?: unknown }
        if (typeof n.text === 'string') into.push(n.text)
        if (Array.isArray(n.content)) for (const c of n.content) walk(c, into)
      }
      const root = doc as { content?: unknown }
      for (const b of Array.isArray(root?.content) ? root.content : []) {
        const parts: string[] = []
        walk(b, parts)
        blocks.push(parts.join(''))
      }
      return blocks.join('\n')
    }
    const topics: TopicView[] = []
    const edges: EdgeView[] = []
    for (const s of e.getCurrentPageShapes()) {
      const t = s.meta.drMindmap as
        | { rootId: string; parentId: string | null; side: string; collapsed: boolean }
        | undefined
      const g = s.meta.drMindmapEdge as { parentId: string; childId: string } | undefined
      const b = e.getShapePageBounds(s.id)
      if (t && b) {
        topics.push({
          id: s.id,
          type: s.type,
          text: toText(s.props.richText),
          rootId: t.rootId,
          parentId: t.parentId,
          side: t.side,
          collapsed: t.collapsed,
          hidden: e.isShapeHidden(s.id),
          color: typeof s.props.color === 'string' ? s.props.color : null,
          box: { x: b.x, y: b.y, w: b.w, h: b.h },
        })
      } else if (g) {
        const bs = e.getBindingsFromShape(s.id, 'arrow')
        const at = (terminal: string) =>
          (bs.find((x) => (x.props as { terminal?: string }).terminal === terminal)?.toId as string) ?? null
        edges.push({
          id: s.id,
          parentId: g.parentId,
          childId: g.childId,
          start: at('start'),
          end: at('end'),
          hidden: e.isShapeHidden(s.id),
          kind: String(s.props.kind),
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

/** The text of the topic being edited (null when none). */
export const editingText = (page: Page) =>
  read(page, (ed) => {
    const id = ed.getEditingShapeId()
    const s = id ? ed.getShape(id) : undefined
    if (!s) return null
    const doc = s.props.richText as { content?: Array<{ content?: Array<{ text?: string }> }> }
    return (doc?.content ?? []).map((p) => (p.content ?? []).map((n) => n.text ?? '').join('')).join('\n')
  })

/** Waits until a topic is being edited and its text editor has the keyboard. */
export async function waitForTyping(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ed = window.editor
        const id = ed?.getEditingShapeId()
        const el = document.activeElement as HTMLElement | null
        return (
          !!id &&
          !!el?.isContentEditable &&
          el.closest('[data-shape-id]')?.getAttribute('data-shape-id') === id
        )
      }),
    )
    .toBe(true)
}

export const toolbarButton = (page: Page) => page.getByTestId('tools.dr-mindmap')

/** A map to build for setup: text, or [text, children]. */
export type MapSpec = string | [string, MapSpec[]]

/**
 * Builds a map through the feature's own runtime (window.__drMindmap, exposed behind the same local-dev
 * guard as window.editor): the same operations the keys run, without typing. Returns topic ids by text.
 */
export async function buildMap(page: Page, spec: MapSpec): Promise<Record<string, string>> {
  // As JSON: Playwright's argument typing cannot follow the recursive MapSpec type.
  return page.evaluate((json) => {
    type Spec = string | [string, Spec[]]
    const s = JSON.parse(json) as Spec
    const rt = (window as unknown as { __drMindmap?: Record<string, (...a: unknown[]) => unknown> })
      .__drMindmap
    const ed = window.editor as unknown as {
      updateShape(p: Record<string, unknown>): void
      getShape(id: string): { type: string } | undefined
      setEditingShape(id: string | null): void
      setCurrentTool(id: string): void
      selectNone(): void
    }
    if (!rt || !ed) throw new Error('no mind-map runtime')
    const doc = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined }],
    })
    const ids: Record<string, string> = {}
    const setText = (id: string, text: string) => {
      const shape = ed.getShape(id)
      if (!shape) throw new Error(`no topic ${id}`)
      ed.updateShape({ id, type: shape.type, props: { richText: doc(text) } })
      ids[text] = id
    }
    const [rootText, kids] = typeof s === 'string' ? [s, [] as Spec[]] : s
    const root = rt.createMap?.call(rt) as string
    setText(root, rootText)
    const add = (parent: string, list: Spec[]) => {
      for (const k of list) {
        const [text, sub] = typeof k === 'string' ? [k, [] as Spec[]] : k
        const id = rt.addChild?.call(rt, parent) as string
        setText(id, text)
        add(id, sub)
      }
    }
    add(root, kids)
    ed.setEditingShape(null)
    ed.setCurrentTool('select')
    ed.selectNone()
    return ids
  }, JSON.stringify(spec))
}

/** Selects one shape (and gives the board the keyboard, as a click would). */
export async function selectOnly(page: Page, id: string) {
  await page.evaluate((shapeId) => {
    const ed = window.editor as unknown as { select(id: string): void; focus(): void }
    ed.select(shapeId)
    ed.focus()
  }, id)
}

export { plainText }
