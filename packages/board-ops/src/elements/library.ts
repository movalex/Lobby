/**
 * Wave Q (the element library; landed by the wave Q foundation, OWNER: WS2 after it; docs/WAVE-Q-CONTRACTS.md §5): a
 * selection of a board as a library item's elements. The web runs it before "Save to library" (the payload it sends,
 * @draftroom/contracts CreateLibraryItemInput.elements), and the api runs it again on what it receives (with its own
 * file checks on top: every collected version must be servable on the source board, and `customData.lobby.file` is
 * rewritten from the version row), so both sides agree on what an item may hold.
 *
 * What it does, in order (pure: no engine, no I/O; input elements are never mutated):
 *  1. takes the live selected elements, plus, when the scene is given, the bound labels of selected containers and
 *     the children of selected frames (what a copy of the selection takes along);
 *  2. refuses what no board may hold or a library must not carry: refused types (selection, magicframe, iframe,
 *     embeddable), unknown types, and any `data:` or `blob:` URL in `link`, `fileId` or anywhere in `customData`;
 *  3. makes each element portable (`portableElement`: no `customData.lobbyServer`, no identity-bound or
 *     identity-stamped keys, no local-only `status`), drops board-bound keys (`tag:*` needs the board's tag
 *     definitions; `present.index` is the board's slide order) and unlocks it (the insert decides locking);
 *  4. re-keys it to item-local ids (`remapElements`: fresh element and group ids, references leaving the set cut,
 *     indices from the start), moved so the item's box starts at (0, 0);
 *  5. checks the result as the room would: canvas-schema `checkElement` per element and `checkInvariants` across
 *     them, then the item's limits (elements, UTF-8 bytes of the element JSON, images).
 * It answers the elements, the file versions they show (image `fileId`s and file cards' `customData.lobby.file`),
 * the item's box, counts and a suggested name (the first words in reading order, else the first frame's name).
 * Problems are codes and counts, never content.
 */
import { lobbyKeySpec, TAG_KEY_PREFIX } from '@draftroom/canvas-schema/custom-data'
import {
  checkElement,
  isElementType,
  REFUSED_ELEMENT_TYPES,
  type WireElement,
} from '@draftroom/canvas-schema/elements'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { jsonByteLength } from '@draftroom/canvas-schema/limits'
import { portableElement } from './archive.ts'
import { type ElementFileRef, elementFileRefs } from './files.ts'
import type { IdSource } from './ids.ts'
import { asElements, type BoardElement, compareByIndex, isLabel, isLive } from './read.ts'
import { remapElements } from './remap.ts'

/** The caps an item is held to (the callers pass @draftroom/contracts LIBRARY_LIMITS; board-ops does not import it). */
export interface LibraryItemLimits {
  readonly maxElements: number
  readonly maxBytes: number
  readonly maxImages: number
  /** the suggested name's length */
  readonly maxNameChars: number
}

export type LibraryItemProblem =
  /** nothing live was selected */
  | 'empty'
  /** a selection, magicframe, iframe or embeddable element */
  | 'refused-type'
  /** a type the canvas does not store */
  | 'unknown-type'
  /** a data: or blob: URL in a link, a fileId or customData */
  | 'inline-data'
  /** an element the room would refuse (schema, references) */
  | 'invalid'
  | 'too-many-elements'
  | 'too-large'
  | 'too-many-images'

export interface LibraryItemPayload {
  /** item-local ids, paint order, the box's top-left at (0, 0); each passes `checkElement` */
  readonly elements: WireElement[]
  /** the versions the elements show (sorted by version id; assetId null for a converted image without one) */
  readonly files: ElementFileRef[]
  readonly width: number
  readonly height: number
  readonly elementCount: number
  readonly imageCount: number
  /** UTF-8 bytes of `JSON.stringify(elements)` */
  readonly bytes: number
  /** the first words in reading order, else the first frame's name; null when there are none */
  readonly suggestedName: string | null
  /** what step 3 and 4 removed or cut, by kind (counts only) */
  readonly cut: {
    readonly labels: number
    readonly bindings: number
    readonly frames: number
    readonly bound: number
    readonly customData: number
  }
}

