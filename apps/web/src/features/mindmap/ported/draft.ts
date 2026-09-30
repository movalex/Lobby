// A mind-map write, planned against the canvas and then applied as ONE undo step, pushed by the sync
// engine (docs/EXCALIDRAW-CONTRACTS.md §1 rule 4). `LobbyTx` has no reads, but the map's operations read
// what they wrote (a new topic takes part in the layout that places it, a moved topic's line follows it),
// so the draft keeps the writes and answers reads with the canvas plus the writes so far, in the same merge
// rules as the board page's transaction (canvas/port-impl.ts: `customData.lobby` merges per key, a null
// value removes the key; deleting a container deletes its bound label).
//
// How it commits (and why): the board page's transaction applies the writes to an element made in the SAME
// transaction only through its creation props (canvas/port-impl.ts builds the scene from the created
// elements as they were created; a later `tx.update` of one is lost, CR-3D-1). So the draft folds every
// write to an element it creates into that element's creation props, and its own `bind` writes the arrow's
// binding (the fixed point where the end is, 'orbit', as `LobbyTx.bind` does) and the target's
// `boundElements` as plain fields. The one field a creation cannot carry is an arrow's binding (Excalidraw's
// newArrowElement starts every arrow unbound), so a draft that makes lines binds them in a second transact
// that joins the first's undo step (`joinPrevious`): still one undo step.
//
// Only writes that change something are recorded, so a layout of a tidy map commits nothing. Pure (the
// canvas is the only dependency; unit-tested with a fake).

import { newElementId } from '@draftroom/board-ops/elements'
import type { CanvasElement, ItemKind, LobbyCanvas, TransactOptions } from '../../../canvas/api/index.ts'

type Op =
  | { kind: 'create'; id: string; elKind: ItemKind }
  | { kind: 'update'; id: string; patch: Record<string, unknown> }
  | { kind: 'delete'; id: string }

type Bound = { id: string; type: string }
type Binding = { elementId: string; fixedPoint: [number, number]; mode: 'orbit' }

const TYPE_OF: Readonly<Partial<Record<ItemKind, string>>> = { note: 'stickynote' }
/** Fields of a draft's own record that are not creation props. */
const NOT_PROPS = new Set(['type', 'isDeleted', 'startBinding', 'endBinding'])

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5))

type Pt = readonly [number, number]

export class Draft {
  private readonly ops: Op[] = []
  private readonly created = new Map<string, Record<string, unknown>>()
  private readonly patched = new Map<string, Record<string, unknown>>()
  private readonly removed = new Set<string>()
  readonly canvas: Pick<LobbyCanvas, 'get' | 'items' | 'transact'>

  constructor(canvas: Pick<LobbyCanvas, 'get' | 'items' | 'transact'>) {
    this.canvas = canvas
  }

  /** Nothing to write. */
  get empty(): boolean {
    return this.ops.length === 0
  }

  /** Ids this draft created, in order. */
  createdIds(): string[] {
    return [...this.created.keys()]
  }

  /** Ids this draft writes: created, changed or deleted. */
  touchedIds(): string[] {
    return [...new Set([...this.created.keys(), ...this.patched.keys(), ...this.removed])]
  }

  /** An element as this draft sees it (the canvas with the draft's writes), live or deleted. */
  get(id: string): CanvasElement | undefined {
    const made = this.created.get(id)
    const base = (made ?? this.canvas.get(id)) as Record<string, unknown> | undefined
    if (!base) return undefined
    const patch = made ? undefined : this.patched.get(id)
    const out = patch ? { ...base, ...patch } : { ...base }
    if (this.removed.has(id)) out.isDeleted = true
    return out as unknown as CanvasElement
  }

