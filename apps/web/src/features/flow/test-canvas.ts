// Test helper (unit tests only, W4): an in-memory canvas with what flow-building and the diagram apply use. Its
// transaction applies creates, updates and deletes as the board page's does and runs the board page's own
// structural writes (canvas/board/tx.ts `bind` and `setFrame`, the code LobbyTx.bind runs), and its undo stack is
// snapshot-based and follows `joinPrevious`, so a test can say "one undo removes it all" and check the board is as
// it was. It records every transact and every bind. It emits 'input' (key and pointer presses), 'selectionChanged'
// (when the selected set changes, as the port does) and 'editingChanged' (its editor opening or closing).
import type { CanvasElement, LobbyCanvas, LobbyTx } from '../../canvas/api/index.ts'
import { bind as bindTx, setFrame as setFrameTx, type TxView } from '../../canvas/board/tx.ts'

export type El = Record<string, unknown> & {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
}

/** 10 px per character, fontSize * 1.25 per line. */
export const measure = (text: string, o: { fontSize: number; width?: number }) => {
  const lines = text.split('\n')
  return { width: Math.max(0, ...lines.map((l) => l.length)) * 10, height: lines.length * o.fontSize * 1.25 }
}

export interface FakeFlowCanvas {
  canvas: LobbyCanvas
  els: Map<string, El>
  transacts: { label: string; joined: boolean; ops: string[] }[]
  binds: { arrow: string; end: 'start' | 'end'; target: string | null }[]
  undo(): boolean
  steps(): number
  /** live elements, sorted by id, as JSON */
  snapshot(): string
  live(): El[]
  readonly selected: string[]
  setReadOnly(v: boolean): void
  edits: { id: string; via: string }[]
  /** a key-down on the board, as the input stream reports it to observers */
  key(
    key: string,
    mods?: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean; synthetic?: boolean },
  ): void
  /** a press on the canvas, as the input stream reports it to observers */
  pointerDown(at?: { x: number; y: number }): void
  /** settles the oldest text.edit request: granted (with an open editor) or not */
  grant(ok: boolean): void
  /** the open editor's textarea (a plain object with value and the calls the runtime makes), or null */
  textarea: {
    value: string
    inputs: number
    setSelectionRange(a: number, b: number): void
    dispatchEvent(): void
  } | null
  replaced: { id: string; text: string }[]
  stops: number
  setTool(t: string): void
  setGesture(g: string): void
  setEditing(id: string | null): void
}

let seq = 0
export const testId = (p = 'e') => `${p}${++seq}`

