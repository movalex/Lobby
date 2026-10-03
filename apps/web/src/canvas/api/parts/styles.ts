/**
 * OWNER: 3a (canvas tools). The style panel's reads and writes: the shared style of a selection
 * (`mixed` per field) and applying a patch as one undo step. `styles.next`/`setNext` (the engine's
 * current-item state) stay 2C's in ../impl.ts.
 *
 * Values are the engine's field names (canvas-schema groups.ts `style` and `textStyle`); the Lobby
 * palette and size names are the canvas-ux feature's mapping (features/canvas-ux/ported/style-vocabulary.ts).
 *
 * Which field applies to which element (`FIELDS`): a field is read from and written to only the elements
 * it means something on (a `fillStyle` never lands on an arrow, an arrowhead never on a note). Two rules
 * follow Excalidraw's own style actions:
 *  - a container's TEXT fields (font family, font size, alignment) live on its bound label: `of` reads
 *    them there and `apply` writes them there;
 *  - a sticky note and its label have one ink (Excalidraw's `syncStickyNoteInk`), and a label fades with
 *    its container: `strokeColor` on a note and `opacity` on any container also go to the label.
 *
 * A text change moves words: the label (or the free text) is laid out again the way Excalidraw's own font
 * actions lay it out (`redrawTextBoundingBox`; a sticky note re-runs its fit, `relayoutStickyNotes`, and a
 * font size on a note's label is its `baseFontSize`, the ceiling the fit shrinks from), on copies of the
 * elements, so the style and the new layout are ONE `transact` (one undo step, pushed by the sync engine).
 * A label another session holds the lease on is skipped (its layout is theirs while they type, §2.9.4).
 * Browser only for text fields (Excalidraw's measurement needs a canvas); the other fields are plain writes.
 *
 * The next style (`setNext`) follows every pick, with one exception (CR-3A-7): a font size is the next size of
 * the KIND it was picked on, a note's label size or a free text's (the board page's port keeps the two apart,
 * canvas/port-impl.ts `setNextFontSize`), not both: a text picked at 44 does not make the next note's label 44.
 */