  /** Live elements as this draft sees them (the canvas's paint order, then the created ones). */
  items(): CanvasElement[] {
    const out: CanvasElement[] = []
    for (const el of this.canvas.items()) {
      const v = this.get(el.id)
      if (v && !(v as { isDeleted?: boolean }).isDeleted) out.push(v)
    }
    for (const id of this.created.keys()) {
      const v = this.get(id)
      if (v && !(v as { isDeleted?: boolean }).isDeleted) out.push(v)
    }
    return out
  }

  /**
   * Records a new element; returns its id (`props.id`, or a fresh one). `shape` overrides what the draft
   * reads back where the engine lays the element out itself (a centred label's top-left and size).
   */
  create(
    kind: ItemKind,
    props: Readonly<Record<string, unknown>>,
    shape: Record<string, unknown> = {},
  ): string {
    const id = typeof props.id === 'string' ? props.id : newElementId()
    this.ops.push({ kind: 'create', id, elKind: kind })
    this.created.set(id, {
      groupIds: [],
      frameId: null,
      locked: false,
      angle: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      boundElements: null,
      ...props,
      ...shape,
      id,
      isDeleted: false,
      type: TYPE_OF[kind] ?? kind,
    })
    return id
  }

  private set(id: string, fields: Record<string, unknown>) {
    const made = this.created.get(id)
    if (made) this.created.set(id, { ...made, ...fields })
    else this.patched.set(id, { ...(this.patched.get(id) ?? {}), ...fields })
  }

