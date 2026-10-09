// Test helper (unit tests only; nothing in the app imports it): an in-memory board for the wave L AI tests, with
// the LobbyCanvas members the AI feature uses and a feature context around it.
//  - transact applies creates, updates and deletes the way the board page's port does (a note gets its label
//    `<id>.t`, deleting a container deletes its label, every write bumps the element's version, `customData.lobby`
//    merges per key), counts as one PUSH per transact (the sync push counter of the e2e), and is undone as one
//    step with the transacts that joined it;
//  - the server is simulated by `stamp()`: every element without `lobbyServer` gets createdAt = lastEditedAt =
//    the clock; `editText(id, text, at)` is a collaborator's text edit (it moves lastEditedAt and the version and
//    is reported as a remote change, never a push);
//  - the api is a queue of answers (`answer(...)`), each request recorded; the event stream can be fed (`emit`).

import type { AiStatus } from '@draftroom/contracts'
import { type ComponentType, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { vi } from 'vitest'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  CanvasFeatureContextProvider,
  type LobbyCanvas,
} from '../../../canvas/api/index.ts'
import { aiStatus, setAiCtx } from './runtime.ts'

export type El = Record<string, unknown> & {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
}

export const AI_ON: AiStatus = {
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: true,
  budget: null,
  settings: null,
}

/** 10 px per character, fontSize * 1.25 per line. */
export const measure = (text: string, fontSize: number) => {
  const lines = text.split('\n')
  return { width: Math.max(0, ...lines.map((l) => l.length)) * 10, height: lines.length * fontSize * 1.25 }
}

type ChangeListener = (c: { source: string; created: string[]; updated: string[]; deleted: string[] }) => void

export interface Kit {
  canvas: LobbyCanvas
  ctx: CanvasFeatureContext
  els: Map<string, El>
  /** transacts that were pushed (each is one push), with their labels */
  pushes: { label: string; joined: boolean }[]
  /** api requests made */
  requests: { method: string; path: string; body: Record<string, unknown> }[]
  answer(...a: (unknown | (() => unknown))[]): void
  notify: ReturnType<typeof vi.fn>
  openPanel: ReturnType<typeof vi.fn>
  emit(type: string, data: unknown): void
  /** the server stamps what it has not stamped yet (createdAt = lastEditedAt = now) */
  stamp(now?: number): void
  /** a collaborator edits the text of `id`'s label (or of a text) at `at` (a remote change) */
  editText(id: string, text: string, at: number): void
  /** a collaborator moves `id` (a remote change: a new version, nothing else) */
  moveRemote(id: string, dx: number): void
  undo(): boolean
  steps(): number
  setReadOnly(v: boolean): void
  setDoc(key: string, value: unknown): void
  setHovered(id: string | null): void
  live(): El[]
}

