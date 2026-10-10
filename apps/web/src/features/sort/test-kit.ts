// Test helpers for the sort and placement code (not shipped: only the tests import it): a small in-memory
// canvas with the LobbyCanvas members the feature uses, a note builder, and a feature context around it.
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { NOTE_PALETTE } from '../canvas-ux/palette.ts'

export type El = Record<string, unknown> & {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
}

/** 10 px per character, 1.25 line height: easy to reason about. */
export const measure = (text: string, style: { fontSize: number }) => {
  const lines = text.split('\n')
  return {
    width: Math.max(...lines.map((l) => l.length)) * 10,
    height: Math.ceil(lines.length * style.fontSize * 1.25),
  }
}

export const fillOf = (name: string) => NOTE_PALETTE.find((s) => s.name === name)?.light.fill ?? '#123456'

export interface NoteOpts {
  fill?: string
  text?: string
  frameId?: string | null
  size?: number
  locked?: boolean
  by?: { uid: string; name: string } | null
  tags?: Record<string, { name: string; color: string }>
  prompt?: boolean
  angle?: number
}

/** A sticky note with its bound label (id `<id>.t`). */
export function noteEls(id: string, x: number, y: number, o: NoteOpts = {}): El[] {
  const size = o.size ?? 200
  const lobby: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o.tags ?? {})) lobby[`tag:${k}`] = v
  if (o.prompt) lobby.prompt = 'true'
  const note: El = {
    id,
    type: 'stickynote',
    x,
    y,
    width: size,
    height: size,
    angle: o.angle ?? 0,
    frameId: o.frameId ?? null,
    groupIds: [],
    isDeleted: false,
    locked: o.locked ?? false,
    backgroundColor: o.fill ?? fillOf('black'),
    boundElements: [{ id: `${id}.t`, type: 'text' }],
    index: null,
    customData: {
      ...(Object.keys(lobby).length ? { lobby } : {}),
      lobbyServer: {
        createdBy: o.by === undefined ? { uid: 'usr_alice', name: 'Alice' } : o.by,
        createdAt: 1,
        lastEditedBy: null,
        lastEditedAt: 1,
      },
    },
  }
  const label: El = {
    id: `${id}.t`,
    type: 'text',
    containerId: id,
    x: x + 10,
    y: y + 90,
    width: size - 20,
    height: 20,
    angle: 0,
    frameId: o.frameId ?? null,
    groupIds: [],
    isDeleted: false,
    locked: false,
    originalText: o.text ?? id,
    text: o.text ?? id,
  }
  return [note, label]
}

export function frameEl(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  name = id,
  over: Partial<El> = {},
): El {
  return {
    id,
    type: 'frame',
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    name,
    frameId: null,
    groupIds: [],
    isDeleted: false,
    locked: false,
    index: null,
    ...over,
  }
}

export function textEl(id: string, x: number, y: number, text: string, over: Partial<El> = {}): El {
  const m = measure(text, { fontSize: 20 })
  return {
    id,
    type: 'text',
    x,
    y,
    width: m.width,
    height: m.height,
    angle: 0,
    originalText: text,
    text,
    containerId: null,
    frameId: null,
    groupIds: [],
    isDeleted: false,
    locked: false,
    ...over,
  }
}

export function arrowEl(id: string, from: string, to: string, over: Partial<El> = {}): El {
  return {
    id,
    type: 'arrow',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    points: [
      [0, 0],
      [10, 10],
    ],
    startBinding: { elementId: from },
    endBinding: { elementId: to },
    frameId: null,
    groupIds: [],
    isDeleted: false,
    locked: false,
    ...over,
  }
}

export interface FakeCanvasOptions {
  readOnly?: boolean
  /** element id → who holds its text lease */
  leases?: Record<string, { sid: string; uid: string; name: string }>
  /** element id → who is dragging it */
  draggers?: Record<string, { sid: string; name: string }>
  roster?: { sid: string; uid: string; name: string }[]
  doc?: Record<string, unknown>
}