import {
  getBaseFontSizeUpdate,
  mutateElement,
  redrawTextBoundingBox,
  relayoutStickyNotes,
} from '@excalidraw/element'
import type { ElementsMap, ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/element/types'
import type { CanvasElement } from '../../port.ts'
import type { LobbyStyles, MixedStyles, StyleValues } from '../lobby-canvas.ts'
import { NotImplementedError } from '../owners.ts'
import type { PartDeps } from './types.ts'

export type StylesPart = Pick<LobbyStyles, 'of' | 'apply'>

/** CR-3A-7: the board page's port member for the next font sizes (a bare port, in a unit test, has none). */
type SizePort = { setNextFontSize?(slot: 'note' | 'text', size: number): void }

type Field = keyof StyleValues

const SHAPES = ['rectangle', 'ellipse', 'diamond'] as const
const LINEAR = ['arrow', 'line'] as const

/** The element types each (non-text) field applies to. */
export const FIELDS: Readonly<Record<Exclude<Field, TextField>, readonly string[]>> = {
  strokeColor: [...SHAPES, 'stickynote', 'text', ...LINEAR, 'freedraw', 'frame'],
  backgroundColor: [...SHAPES, 'stickynote', 'line', 'freedraw'],
  fillStyle: [...SHAPES, 'line', 'freedraw'],
  strokeWidth: [...SHAPES, ...LINEAR, 'freedraw'],
  strokeStyle: [...SHAPES, ...LINEAR],
  roughness: [...SHAPES, ...LINEAR, 'freedraw'],
  opacity: [...SHAPES, 'stickynote', 'text', ...LINEAR, 'freedraw', 'image', 'frame'],
  startArrowhead: ['arrow'],
  endArrowhead: ['arrow'],
  roundness: ['rectangle', 'diamond', ...LINEAR],
  // an existing arrow is never switched to or from elbow here: Excalidraw re-routes it when it changes
  // (actionChangeArrowType), which is not a style write. `elbowed` is a next-style value only.
  elbowed: [],
  // the next connector's kind (CR-W5-3A-1): a next-style value only, like `elbowed`
  arrowKind: [],
  // the next note's fill (CR-3A-7): a next-style value only (a note's own fill is `backgroundColor`)
  noteColor: [],
}

export const TEXT_FIELDS = ['fontFamily', 'fontSize', 'textAlign', 'verticalAlign'] as const
type TextField = (typeof TEXT_FIELDS)[number]
const isTextField = (f: string): f is TextField => (TEXT_FIELDS as readonly string[]).includes(f)

/** Containers whose label carries the text fields. */
const TEXT_CONTAINERS = new Set([...SHAPES, 'stickynote', 'arrow'])

type Loose = CanvasElement & Record<string, unknown>

const labelIdOf = (el: CanvasElement): string | null => {
  const bound = (el as { boundElements?: readonly { id: string; type: string }[] | null }).boundElements
  return bound?.find((b) => b.type === 'text')?.id ?? null
}
const isLabel = (el: CanvasElement) => el.type === 'text' && !!el.containerId

/** A field's value as the style vocabulary reads it (`roundness` is 'round' or 'sharp'). */
function readField(el: Loose, f: Field): unknown {
  if (f === 'roundness') return el.roundness ? 'round' : 'sharp'
  if (f === 'fontSize') return (el.baseFontSize as number | null | undefined) ?? el.fontSize
  return el[f]
}

/** The engine value to write for a vocabulary value. */
function writeValue(el: CanvasElement, f: Field, v: unknown): unknown {
  if (f === 'roundness') {
    if (v !== 'round') return null
    // Excalidraw's own kinds: adaptive radius for rectangles, proportional for diamonds and linear ones
    return { type: el.type === 'rectangle' ? 3 : 2 }
  }
  return v
}

const sameValue = (a: unknown, b: unknown) =>
  a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b))

/**
 * The shared styles of `els` (bound labels excluded from the list: a container brings its own label's
 * text fields). Pure: `get` resolves labels.
 */
export function stylesOf(els: readonly CanvasElement[], get: (id: string) => CanvasElement | undefined) {
  const out: Record<string, unknown> = {}
  const seen = (f: Field, v: unknown) => {
    if (v === undefined) return
    if (!(f in out)) out[f] = v
    else if (out[f] !== 'mixed' && !sameValue(out[f], v)) out[f] = 'mixed'
  }
  for (const raw of els) {
    if (isLabel(raw) || (raw as { isDeleted?: boolean }).isDeleted) continue
    const el = raw as Loose
    for (const [f, types] of Object.entries(FIELDS) as [Field, readonly string[]][]) {
      if (types.includes(el.type)) seen(f, readField(el, f))
    }
    const text =
      el.type === 'text'
        ? el
        : TEXT_CONTAINERS.has(el.type)
          ? (() => {
              const id = labelIdOf(el)
              return id ? (get(id) as Loose | undefined) : undefined
            })()
          : undefined
    if (text && !(text as { isDeleted?: boolean }).isDeleted) {
      for (const f of TEXT_FIELDS) {
        // a free text has no vertical alignment of its own
        if (f === 'verticalAlign' && text === el) continue
        seen(f, readField(text as Loose, f))
      }
    }
  }
  return out as MixedStyles
}