export type LibraryItemResult =
  | { ok: true; item: LibraryItemPayload }
  | { ok: false; problem: LibraryItemProblem; count: number }

export interface SerializeLibraryItemOptions {
  /** the board's elements: selected containers bring their labels, selected frames their children */
  readonly scene?: Iterable<unknown>
  readonly limits: LibraryItemLimits
  /** where new ids come from (tests) */
  readonly newId?: IdSource
  /** `updated` of the item's elements (default: now) */
  readonly now?: number
}

type El = Record<string, unknown>
const isObj = (v: unknown): v is El => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** A URL scheme the library never stores (inline or page-local content). */
const INLINE_URL = /^\s*(?:data|blob):/i

/** Whether any string inside `value` (any depth) is a data: or blob: URL. */
function holdsInlineUrl(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return INLINE_URL.test(value)
  if (depth > 8 || typeof value !== 'object' || value === null) return false
  for (const v of Object.values(value)) if (holdsInlineUrl(v, depth + 1)) return true
  return false
}

/** The live selection, with what a copy of it takes along when the scene is known. */
function gather(selected: Iterable<unknown>, scene: Iterable<unknown> | undefined): BoardElement[] {
  const picked = new Map<string, BoardElement>()
  for (const el of asElements(selected)) if (isLive(el) && !picked.has(el.id)) picked.set(el.id, el)
  if (!scene) return [...picked.values()]
  const all = asElements(scene).filter(isLive)
  const frames = new Set([...picked.values()].filter((e) => e.type === 'frame').map((e) => e.id))
  // frame children first (a child's label then comes with the child below)
  for (const el of all)
    if (typeof el.frameId === 'string' && frames.has(el.frameId) && !picked.has(el.id)) picked.set(el.id, el)
  for (const el of all)
    if (isLabel(el) && picked.has(el.containerId as string) && !picked.has(el.id)) picked.set(el.id, el)
  return [...picked.values()]
}

/** An element's axis-aligned box in scene space (linear elements by their points; rotation about the box centre). */
export function itemBoxOf(el: BoardElement): { x: number; y: number; w: number; h: number } {
  let x = finite(el.x)
  let y = finite(el.y)
  let w = Math.max(0, finite(el.width))
  let h = Math.max(0, finite(el.height))
  const points = (el as unknown as { points?: unknown }).points
  if (Array.isArray(points) && points.length) {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const p of points) {
      if (!Array.isArray(p)) continue
      const px = finite(p[0])
      const py = finite(p[1])
      minX = Math.min(minX, px)
      minY = Math.min(minY, py)
      maxX = Math.max(maxX, px)
      maxY = Math.max(maxY, py)
    }
    if (Number.isFinite(minX)) {
      x += minX
      y += minY
      w = maxX - minX
      h = maxY - minY
    }
  }
  const angle = finite(el.angle)
  if (!angle) return { x, y, w, h }
  const cx = x + w / 2
  const cy = y + h / 2
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const bw = w * cos + h * sin
  const bh = w * sin + h * cos
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh }
}

/** The union box of elements, or null for none. */
export function itemBoundsOf(
  elements: Iterable<BoardElement>,
): { x: number; y: number; w: number; h: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const el of elements) {
    const b = itemBoxOf(el)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null
}

/** Step 3's extra rules on top of `portableElement`: no board-bound keys, unlocked. Returns how many keys it dropped. */
function forLibrary(el: El): number {
  el.locked = false
  const cd = isObj(el.customData) ? el.customData : null
  const lobby = cd && isObj(cd.lobby) ? cd.lobby : null
  if (!cd || !lobby) return 0
  let dropped = 0
  for (const key of Object.keys(lobby)) {
    if (key.startsWith(TAG_KEY_PREFIX) || !lobbyKeySpec(key)) {
      delete lobby[key]
      dropped++
    }
  }
  if (!Object.keys(lobby).length) delete cd.lobby
  if (!Object.keys(cd).length) delete el.customData
  return dropped
}

