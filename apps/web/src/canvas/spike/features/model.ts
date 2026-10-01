// The pure rules of O5's spike B features (docs/EXCALIDRAW-MIGRATION.md §8.1 "minimal features"),
// unit-tested in Node: tags (`tag:<key>` element keys and `tagDef:<key>` doc keys, §3.3, §3.4), +1
// (`plusOne:<uid>` = true, identity-bound), vote and comment targets, and the mind-map collapse
// prototype's hidden set (§4.7). No DOM, no engine import.
import { toShapeRef } from '@draftroom/canvas-schema/refs'
import {
  isTagColor,
  normalizeTagName,
  TAG_COLOR_ROTATION,
  type TagColor,
  tagKey,
  tagNameError,
} from '@draftroom/contracts'

export const TAG_KEY_PREFIX = 'tag:'
export const TAG_DEF_KEY_PREFIX = 'tagDef:'
export const PLUS_ONE_KEY_PREFIX = 'plusOne:'

/** The slice of an element these rules read (CanvasElement satisfies it). */
export interface ElementLike {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly containerId?: string | null
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
  readonly customData?: { readonly lobby?: Readonly<Record<string, unknown>> } | null
}

const lobbyOf = (el: ElementLike | null | undefined): Readonly<Record<string, unknown>> =>
  el?.customData?.lobby ?? {}

// ---- tags ------------------------------------------------------------------------------------------------

export interface TagView {
  readonly key: string
  readonly name: string
  readonly color: TagColor
}