  /**
   * Records field changes (only the ones that differ from what the draft sees). `customData.lobby` keys
   * merge into the element's (null removes a key), as the board page's transaction does.
   */
  update(id: string, patch: Readonly<Record<string, unknown>>): void {
    const cur = this.get(id) as unknown as Record<string, unknown> | undefined
    if (!cur) return
    const changes: Record<string, unknown> = {}
    const merged: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'customData' && v && typeof v === 'object') {
        const given = (v as { lobby?: Record<string, unknown> }).lobby ?? {}
        const had = ((cur.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ??
          {}) as Record<string, unknown>
        const lobby = { ...had }
        const delta: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(given)) {
          if (value === null) {
            if (key in lobby) {
              delete lobby[key]
              delta[key] = null
            }
          } else if (!same(lobby[key], value)) {
            lobby[key] = value
            delta[key] = value
          }
        }
        if (!Object.keys(delta).length) continue
        changes.customData = { lobby: delta }
        merged.customData = { ...((cur.customData as object | undefined) ?? {}), lobby }
        continue
      }
      if (same(cur[k], v)) continue
      changes[k] = v
      merged[k] = v
    }
    if (!Object.keys(changes).length) return
    if (!this.created.has(id)) this.ops.push({ kind: 'update', id, patch: changes })
    this.set(id, merged)
  }

  /** Moves an element to (x, y) and its bound label with it (Excalidraw keeps a label's own position). */
  move(id: string, x: number, y: number): void {
    const el = this.get(id)
    if (!el) return
    const dx = x - el.x
    const dy = y - el.y
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return
    this.update(id, { x, y })
    const label = this.labelOf(id)
    if (label) this.update(label.id, { x: label.x + dx, y: label.y + dy })
  }

  /** The live bound label of a container, as this draft sees it. */
  labelOf(id: string): CanvasElement | undefined {
    const el = this.get(id) as unknown as { boundElements?: Bound[] | null } | undefined
    for (const b of el?.boundElements ?? []) {
      if (b.type !== 'text') continue
      const label = this.get(b.id)
      if (label && !(label as { isDeleted?: boolean }).isDeleted) return label
    }
    return undefined
  }

  /**
   * Binds an arrow end to `target` (null unbinds), as `LobbyTx.bind` does: the fixed point is where the
   * end is now, relative to the target's box; the target lists the arrow in `boundElements`, and the old
   * target stops listing it.
   */
  bind(arrow: string, end: 'start' | 'end', target: string | null): void {
    const a = this.get(arrow) as unknown as
      | (Record<string, unknown> & { x: number; y: number; points?: readonly Pt[] })
      | undefined
    if (!a) return
    const field = end === 'start' ? 'startBinding' : 'endBinding'
    const other = end === 'start' ? 'endBinding' : 'startBinding'
    const old = (a[field] as { elementId?: string } | null | undefined)?.elementId ?? null
    const stillBound = (a[other] as { elementId?: string } | null | undefined)?.elementId === old
    if (old && old !== target && !stillBound) {
      const o = this.get(old) as unknown as { boundElements?: Bound[] | null } | undefined
      if (o) this.update(old, { boundElements: (o.boundElements ?? []).filter((b) => b.id !== arrow) })
    }
    if (!target) {
      this.update(arrow, { [field]: null })
      return
    }
    const t = this.get(target)
    if (!t || (t as { isDeleted?: boolean }).isDeleted) return
    const pts = a.points ?? []
    const p = (end === 'start' ? pts[0] : pts[pts.length - 1]) ?? [0, 0]
    const binding: Binding = {
      elementId: target,
      fixedPoint: [
        clamp01((a.x + p[0] - t.x) / (t.width || 1)),
        clamp01((a.y + p[1] - t.y) / (t.height || 1)),
      ],
      mode: 'orbit',
    }
    this.update(arrow, { [field]: binding })
    const bound = ((t as unknown as { boundElements?: Bound[] | null }).boundElements ?? []) as Bound[]
    if (!bound.some((b) => b.id === arrow))
      this.update(target, { boundElements: [...bound, { id: arrow, type: 'arrow' }] })
  }

  /** Deletes an element (and, as the board page does, its bound label). */
  delete(id: string): void {
    const el = this.get(id)
    if (!el || (el as { isDeleted?: boolean }).isDeleted) return
    const label = this.labelOf(id)
    if (!this.created.has(id)) this.ops.push({ kind: 'delete', id })
    this.removed.add(id)
    if (label) this.removed.add(label.id)
  }

  /** The creation props of an element this draft made: its final state (see the header). */
  private propsOf(id: string, kind: ItemKind): Record<string, unknown> {
    const rec = this.created.get(id) as Record<string, unknown>
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rec)) if (!NOT_PROPS.has(k)) props[k] = v
    if (kind === 'text') {
      // newTextElement places a text by its alignment point (a centred label by its centre) and measures
      // it itself: give it the point, from the top-left and size the draft laid out
      const w = Number(rec.width) || 0
      const h = Number(rec.height) || 0
      const ax = rec.textAlign === 'center' ? w / 2 : rec.textAlign === 'right' ? w : 0
      const ay = rec.verticalAlign === 'middle' ? h / 2 : rec.verticalAlign === 'bottom' ? h : 0
      props.x = Number(rec.x) + ax
      props.y = Number(rec.y) + ay
      delete props.width
      delete props.height
    }
    return props
  }

  /** Applies every recorded write as one undo step. False when there was nothing to write. */
  commit(label: string, opts?: TransactOptions): boolean {
    if (!this.ops.length) return false
    const ops = this.ops.splice(0)
    const binds: { id: string; start: unknown; end: unknown }[] = []
    this.canvas.transact(
      label,
      (tx) => {
        for (const op of ops) {
          if (op.kind === 'create') {
            if (this.removed.has(op.id)) continue
            tx.create(op.elKind, this.propsOf(op.id, op.elKind))
            const rec = this.created.get(op.id) as Record<string, unknown>
            if (rec.startBinding || rec.endBinding)
              binds.push({ id: op.id, start: rec.startBinding ?? null, end: rec.endBinding ?? null })
          } else if (op.kind === 'update') tx.update(op.id, op.patch)
          else tx.delete(op.id)
        }
      },
      opts,
    )
    if (binds.length) {
      this.canvas.transact(
        label,
        (tx) => {
          for (const b of binds) tx.update(b.id, { startBinding: b.start, endBinding: b.end })
        },
        { joinPrevious: true },
      )
    }
    return true
  }
}