function suggestedNameOf(elements: readonly WireElement[], maxChars: number): string | null {
  const els = elements as unknown as El[]
  const texts = els
    .filter((e) => e.type === 'text' && typeof e.originalText === 'string' && e.originalText.trim())
    .sort((a, b) => finite(a.y) - finite(b.y) || finite(a.x) - finite(b.x))
  const words = (texts[0]?.originalText as string | undefined)?.trim().split('\n')[0]?.trim()
  const frame = els.find((e) => e.type === 'frame' && typeof e.name === 'string' && e.name.trim())
  const name = words || (frame?.name as string | undefined)?.trim() || ''
  if (!name) return null
  const chars = [...name]
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('')}…` : name
}

/**
 * The library item a selection makes, or the first problem found. See the module comment for the steps.
 */
export function serializeLibraryItem(
  selected: Iterable<unknown>,
  opts: SerializeLibraryItemOptions,
): LibraryItemResult {
  const source = gather(selected, opts.scene).sort(compareByIndex)
  if (!source.length) return { ok: false, problem: 'empty', count: 0 }
  // 2. types and inline URLs
  let refused = 0
  let unknown = 0
  let inline = 0
  for (const el of source) {
    const raw = el as unknown as El
    if ((REFUSED_ELEMENT_TYPES as readonly string[]).includes(el.type)) refused++
    else if (!isElementType(el.type)) unknown++
    if (holdsInlineUrl(raw.link) || holdsInlineUrl(raw.fileId) || holdsInlineUrl(raw.customData)) inline++
  }
  if (refused) return { ok: false, problem: 'refused-type', count: refused }
  if (unknown) return { ok: false, problem: 'unknown-type', count: unknown }
  if (inline) return { ok: false, problem: 'inline-data', count: inline }
  // 3. portable, no board-bound keys, unlocked
  let dropped = 0
  const portable = source.map((el) => {
    // the identity-bound and identity-stamped keys portableElement removes (counted, as remapElements counts its own)
    const lobby = (el as unknown as { customData?: { lobby?: unknown } }).customData?.lobby
    if (isObj(lobby))
      for (const key of Object.keys(lobby)) if (lobbyKeySpec(key)?.duplicate === 'strip') dropped++
    const c = portableElement(el)
    dropped += forLibrary(c)
    return c
  })
  // 4. item-local ids, the box at (0, 0)
  const box = itemBoundsOf(portable as unknown as BoardElement[]) ?? { x: 0, y: 0, w: 0, h: 0 }
  const remapped = remapElements(portable, {
    offset: { x: -box.x, y: -box.y },
    indexAbove: null,
    ...(opts.newId ? { newId: opts.newId } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  // 5. what the room would take, then the item's limits
  const elements: WireElement[] = []
  let invalid = 0
  for (const el of remapped.elements) {
    const check = checkElement(el)
    if (check.ok) elements.push(check.element)
    else invalid++
  }
  if (invalid) return { ok: false, problem: 'invalid', count: invalid }
  const violations = checkInvariants(elements)
  if (violations.length) return { ok: false, problem: 'invalid', count: violations.length }
  const { limits } = opts
  if (elements.length > limits.maxElements)
    return { ok: false, problem: 'too-many-elements', count: elements.length }
  const bytes = jsonByteLength(elements)
  if (bytes > limits.maxBytes) return { ok: false, problem: 'too-large', count: bytes }
  const imageCount = elements.filter((e) => e.type === 'image').length
  if (imageCount > limits.maxImages) return { ok: false, problem: 'too-many-images', count: imageCount }
  const { cut } = remapped
  return {
    ok: true,
    item: {
      elements,
      files: elementFileRefs(elements),
      width: Math.round(box.w * 100) / 100,
      height: Math.round(box.h * 100) / 100,
      elementCount: elements.length,
      imageCount,
      bytes,
      suggestedName: suggestedNameOf(elements, limits.maxNameChars),
      cut: { ...cut, customData: cut.customData + dropped },
    },
  }
}