export interface Fake {
  canvas: LobbyCanvas
  els: Map<string, El>
  /** the names of the transact calls, in order */
  steps: string[]
  /** every write of every transact, in order */
  ops: { op: 'create' | 'update' | 'delete' | 'setFrame' | 'insert'; id?: string; patch?: unknown }[]
  leases: Record<string, { sid: string; uid: string; name: string }>
  draggers: Record<string, { sid: string; name: string }>
  selected: string[]
  /** the bounds the camera was asked to show */
  shown: unknown[]
  /** run `fn` as if another session changed the board (no step, no op recorded) */
  external(fn: (els: Map<string, El>) => void): void
}

export function fakeCanvas(seed: El[], o: FakeCanvasOptions = {}): Fake {
  const els = new Map<string, El>(
    seed.map((e) => [e.id, { frameId: null, groupIds: [], isDeleted: false, locked: false, angle: 0, ...e }]),
  )
  // a connector is listed in the `boundElements` of the notes it is bound to, as the engine keeps it
  for (const e of els.values()) {
    if (e.type !== 'arrow') continue
    for (const end of [e.startBinding, e.endBinding] as ({ elementId: string } | null | undefined)[]) {
      const t = end ? els.get(end.elementId) : undefined
      if (!t) continue
      const list = (t.boundElements as { id: string; type: string }[] | null) ?? []
      if (!list.some((b) => b.id === e.id)) t.boundElements = [...list, { id: e.id, type: 'arrow' }]
    }
  }
  const fake: Fake = {
    canvas: undefined as unknown as LobbyCanvas,
    els,
    steps: [],
    ops: [],
    leases: { ...(o.leases ?? {}) },
    draggers: { ...(o.draggers ?? {}) },
    selected: [],
    shown: [],
    external: (fn) => fn(els),
  }
  const live = () => [...els.values()].filter((e) => !e.isDeleted)
  const labelOf = (e: El) =>
    ((e.boundElements as { id: string; type: string }[] | null) ?? []).find((b) => b.type === 'text')?.id
  let counter = 0
  const canvas = {
    items: () => live() as unknown as CanvasElement[],
    get: (id: string) => els.get(id) as unknown as CanvasElement | undefined,
    bounds: (id: string) => {
      const e = els.get(id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    boundsOf: (ids: readonly string[]) => {
      const bs = ids.map((id) => els.get(id)).filter((e): e is El => !!e && !e.isDeleted)
      if (!bs.length) return null
      const x = Math.min(...bs.map((e) => e.x))
      const y = Math.min(...bs.map((e) => e.y))
      return {
        x,
        y,
        width: Math.max(...bs.map((e) => e.x + e.width)) - x,
        height: Math.max(...bs.map((e) => e.y + e.height)) - y,
      }
    },
    // the view (-500, -500) at zoom 1, the canvas at the client's top-left (M4-4's reveal reads these)
    sceneToScreen: (p: { x: number; y: number }) => ({ x: p.x + 500, y: p.y + 500 }),
    container: () => null,
    isLocked: (id: string) => {
      const e = els.get(id)
      if (!e) return false
      if (e.locked) return true
      const c = e.containerId ? els.get(String(e.containerId)) : undefined
      return c?.locked === true
    },
    isHidden: () => false,
    readOnly: () => o.readOnly === true,
    get selection() {
      return fake.selected
    },
    select: (ids: readonly string[]) => {
      fake.selected = [...ids]
    },
    editingId: () => null,
    focus: () => {},
    leaseHolder: (id: string) => fake.leases[id] ?? null,
    collaborators: () => o.roster ?? [],
    presence: { draggerOf: (id: string) => fake.draggers[id] ?? null, peers: () => [], peer: () => null },
    doc: {
      get: (k: string) => o.doc?.[k],
      entries: (prefix?: string) =>
        new Map(Object.entries(o.doc ?? {}).filter(([k]) => !prefix || k.startsWith(prefix))),
      set: () => {},
    },
    viewport: {
      get: () => ({ x: -500, y: -500, width: 4000, height: 3000, zoom: 1 }),
      zoomTo: () => {},
      ensureVisible: (b: unknown) => {
        fake.shown.push(b)
      },
      screenRect: () => ({ x: 0, y: 0, width: 4000, height: 3000 }),
      set: () => {},
    },
    text: {
      of: (id: string) => {
        const e = els.get(id)
        if (!e) return ''
        if (e.type === 'text') return String(e.originalText ?? '')
        if (e.type === 'frame') return String(e.name ?? '')
        const l = labelOf(e)
        return l ? String(els.get(l)?.originalText ?? '') : ''
      },
      measure,
    },
    transact<T>(label: string, fn: (tx: unknown) => T): T {
      fake.steps.push(label)
      const tx = {
        create(kind: string, props: Record<string, unknown>) {
          const id = String(props.id ?? `new${++counter}`)
          fake.ops.push({ op: 'create', id, patch: { kind, ...props } })
          if (kind === 'text') {
            const m = measure(String(props.text ?? ''), { fontSize: Number(props.fontSize ?? 20) })
            els.set(id, {
              width: m.width,
              height: m.height,
              frameId: null,
              groupIds: [],
              isDeleted: false,
              locked: false,
              containerId: null,
              ...props,
              id,
              type: 'text',
              x: Number(props.x),
              y: Number(props.y),
            } as El)
            return id
          }
          els.set(id, {
            width: 100,
            height: 100,
            frameId: null,
            groupIds: [],
            isDeleted: false,
            locked: false,
            ...props,
            id,
            type: kind === 'note' ? 'stickynote' : kind,
            x: Number(props.x),
            y: Number(props.y),
          } as El)
          return id
        },
        update(id: string, patch: Record<string, unknown>) {
          const e = els.get(id)
          if (!e) throw new Error(`no ${id}`)
          fake.ops.push({ op: 'update', id, patch })
          els.set(id, { ...e, ...patch })
        },
        delete(id: string) {
          const e = els.get(id)
          fake.ops.push({ op: 'delete', id })
          if (e) els.set(id, { ...e, isDeleted: true })
        },
        setFrame(ids: readonly string[], frameId: string | null) {
          for (const id of ids) {
            const e = els.get(id)
            if (!e) continue
            fake.ops.push({ op: 'setFrame', id, patch: { frameId } })
            els.set(id, { ...e, frameId })
            const l = labelOf(e)
            if (l) els.set(l, { ...(els.get(l) as El), frameId })
          }
        },
        insert(elements: readonly Record<string, unknown>[]) {
          for (const e of elements) {
            if (els.has(String(e.id))) throw new Error(`insert: ${String(e.id)} exists`)
          }
          for (const e of elements) {
            fake.ops.push({ op: 'insert', id: String(e.id) })
            els.set(String(e.id), {
              frameId: null,
              groupIds: [],
              isDeleted: false,
              locked: false,
              angle: 0,
              ...e,
            } as unknown as El)
          }
          return elements.map((e) => String(e.id))
        },
      }
      return fn(tx)
    },
  }
  fake.canvas = canvas as unknown as LobbyCanvas
  return fake
}

export interface FakeCtx {
  ctx: CanvasFeatureContext
  notices: { key: string; text: string; tone?: string; testId?: string }[]
  /** a store key the workshop store of `ctx.events` was made under (see lastRevealedResults) */
  events: object
}

/** A feature context around `canvas` (only what the sort and piece code reads). */
export function fakeCtx(canvas: LobbyCanvas, over: Partial<CanvasFeatureContext> = {}): FakeCtx {
  const notices: FakeCtx['notices'] = []
  const events = {}
  const ctx = {
    canvas,
    events,
    me: { user: { id: 'usr_alice', name: 'Alice' } },
    role: 'editor',
    notify: (n: { key: string; text: string; tone?: string; testId?: string }) => {
      notices.push(n)
    },
    dismiss: () => {},
    openPanel: () => {},
    activePanel: null,
    board: { id: 'brd_test', status: 'active' },
    ...over,
  } as unknown as CanvasFeatureContext
  return { ctx, notices, events }
}