/** One element's writes for `patch` (text fields excluded), with its label's where the rules say so. */
function plainWrites(
  el: CanvasElement,
  patch: StyleValues,
  get: (id: string) => CanvasElement | undefined,
  add: (id: string, fields: Record<string, unknown>) => void,
) {
  const fields: Record<string, unknown> = {}
  for (const [f, v] of Object.entries(patch) as [Field, unknown][]) {
    if (v === undefined || isTextField(f)) continue
    const types = FIELDS[f as Exclude<Field, TextField>]
    if (!types?.includes(el.type)) continue
    const value = writeValue(el, f, v)
    if (!sameValue((el as Loose)[f], value)) fields[f] = value
  }
  if (Object.keys(fields).length) add(el.id, fields)
  const labelId = labelIdOf(el)
  const label = labelId ? get(labelId) : undefined
  if (!label || (label as { isDeleted?: boolean }).isDeleted) return
  const lf: Record<string, unknown> = {}
  if (patch.opacity !== undefined && (label as Loose).opacity !== patch.opacity) lf.opacity = patch.opacity
  if (
    el.type === 'stickynote' &&
    patch.strokeColor !== undefined &&
    (label as Loose).strokeColor !== patch.strokeColor
  )
    lf.strokeColor = patch.strokeColor
  if (Object.keys(lf).length) add(label.id, lf)
}

// biome-ignore lint/suspicious/noExplicitAny: plain copies of engine elements
type Copy = any

/**
 * The text fields of `patch` on `textIds` (free texts and labels), laid out again: id → changed fields
 * (labels, their containers, free texts). Runs on copies of `all`.
 */
export function textWrites(
  all: readonly CanvasElement[],
  textIds: readonly string[],
  patch: StyleValues,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const map = new Map<string, Copy>(all.map((e) => [e.id, structuredClone(e)]))
  const before = new Map<string, Copy>()
  const touch = (id: string) => {
    if (!before.has(id)) before.set(id, structuredClone(map.get(id)))
  }
  const scene = {
    mutateElement: (el: Copy, u: Copy, o?: Copy) => mutateElement(el, map as unknown as ElementsMap, u, o),
    getNonDeletedElementsMap: () => map,
    getElementsMapIncludingDeleted: () => map,
    getNonDeletedElements: () => [...map.values()].filter((e) => !e.isDeleted),
    getElement: (id: string) => map.get(id) ?? null,
    getContainerElement: (t: Copy) => (t?.containerId ? (map.get(t.containerId) ?? null) : null),
    triggerUpdate: () => {},
  }
  const notes = new Set<string>()
  for (const id of textIds) {
    const t = map.get(id) as Copy
    if (t?.type !== 'text' || t.isDeleted) continue
    const container = t.containerId ? (map.get(t.containerId) ?? null) : null
    touch(id)
    if (container) touch(container.id)
    const prev = structuredClone(t)
    const upd: Record<string, unknown> = {}
    if (patch.fontFamily !== undefined) upd.fontFamily = patch.fontFamily
    if (patch.textAlign !== undefined) upd.textAlign = patch.textAlign
    if (patch.verticalAlign !== undefined && container) upd.verticalAlign = patch.verticalAlign
    if (patch.fontSize !== undefined)
      Object.assign(
        upd,
        getBaseFontSizeUpdate(t as ExcalidrawTextElement, patch.fontSize, map as unknown as ElementsMap),
      )
    if (!Object.keys(upd).length) continue
    mutateElement(t, map as unknown as ElementsMap, upd)
    if (container?.type === 'stickynote') {
      notes.add(container.id)
      continue
    }
    redrawTextBoundingBox(t as ExcalidrawTextElement, container as ExcalidrawElement | null, scene as never)
    // a free text keeps its anchor as Excalidraw's font actions do (offsetElementAfterFontResize)
    if (!container && t.autoResize) {
      mutateElement(t, map as unknown as ElementsMap, {
        x:
          prev.textAlign === 'left'
            ? prev.x
            : prev.x + (prev.width - t.width) / (prev.textAlign === 'center' ? 2 : 1),
        y: prev.y + (prev.height - t.height) / 2,
      })
    }
  }
  if (notes.size) {
    const relaid = relayoutStickyNotes([...map.values()] as ExcalidrawElement[], notes)
    for (const e of relaid) {
      if (map.get(e.id) === e) continue
      touch(e.id)
      map.set(e.id, e)
    }
  }
  for (const [id, prev] of before) {
    const next = map.get(id)
    if (!next || !prev) continue
    const changed: Record<string, unknown> = {}
    for (const k of Object.keys(next)) {
      if (k === 'version' || k === 'versionNonce' || k === 'updated' || k === 'seed') continue
      if (!sameValue(prev[k], next[k])) changed[k] = next[k]
    }
    if (Object.keys(changed).length) out.set(id, changed)
  }
  return out
}

