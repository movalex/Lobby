// Test helper (unit tests only): a small in-memory `LobbyCanvas` with the members the mind-map runtime uses,
// a transaction that applies creates, updates and deletes the way the board page's does (`customData.lobby`
// merges per key, a null value removes the key, deleting a container deletes its label, an arrow keeps the
// binding it is given), and a snapshot-based undo stack that follows `joinPrevious`: so a test can say "one
// transact (one undo removes all)" and check the board really is as it was.

import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'

export type El = Record<string, unknown> & {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
}

/** 10 px per character, fontSize * 1.25 per line: easy to reason about. */
export const measure = (text: string, fontSize: number) => {
  const lines = text.split('\n')
  return { width: Math.max(0, ...lines.map((l) => l.length)) * 10, height: lines.length * fontSize * 1.25 }
}

/** The `customData.lobby` of an element, or {} (tests read stamps and values through it). */
export const lobbyOf = (e: object | undefined): Record<string, unknown> =>
  (e as { customData?: { lobby?: Record<string, unknown> } } | undefined)?.customData?.lobby ?? {}

export interface FakeMapCanvas {
  canvas: LobbyCanvas
  els: Map<string, El>
  /** Every transact: its label and whether it joined the previous step. */
  transacts: { label: string; joined: boolean }[]
  /** Undoes the last step (all the transacts that joined into it). */
  undo(): boolean
  /** Undo steps now on the stack. */
  steps(): number
  /** Live elements as JSON, for "the board is as it was". */
  snapshot(): string
  zoomTo: { bounds: unknown; opts: unknown }[]
  readonly selected: string[]
  setReadOnly(v: boolean): void
}

const live = (els: Map<string, El>) => [...els.values()].filter((e) => !e.isDeleted)

export function fakeMapCanvas(
  seed: El[] = [],
  opts: { viewport?: { x: number; y: number; width: number; height: number; zoom: number } } = {},
): FakeMapCanvas {
  const els = new Map<string, El>(
    seed.map((e) => [e.id, { frameId: null, groupIds: [], isDeleted: false, angle: 0, ...e }]),
  )
  const viewport = opts.viewport ?? { x: -1000, y: -700, width: 2000, height: 1400, zoom: 1 }
  let selection: string[] = []
  let readOnly = false
  const transacts: FakeMapCanvas['transacts'] = []
  const undoStack: Map<string, El>[] = []
  const zoomTo: FakeMapCanvas['zoomTo'] = []
  const copy = (m: Map<string, El>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]))
  const labelOf = (e: El) =>
    ((e.boundElements as { id: string; type: string }[] | null) ?? []).find((b) => b.type === 'text')?.id

  const mergeLobby = (cur: unknown, patch: unknown) => {
    const had = ((cur as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}) as Record<
      string,
      unknown
    >
    const lobby = { ...had }
    for (const [k, v] of Object.entries((patch as { lobby?: Record<string, unknown> }).lobby ?? {})) {
      if (v === null) delete lobby[k]
      else lobby[k] = v
    }
    return { ...(cur as object | undefined), lobby }
  }

  const canvas = {
    items: () => live(els) as unknown as CanvasElement[],
    get: (id: string) => els.get(id) as unknown as CanvasElement | undefined,
    bounds: (id: string) => {
      const e = els.get(id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    boundsOf: (ids: readonly string[]) => {
      const bs = ids.map((id) => els.get(id)).filter((e): e is El => !!e)
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
    hide: () => () => undefined,
    readOnly: () => readOnly,
    gesture: () => 'idle',
    editingId: () => null,
    leaseHolder: () => null,
    engine: { welcome: { sid: 'me' } },
    get selection() {
      return selection
    },
    select: (ids: readonly string[]) => {
      selection = [...ids]
    },
    on: () => () => undefined,
    focus: () => undefined,
    saveStatus: () => ({ state: 'saved', pending: 0 }),
    sceneToOverlay: (p: { x: number; y: number }) => ({ x: p.x - viewport.x, y: p.y - viewport.y }),
    container: () => null,
    history: { undo: () => api.undo() },
    viewport: {
      get: () => viewport,
      set: () => undefined,
      zoomTo: (bounds: unknown, o: unknown) => void zoomTo.push({ bounds, opts: o }),
      screenRect: () => ({ x: 0, y: 0, width: viewport.width, height: viewport.height }),
    },
    text: {
      of: (id: string) => {
        const e = els.get(id)
        if (!e) return ''
        if (e.type === 'text') return String(e.originalText ?? '')
        const l = labelOf(e)
        return l ? String(els.get(l)?.originalText ?? '') : ''
      },
      measure: (text: string, o: { fontSize: number }) => measure(text, o.fontSize),
    },
    transact<T>(label: string, fn: (tx: unknown) => T, o?: { joinPrevious?: boolean }): T {
      const joined = o?.joinPrevious === true
      const before = copy(els)
      const out = fn({
        create(kind: string, props: Record<string, unknown>) {
          const id = String(props.id)
          const type = kind === 'note' ? 'stickynote' : kind
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
            width: Number(props.width ?? 0),
            height: Number(props.height ?? 0),
          }
          if (type === 'text') {
            // an alignment point and a measured size, as newTextElement does
            const m = measure(String(props.text ?? ''), Number(props.fontSize ?? 20))
            base.width = m.width
            base.height = m.height
            base.x = Number(props.x) - (props.textAlign === 'center' ? m.width / 2 : 0)
            base.y = Number(props.y) - (props.verticalAlign === 'middle' ? m.height / 2 : 0)
          }
          els.set(id, base)
          return id
        },
        update(id: string, patch: Record<string, unknown>) {
          const e = els.get(id)
          if (!e) throw new Error(`no ${id}`)
          const next: El = { ...e }
          for (const [k, v] of Object.entries(patch)) {
            next[k] = k === 'customData' ? mergeLobby(e.customData, v) : v
          }
          next.version = Number(e.version ?? 1) + 1
          els.set(id, next)
        },
        delete(id: string) {
          const e = els.get(id)
          if (!e) return
          els.set(id, { ...e, isDeleted: true })
          const l = labelOf(e)
          if (l && els.get(l)) els.set(l, { ...(els.get(l) as El), isDeleted: true })
        },
        setFrame() {
          throw new Error('not used here')
        },
      })
      transacts.push({ label, joined })
      if (!joined) undoStack.push(before)
      return out
    },
  }
  const api: FakeMapCanvas = {
    canvas: canvas as unknown as LobbyCanvas,
    els,
    transacts,
    undo() {
      const prev = undoStack.pop()
      if (!prev) return false
      els.clear()
      for (const [k, v] of prev) els.set(k, v)
      return true
    },
    steps: () => undoStack.length,
    snapshot: () => JSON.stringify(live(els)),
    zoomTo,
    get selected() {
      return selection
    },
    setReadOnly(v) {
      readOnly = v
    },
  }
  return api
}