export function fakeFlowCanvas(seed: Partial<El>[] = []): FakeFlowCanvas {
  const els = new Map<string, El>()
  for (const s of seed) {
    const e = {
      frameId: null,
      groupIds: [],
      isDeleted: false,
      angle: 0,
      locked: false,
      boundElements: null,
      version: 1,
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      ...s,
    } as El
    els.set(e.id, e)
  }
  let selection: string[] = []
  let readOnly = false
  let tool = 'select'
  let gesture = 'idle'
  let editing: string | null = null
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const emit = (event: string, e: unknown) => {
    for (const l of [...(listeners.get(event) ?? [])]) l(e)
  }
  /** this tab's editor opened or closed (the board page's 'editingChanged') */
  const setEditingId = (id: string | null) => {
    if (editing === id) return
    editing = id
    emit('editingChanged', id)
  }
  const editWaiters: ((ok: boolean) => void)[] = []
  const replaced: { id: string; text: string }[] = []
  let stops = 0
  const transacts: FakeFlowCanvas['transacts'] = []
  const binds: FakeFlowCanvas['binds'] = []
  const undoStack: Map<string, El>[] = []
  const edits: FakeFlowCanvas['edits'] = []
  const copy = (m: Map<string, El>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]))
  const live = () => [...els.values()].filter((e) => !e.isDeleted)
  const labelOf = (e: El) =>
    ((e.boundElements as { id: string; type: string }[] | null) ?? []).find((b) => b.type === 'text')?.id

  const create = (kind: string, props: Record<string, unknown>, ops: string[]): string => {
    const id = String(props.id ?? testId())
    const type = kind === 'note' ? 'stickynote' : kind
    const base: El = {
      frameId: null,
      groupIds: [],
      isDeleted: false,
      angle: 0,
      locked: false,
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
      const m = measure(String(props.text ?? ''), { fontSize: Number(props.fontSize ?? 20) })
      base.width = m.width
      base.height = m.height
      base.x = Number(props.x) - (props.textAlign === 'center' ? m.width / 2 : 0)
      base.y = Number(props.y) - (props.verticalAlign === 'middle' ? m.height / 2 : 0)
    }
    if (type === 'stickynote') {
      const size = Number(props.size ?? 200)
      base.width = size
      base.height = size
      const labelId = String(props.labelId ?? `${id}.t`)
      base.boundElements = [{ id: labelId, type: 'text' }]
      delete base.size
      delete base.labelId
      delete base.text
      els.set(labelId, {
        id: labelId,
        type: 'text',
        x: base.x,
        y: base.y,
        width: 0,
        height: 25,
        text: String(props.text ?? ''),
        originalText: String(props.text ?? ''),
        containerId: id,
        frameId: null,
        groupIds: [],
        isDeleted: false,
        angle: 0,
        locked: false,
        boundElements: null,
        version: 1,
      })
    }
    els.set(id, base)
    ops.push(`create ${type} ${id}`)
    return id
  }

  const canvas = {
    items: () => live() as unknown as CanvasElement[],
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
    readOnly: () => readOnly,
    gesture: () => gesture,
    editingId: () => editing,
    tool: () => tool,
    leaseHolder: () => null,
    engine: { welcome: { sid: 'me' } },
    get selection() {
      return selection
    },
    // the port's 'selectionChanged': only when the selected set changes
    select: (ids: readonly string[]) => {
      const was = [...selection].sort().join(',')
      selection = [...ids]
      if ([...ids].sort().join(',') !== was) emit('selectionChanged', [...ids].sort())
    },
    on: (event: string, fn: (e: unknown) => void) => {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(fn)
      return () => set.delete(fn)
    },
    focus: () => undefined,
    viewport: {
      get: () => ({ x: -1000, y: -700, width: 2000, height: 1400, zoom: 1 }),
      ensureVisible: () => undefined,
      set: () => undefined,
    },
    text: {
      of: (id: string) => {
        const e = els.get(id)
        if (!e) return ''
        if (e.type === 'text') return String(e.originalText ?? '')
        const l = labelOf(e)
        return l ? String(els.get(l)?.originalText ?? '') : ''
      },
      measure: (text: string, o: { fontSize: number; width?: number }) => measure(text, o),
      edit: (id: string, o: { via: string }) => {
        edits.push({ id, via: o.via })
        return new Promise<boolean>((resolve) => {
          editWaiters.push((ok) => {
            if (ok) setEditingId(id)
            resolve(ok)
          })
        })
      },
      editorElement: () => (editing ? api.textarea : null),
      stop: () => {
        stops++
        setEditingId(null)
      },
      replace: (id: string, text: string) => {
        replaced.push({ id, text })
        return Promise.resolve(true)
      },
      canEdit: () => !readOnly,
    },
    transact<T>(label: string, fn: (tx: LobbyTx) => T, o?: { joinPrevious?: boolean }): T {
      if (readOnly) throw new Error('read-only: no writes')
      const joined = o?.joinPrevious === true
      const before = copy(els)
      const ops: string[] = []
      const view: TxView = {
        get: (id) => els.get(id) as unknown as CanvasElement | undefined,
        items: () => live() as unknown as CanvasElement[],
        update(id, patch) {
          const e = els.get(id)
          if (!e) throw new Error(`no ${id}`)
          els.set(id, { ...e, ...patch, version: Number(e.version ?? 1) + 1 } as El)
          ops.push(`update ${id} ${Object.keys(patch).sort().join(',')}`)
        },
        create: (kind, props) => create(kind, props as Record<string, unknown>, ops),
        newId: () => testId('g'),
      }
      const tx = {
        create: (kind: string, props: Record<string, unknown>) => create(kind, props, ops),
        update: (id: string, patch: Record<string, unknown>) => view.update(id, patch),
        delete(id: string) {
          const e = els.get(id)
          if (!e) return
          els.set(id, { ...e, isDeleted: true })
          const l = labelOf(e)
          if (l && els.get(l)) els.set(l, { ...(els.get(l) as El), isDeleted: true })
          ops.push(`delete ${id}`)
        },
        bind(arrow: string, end: 'start' | 'end', target: string | null) {
          binds.push({ arrow, end, target })
          bindTx(view, arrow, end, target)
        },
        setFrame: (ids: readonly string[], frameId: string | null) => setFrameTx(view, ids, frameId),
      } as unknown as LobbyTx
      let out: T
      try {
        out = fn(tx)
      } catch (e) {
        els.clear()
        for (const [k, v] of before) els.set(k, v)
        throw e
      }
      transacts.push({ label, joined, ops })
      if (!joined || !undoStack.length) undoStack.push(before)
      return out
    },
    history: { undo: () => api.undo(), canUndo: () => undoStack.length > 0 },
  }
  const api: FakeFlowCanvas = {
    canvas: canvas as unknown as LobbyCanvas,
    els,
    transacts,
    binds,
    undo() {
      const prev = undoStack.pop()
      if (!prev) return false
      els.clear()
      for (const [k, v] of prev) els.set(k, v)
      return true
    },
    steps: () => undoStack.length,
    snapshot: () => JSON.stringify(live().sort((a, b) => (a.id < b.id ? -1 : 1))),
    live,
    get selected() {
      return selection
    },
    setReadOnly(v) {
      readOnly = v
    },
    edits,
    key(key, mods = {}) {
      const e = {
        type: 'key-down',
        key,
        code: '',
        synthetic: mods.synthetic === true,
        composing: false,
        shift: mods.shift === true,
        ctrl: mods.ctrl === true,
        meta: mods.meta === true,
        alt: mods.alt === true,
        handled: () => undefined,
      }
      emit('input', e)
    },
    pointerDown(at = { x: 0, y: 0 }) {
      emit('input', {
        type: 'pointer-down',
        scene: at,
        screen: at,
        hit: null,
        button: 0,
        pointerType: 'mouse',
        shift: false,
        ctrl: false,
        meta: false,
        alt: false,
        handled: () => undefined,
      })
    },
    grant(ok) {
      const w = editWaiters.shift()
      if (!w) throw new Error('no edit request')
      if (ok)
        api.textarea = {
          value: '',
          inputs: 0,
          setSelectionRange: () => undefined,
          dispatchEvent() {
            ;(api.textarea as { inputs: number }).inputs++
          },
        }
      w(ok)
    },
    textarea: null,
    replaced,
    get stops() {
      return stops
    },
    setTool(t) {
      tool = t
    },
    setGesture(g) {
      gesture = g
    },
    setEditing(id) {
      setEditingId(id)
    },
  }
  return api
}