export function createStylesPart(deps: PartDeps): StylesPart {
  const canvas = () => deps.self()
  /** A board-page member on a canvas without the board page (unit tests): its fallback. */
  const orElse = <T>(read: () => T, fallback: T): T => {
    try {
      return read()
    } catch (e) {
      if (e instanceof NotImplementedError) return fallback
      throw e
    }
  }
  const setNext = (patch: StyleValues) => orElse(() => canvas().styles.setNext(patch), undefined)
  /**
   * A pick sets the next style too (tldraw's setStyleForSelectedShapes). CR-3A-7: its font size goes to the
   * next size of the kinds of text it was picked on (a free text's, a note's or other container's label),
   * which the port keeps apart; with no text on the targets, or a port with one size, the engine's own.
   */
  const setNextStyle = (patch: StyleValues, targets: readonly CanvasElement[]) => {
    const port = deps.port as SizePort
    if (patch.fontSize === undefined || typeof port.setNextFontSize !== 'function') return setNext(patch)
    const slots = new Set<'note' | 'text'>()
    for (const e of targets) {
      if (e.type === 'text') slots.add('text')
      else if (TEXT_CONTAINERS.has(e.type)) slots.add('note')
    }
    if (!slots.size) return setNext(patch)
    const { fontSize, ...rest } = patch
    if (Object.keys(rest).length) setNext(rest)
    for (const slot of slots) port.setNextFontSize(slot, fontSize)
  }
  const of = (ids?: readonly string[]): MixedStyles => {
    const c = canvas()
    const list = (ids ?? c.selection).map((id) => c.get(id)).filter((e): e is CanvasElement => !!e)
    return stylesOf(list, (id) => c.get(id))
  }
  const apply = (patch: StyleValues, ids?: readonly string[]): void => {
    const c = canvas()
    const targets = (ids ?? c.selection)
      .map((id) => c.get(id))
      .filter((e): e is CanvasElement => !!e && !(e as { isDeleted?: boolean }).isDeleted)
      .map((e) => (isLabel(e) ? (c.get(e.containerId as string) ?? e) : e))
    setNextStyle(patch, targets)
    if (orElse(() => c.readOnly(), false)) return
    if (!targets.length) return
    const writes = new Map<string, Record<string, unknown>>()
    const add = (id: string, fields: Record<string, unknown>) =>
      writes.set(id, { ...(writes.get(id) ?? {}), ...fields })
    const get = (id: string) => c.get(id)
    for (const el of new Map(targets.map((e) => [e.id, e])).values()) plainWrites(el, patch, get, add)
    if (TEXT_FIELDS.some((f) => patch[f] !== undefined)) {
      const me = c.editingId()
      const textIds: string[] = []
      for (const el of targets) {
        const textId = el.type === 'text' ? el.id : TEXT_CONTAINERS.has(el.type) ? labelIdOf(el) : null
        if (!textId) continue
        // the lease: someone else typing in it owns its layout (§2.9.4)
        const holder = c.leaseHolder(el.id)
        if (holder && me !== el.id && holder.sid !== c.engine?.welcome?.sid) continue
        textIds.push(textId)
      }
      if (textIds.length) {
        for (const [id, fields] of textWrites(c.items(), textIds, patch)) add(id, fields)
      }
    }
    if (!writes.size) return
    c.transact('style', (tx) => {
      for (const [id, fields] of writes) tx.update(id, fields)
    })
  }
  return { of, apply }
}