export function aiKit(seed: El[] = [], opts: { status?: AiStatus | null; me?: string } = {}): Kit {
  const els = new Map<string, El>(
    seed.map((e) => [e.id, { frameId: null, groupIds: [], isDeleted: false, angle: 0, version: 1, ...e }]),
  )
  let selection: string[] = []
  let readOnly = false
  let hovered: string | null = null
  const doc = new Map<string, unknown>()
  const pushes: Kit['pushes'] = []
  const undoStack: Map<string, El>[] = []
  const listeners = new Set<ChangeListener>()
  const eventListeners = new Map<string, Set<(d: unknown) => void>>()
  const requests: Kit['requests'] = []
  const answers: (unknown | (() => unknown))[] = []
  const viewport = { x: -1000, y: -700, width: 2000, height: 1400, zoom: 1 }
  const copy = (m: Map<string, El>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]))
  const labelOf = (e: El) =>
    ((e.boundElements as { id: string; type: string }[] | null) ?? []).find((b) => b.type === 'text')?.id
  const live = () => [...els.values()].filter((e) => !e.isDeleted)
  const fire = (source: string, created: string[], updated: string[], deleted: string[]) => {
    for (const l of [...listeners]) l({ source, created, updated, deleted })
  }
  const box = (e: El) => ({ x: e.x, y: e.y, width: e.width, height: e.height })
  const canvas = {
    items: () => live() as unknown as CanvasElement[],
    get: (id: string) => els.get(id) as unknown as CanvasElement | undefined,
    bounds: (id: string) => {
      const e = els.get(id)
      return e ? box(e) : null
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
    isLocked: (id: string) => els.get(id)?.locked === true,
    isHidden: () => false,
    readOnly: () => readOnly,
    editingId: () => null,
    leaseHolder: () => null,
    hovered: () => hovered,
    follow: { current: () => null, start: () => undefined, stop: () => undefined },
    get selection() {
      return selection
    },
    select: (ids: readonly string[]) => {
      selection = [...ids]
    },
    on: (event: string, l: ChangeListener) => {
      if (event !== 'change') return () => undefined
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    focus: () => undefined,
    saveStatus: () => ({ state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }),
    sceneToOverlay: (p: { x: number; y: number }) => ({ x: p.x - viewport.x, y: p.y - viewport.y }),
    container: () => null,
    doc: { get: (k: string) => doc.get(k), entries: () => new Map(), set: () => undefined },
    history: { undo: () => api.undo(), redo: () => undefined, canUndo: () => undoStack.length > 0 },
    viewport: {
      get: () => viewport,
      set: () => undefined,
      zoomTo: vi.fn(),
      fit: () => undefined,
      moving: () => false,
      screenRect: () => ({ x: 0, y: 0, width: viewport.width, height: viewport.height }),
    },
    text: {
      of: (id: string) => {
        const e = els.get(id)
        if (!e) return ''
        if (e.type === 'text') return String(e.originalText ?? e.text ?? '')
        if (e.type === 'frame') return String(e.name ?? '')
        const l = labelOf(e)
        return l ? String(els.get(l)?.originalText ?? '') : ''
      },
      measure: (text: string, o: { fontSize: number }) => measure(text, o.fontSize),
    },
    transact<T>(label: string, fn: (tx: unknown) => T, o?: { joinPrevious?: boolean }): T {
      if (readOnly) throw new Error('read-only: no writes')
      const joined = o?.joinPrevious === true
      const before = copy(els)
      const created: string[] = []
      const updated: string[] = []
      const deleted: string[] = []
      const bump = (e: El) => ({ ...e, version: Number(e.version ?? 1) + 1 })
      const out = fn({
        create(kind: string, props: Record<string, unknown>) {
          const id = String(props.id ?? `el${els.size + 1}`)
          const type = kind === 'note' ? 'stickynote' : kind
          const size = Number(props.size ?? 200)
          const base: El = {
            frameId: null,
            groupIds: [],
            isDeleted: false,
            angle: 0,
            boundElements: null,
            version: 1,
            ...props,
            id,
            type,
            x: Number(props.x ?? 0),
            y: Number(props.y ?? 0),
            width: kind === 'note' ? size : Number(props.width ?? 0),
            height: kind === 'note' ? size : Number(props.height ?? 0),
          }
          if (type === 'text') {
            const m = measure(String(props.text ?? ''), Number(props.fontSize ?? 20))
            base.width = m.width
            base.height = m.height
            base.originalText = props.originalText ?? props.text
          }
          if (kind === 'note' && props.text) {
            const labelId = String(props.labelId ?? `${id}.t`)
            base.boundElements = [{ id: labelId, type: 'text' }]
            delete base.text
            els.set(labelId, {
              id: labelId,
              type: 'text',
              containerId: id,
              originalText: props.text,
              x: base.x + 10,
              y: base.y + 10,
              width: size - 20,
              height: 20,
              frameId: null,
              groupIds: [],
              isDeleted: false,
              version: 1,
            })
            created.push(labelId)
          }
          els.set(id, base)
          created.push(id)
          return id
        },
        update(id: string, patch: Record<string, unknown>) {
          const e = els.get(id)
          if (!e) throw new Error(`no ${id}`)
          els.set(id, bump({ ...e, ...patch }))
          updated.push(id)
        },
        delete(id: string) {
          const e = els.get(id)
          if (!e) return
          els.set(id, bump({ ...e, isDeleted: true }))
          deleted.push(id)
          const l = labelOf(e)
          const le = l ? els.get(l) : undefined
          if (l && le) {
            els.set(l, bump({ ...le, isDeleted: true }))
            deleted.push(l)
          }
        },
        setFrame(ids: readonly string[], frameId: string | null) {
          for (const id of ids) {
            const e = els.get(id)
            if (!e) continue
            els.set(id, bump({ ...e, frameId }))
            updated.push(id)
            const l = labelOf(e)
            const le = l ? els.get(l) : undefined
            if (l && le) els.set(l, bump({ ...le, frameId }))
          }
        },
      })
      pushes.push({ label, joined })
      if (!joined) undoStack.push(before)
      fire('local', created, updated, deleted)
      return out
    },
  }
  const notify = vi.fn()
  const openPanel = vi.fn()
  const request = vi.fn(
    async (
      method: string,
      path: string,
      o: { body?: Record<string, unknown>; schema?: { parse(v: unknown): unknown } | null } = {},
    ) => {
      requests.push({ method, path, body: o.body ?? {} })
      const next = answers.shift()
      if (next === undefined) throw new Error(`no answer queued for ${method} ${path}`)
      const raw = typeof next === 'function' ? (next as () => unknown)() : next
      return o.schema ? o.schema.parse(raw) : raw
    },
  )
  const ctx = {
    canvas,
    board: { id: 'b-kit0000001', title: 'Board', status: 'active' },
    role: 'editor',
    me: { user: { id: opts.me ?? 'usr_ana', name: 'Ana' } },
    workspace: { id: 'ws_1', name: 'Studio' },
    api: { request },
    notify,
    dismiss: vi.fn(),
    openPanel,
    activePanel: null,
    events: {
      on: (type: string, l: (d: unknown) => void) => {
        const set = eventListeners.get(type) ?? new Set()
        set.add(l)
        eventListeners.set(type, set)
        return () => void set.delete(l)
      },
      onResync: () => () => undefined,
      serverOffsetMs: () => 0,
      onAccessLost: () => () => undefined,
      close: () => undefined,
    },
    registries: { menusOpen: { call: () => false } },
  } as unknown as CanvasFeatureContext
  setAiCtx(ctx)
  aiStatus(canvas as unknown as LobbyCanvas).set(opts.status === undefined ? AI_ON : opts.status)
  const api: Kit = {
    canvas: canvas as unknown as LobbyCanvas,
    ctx,
    els,
    pushes,
    requests,
    answer: (...a) => void answers.push(...a),
    notify,
    openPanel,
    emit(type, data) {
      for (const l of [...(eventListeners.get(type) ?? [])]) l(data)
    },
    stamp(now = 1_000) {
      for (const [id, e] of els) {
        const cd = (e.customData ?? {}) as Record<string, unknown>
        if (cd.lobbyServer) continue
        els.set(id, {
          ...e,
          customData: {
            ...cd,
            lobbyServer: {
              createdBy: { uid: 'usr_ana', name: 'Ana', guest: false },
              createdAt: now,
              lastEditedBy: null,
              lastEditedAt: now,
            },
          },
          // the server's fix comes back as the next version, as an ack's `v` does
          version: Number(e.version ?? 1) + 1,
        })
      }
    },
    editText(id, text, at) {
      const e = els.get(id)
      if (!e) throw new Error(`no ${id}`)
      const target = e.type === 'text' ? id : labelOf(e)
      const t = target ? els.get(target) : undefined
      if (!target || !t) throw new Error(`no text for ${id}`)
      const cd = (t.customData ?? {}) as { lobbyServer?: Record<string, unknown> }
      els.set(target, {
        ...t,
        originalText: text,
        version: Number(t.version ?? 1) + 1,
        customData: { ...cd, lobbyServer: { ...(cd.lobbyServer ?? {}), lastEditedAt: at } },
      })
      fire('remote', [], [target], [])
    },
    moveRemote(id, dx) {
      const e = els.get(id)
      if (!e) throw new Error(`no ${id}`)
      els.set(id, { ...e, x: e.x + dx, version: Number(e.version ?? 1) + 1 })
      fire('remote', [], [id], [])
    },
    undo() {
      const prev = undoStack.pop()
      if (!prev) return false
      els.clear()
      for (const [k, v] of prev) els.set(k, v)
      return true
    },
    steps: () => undoStack.length,
    setReadOnly(v) {
      readOnly = v
    },
    setDoc: (k, v) => void doc.set(k, v),
    setHovered(id) {
      hovered = id
    },
    live,
  }
  return api
}

/** A sticky note with its label, as the board has it after the server stamped it. */
export function note(id: string, x: number, y: number, text: string, extra: Partial<El> = {}): El[] {
  const at = 500
  const stamp = { createdBy: { uid: 'usr_bo', name: 'Bo', guest: false }, createdAt: at, lastEditedBy: null }
  return [
    {
      id,
      type: 'stickynote',
      x,
      y,
      width: 200,
      height: 200,
      boundElements: [{ id: `${id}.t`, type: 'text' }],
      customData: { lobbyServer: { ...stamp, lastEditedAt: at } },
      ...extra,
    },
    {
      id: `${id}.t`,
      type: 'text',
      containerId: id,
      originalText: text,
      x: x + 10,
      y: y + 10,
      width: 180,
      height: 20,
      customData: {
        lobbyServer: {
          ...stamp,
          lastEditedBy: { uid: 'usr_bo', name: 'Bo', guest: false },
          lastEditedAt: at,
        },
      },
    },
  ]
}

/** A feature component rendered to markup inside the board page's feature context (as the board page does). */
export function renderIn(k: Pick<Kit, 'ctx'>, C: ComponentType<{ ctx: CanvasFeatureContext }>): string {
  return renderToStaticMarkup(
    createElement(CanvasFeatureContextProvider, { value: k.ctx }, createElement(C, { ctx: k.ctx })),
  )
}