/** The tags on an element, in key order (a value that is not a valid tag is ignored). */
export function tagsOf(el: ElementLike | null | undefined): TagView[] {
  const out: TagView[] = []
  for (const [k, v] of Object.entries(lobbyOf(el))) {
    if (!k.startsWith(TAG_KEY_PREFIX)) continue
    const key = k.slice(TAG_KEY_PREFIX.length)
    const val = v as { name?: unknown; color?: unknown } | null
    if (!val || typeof val.name !== 'string' || !isTagColor(val.color) || tagKey(val.name) !== key) continue
    out.push({ key, name: val.name, color: val.color })
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** What tagging writes: the board's tag definition (doc) and the element's key, or why it cannot. */
export type TagWrite =
  | {
      readonly ok: true
      readonly key: string
      readonly docKey: string
      readonly value: { readonly name: string; readonly color: TagColor }
      readonly elementKey: string
    }
  | { readonly ok: false; readonly error: string }

/**
 * Tagging with `input` (a name, `#` allowed): the tag keeps the colour the board already defines for it
 * (`existing`), else takes `color`, else the next colour of the rotation.
 */
export function tagWrite(
  input: string,
  opts: { existing?: (docKey: string) => unknown; color?: TagColor; defined?: number } = {},
): TagWrite {
  const name = normalizeTagName(input)
  const err = tagNameError(name)
  if (err) return { ok: false, error: err }
  const key = tagKey(name)
  const docKey = `${TAG_DEF_KEY_PREFIX}${key}`
  const prior = opts.existing?.(docKey) as { name?: unknown; color?: unknown } | undefined
  const color: TagColor = isTagColor(prior?.color)
    ? prior.color
    : (opts.color ?? TAG_COLOR_ROTATION[(opts.defined ?? 0) % TAG_COLOR_ROTATION.length] ?? 'blue')
  const storedName = typeof prior?.name === 'string' && tagKey(prior.name) === key ? prior.name : name
  return { ok: true, key, docKey, value: { name: storedName, color }, elementKey: `${TAG_KEY_PREFIX}${key}` }
}

/** The chip colour of a tag colour name (Lobby's palette, approximate). */
export const TAG_CHIP_HEX: Readonly<Record<TagColor, string>> = {
  black: '#1d1d1d',
  grey: '#9fa8b2',
  'light-violet': '#e085f4',
  violet: '#ae3ec9',
  blue: '#4465e9',
  'light-blue': '#4ba1f1',
  yellow: '#f1ac4b',
  orange: '#e16919',
  green: '#099268',
  'light-green': '#4cb05e',
  'light-red': '#f87777',
  red: '#e03131',
  white: '#ffffff',
}

// ---- +1 ----------------------------------------------------------------------------------------------------

/** The uids that +1'd an element, in uid order (the order of +1s is not stored, §3.3 decision 3). */
export function plusOnesOf(el: ElementLike | null | undefined): string[] {
  return Object.entries(lobbyOf(el))
    .filter(([k, v]) => k.startsWith(PLUS_ONE_KEY_PREFIX) && v === true)
    .map(([k]) => k.slice(PLUS_ONE_KEY_PREFIX.length))
    .sort()
}

/** Notes (and shapes) take +1s; labels, arrows, lines, strokes and frames do not. */
export const isPlusOneTarget = (el: ElementLike | null | undefined) =>
  !!el &&
  !el.isDeleted &&
  ['stickynote', 'rectangle', 'ellipse', 'diamond', 'image', 'text'].includes(el.type) &&
  !(el.type === 'text' && el.containerId)

/** The `customData.lobby` patch that sets (or clears) `uid`'s +1: `true`, or null to remove the key. */
export function plusOnePatch(
  el: ElementLike,
  uid: string,
  want?: boolean,
): Record<string, true | null> | null {
  const key = `${PLUS_ONE_KEY_PREFIX}${uid}`
  const has = lobbyOf(el)[key] === true
  const next = want ?? !has
  if (next === has) return null
  return { [key]: next ? true : null }
}

// ---- votes and comments -------------------------------------------------------------------------------------

/**
 * What a vote (or a comment pin) on `hit` targets: the element itself, or a bound label's container.
 * Arrows, lines and strokes never take votes (VOTE_INELIGIBLE_TYPES).
 */
export function voteTargetOf(
  hit: ElementLike | null | undefined,
  get: (id: string) => ElementLike | undefined,
): ElementLike | null {
  if (!hit || hit.isDeleted) return null
  const target = hit.type === 'text' && hit.containerId ? (get(hit.containerId) ?? null) : hit
  if (!target || target.isDeleted) return null
  if (['arrow', 'line', 'freedraw'].includes(target.type)) return null
  return target
}

/** The api's vote object ref for an element (`shape:<id>`, canvas-schema refs.ts), or null. */
export function voteRefOf(el: ElementLike | null): string | null {
  if (!el) return null
  try {
    const ref = toShapeRef(el.id)
    // the vote contract's id pattern is narrower than the element id pattern (no `.` or `:`)
    return /^shape:[A-Za-z0-9_-]{1,100}$/.test(ref) ? ref : null
  } catch {
    return null
  }
}

/** A comment pin's anchor: on an element (u, v in its box), or at a board point. */
export function commentAnchorFor(
  point: { x: number; y: number },
  target: ElementLike | null,
): { kind: 'shape'; shapeId: string; u: number; v: number } | { kind: 'point'; x: number; y: number } {
  if (
    target &&
    typeof target.x === 'number' &&
    typeof target.y === 'number' &&
    target.width &&
    target.height
  ) {
    const clamp = (n: number) => Math.min(1, Math.max(0, n))
    let ref: string | null = null
    try {
      ref = toShapeRef(target.id)
    } catch {
      ref = null
    }
    if (ref)
      return {
        kind: 'shape',
        shapeId: ref,
        u: clamp((point.x - target.x) / target.width),
        v: clamp((point.y - target.y) / target.height),
      }
  }
  return { kind: 'point', x: Math.round(point.x), y: Math.round(point.y) }
}

// ---- mind-map collapse prototype (§4.7) --------------------------------------------------------------------

export interface MindmapValue {
  readonly rootId: string
  readonly parentId: string | null
  readonly side: string
  readonly collapsed: boolean
}
export interface MindmapEdgeValue {
  readonly rootId: string
  readonly parentId: string
  readonly childId: string
}

export const mindmapOf = (el: ElementLike | null | undefined): MindmapValue | null => {
  const v = lobbyOf(el).mindmap as MindmapValue | undefined
  return v && typeof v.rootId === 'string' && typeof v.collapsed === 'boolean' ? v : null
}
export const mindmapEdgeOf = (el: ElementLike | null | undefined): MindmapEdgeValue | null => {
  const v = lobbyOf(el).mindmapEdge as MindmapEdgeValue | undefined
  return v && typeof v.parentId === 'string' && typeof v.childId === 'string' ? v : null
}

/**
 * The hidden set of the collapse prototype: every descendant topic of a collapsed topic (the collapsed
 * topic itself stays visible), and every edge into a hidden topic. Only `collapsed` is stored (on the
 * parent's `mindmap` value, §4.7); the set is recomputed from the scene by everyone. Labels and frame
 * children are added by overrides.ts `expandHidden`.
 */
export function mindmapHidden(elements: Iterable<ElementLike>): Set<string> {
  const children = new Map<string, string[]>()
  const collapsed: string[] = []
  const edges: { id: string; parentId: string; childId: string }[] = []
  for (const el of elements) {
    if (el.isDeleted) continue
    const m = mindmapOf(el)
    if (m) {
      if (m.parentId) children.set(m.parentId, [...(children.get(m.parentId) ?? []), el.id])
      if (m.collapsed) collapsed.push(el.id)
    }
    const e = mindmapEdgeOf(el)
    if (e) edges.push({ id: el.id, parentId: e.parentId, childId: e.childId })
  }
  const hidden = new Set<string>()
  const stack = collapsed.flatMap((id) => children.get(id) ?? [])
  while (stack.length) {
    const id = stack.pop() as string
    if (hidden.has(id)) continue
    hidden.add(id)
    stack.push(...(children.get(id) ?? []))
  }
  for (const e of edges) if (hidden.has(e.childId)) hidden.add(e.id)
  return hidden
}

/** The `mindmap` patch that collapses or expands a topic (only `collapsed` changes). */
export function collapsePatch(el: ElementLike, collapsed: boolean): { mindmap: MindmapValue } | null {
  const m = mindmapOf(el)
  if (!m || m.collapsed === collapsed) return null
  return { mindmap: { ...m, collapsed } }
}

/** Whether a topic has children (only those get a collapse chevron). */
export function hasChildren(elements: Iterable<ElementLike>, topicId: string): boolean {
  for (const el of elements) if (!el.isDeleted && mindmapOf(el)?.parentId === topicId) return true
  return false
}
