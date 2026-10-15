// OWNER: WS4 (wave Q, kits and import; docs/WAVE-Q-CONTRACTS.md §6). The pure half of the `.excalidrawlib` import:
// what is done to the elements of one library item, after the engine's own parser has read and restored the file
// (./excalidrawlib.ts, the only reader), and before the api sees them. No engine import here, so Node tests run it
// with plain objects.
//
// A community library is somebody else's content, so each item is cleaned before it is held to the same rules as a
// saved selection (board-ops serializeLibraryItem: refused types, inline URLs, checkElement per element,
// checkInvariants across them, the item's limits):
//  - `image` elements are left out: a library file carries no picture bytes (the engine keeps those in a separate
//    `files` map that `.excalidrawlib` has no place for), and an image element needs a Lobby file version, which only
//    a real upload makes. An item that was only pictures is skipped. Nothing is uploaded or fetched here;
//  - `embeddable`, `iframe`, `magicframe`, `selection` and any type Lobby does not store are left out;
//  - `link` is kept only when canvas-schema's isAllowedLink accepts it (http(s), mailto, Lobby-relative; never
//    `data:`, `blob:` or `javascript:`); otherwise it is cleared;
//  - `customData` is dropped whole: it is foreign (a plugin's data, or keys that would pass for Lobby's own);
//  - fonts are mapped to the families Lobby serves (Virgil 1 -> Excalifont 5, Helvetica 2 -> Nunito 6, Cascadia 3 ->
//    Comic Shanns 8; any other unknown family -> Nunito), and a bound label is laid out again with the engine's own
//    text layout (the container grows when the new face needs more room);
//  - an element canvas-schema's checkElement refuses is left out, and the references to it are cut when the item is
//    re-keyed, so one odd element costs one element, not the item.
// Problems are counts and codes, never content.
import {
  type LibraryItemLimits,
  type LibraryItemProblem,
  serializeLibraryItem,
} from '@draftroom/board-ops/elements'
import { checkElement, isElementType, type WireElement } from '@draftroom/canvas-schema/elements'
import { type EngineElement, layoutBoundText, type TextElement } from '@draftroom/canvas-schema/engine'
import { isAllowedLink, isLobbyFontFamily } from '@draftroom/canvas-schema/limits'
import { LIBRARY_LIMITS } from '@draftroom/contracts'

type El = Record<string, unknown>
const isObj = (v: unknown): v is El => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Excalidraw's older faces, as the families Lobby serves (limits.ts LOBBY_FONT_FAMILIES). */
export const FONT_MAP: Readonly<Record<number, 5 | 6 | 7 | 8>> = Object.freeze({
  1: 5, // Virgil -> Excalifont
  2: 6, // Helvetica -> Nunito
  3: 8, // Cascadia -> Comic Shanns
})
/** A family Lobby does not serve and FONT_MAP does not name (Assistant, Liberation Sans, ...) reads as Nunito. */
export const FALLBACK_FONT = 6

/** The caps an imported item is held to: the same as a saved item (@draftroom/contracts LIBRARY_LIMITS). */
export const IMPORT_ITEM_LIMITS: LibraryItemLimits = {
  maxElements: LIBRARY_LIMITS.itemElements,
  maxBytes: LIBRARY_LIMITS.itemBytes,
  maxImages: LIBRARY_LIMITS.itemImages,
  maxNameChars: LIBRARY_LIMITS.nameChars,
}

/** What was left out or changed in one item, as counts. */
export interface ItemCuts {
  /** `image` elements (their versions are never imported) */
  images: number
  /** embeddable, iframe, magicframe, selection */
  embeds: number
  /** a type Lobby does not store */
  unknown: number
  /** a link cleared because it is not an allowed link */
  links: number
  /** elements whose customData was dropped */
  customData: number
  /** texts whose font family was mapped */
  fonts: number
  /** bound labels laid out again */
  relaid: number
  /** elements checkElement refused */
  invalid: number
  /** elements the file marked deleted */
  deleted: number
}

export const noCuts = (): ItemCuts => ({
  images: 0,
  embeds: 0,
  unknown: 0,
  links: 0,
  customData: 0,
  fonts: 0,
  relaid: 0,
  invalid: 0,
  deleted: 0,
})

const EMBED_TYPES = new Set(['embeddable', 'iframe', 'magicframe', 'selection'])
/** Containers whose label the text layout fits (a sticky note and an arrow have their own rules). */
const FITTED_CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond'])

/**
 * One item's elements, cleaned (see the module comment). `elements` are what the engine's restore returned (or any
 * JSON-shaped elements); they are never changed. Fresh `updated` and `created: null` are set where the file had none,
 * as the room expects every field present.
 */
export function cleanLibraryElements(
  elements: readonly unknown[],
  now: number = Date.now(),
): { elements: El[]; cuts: ItemCuts } {
  const cuts = noCuts()
  const kept: El[] = []
  for (const raw of elements) {
    if (!isObj(raw)) {
      cuts.unknown++
      continue
    }
    if (raw.isDeleted === true) {
      cuts.deleted++
      continue
    }
    if (raw.type === 'image') {
      cuts.images++
      continue
    }
    if (EMBED_TYPES.has(String(raw.type))) {
      cuts.embeds++
      continue
    }
    if (!isElementType(raw.type)) {
      cuts.unknown++
      continue
    }
    const el = structuredClone(raw)
    if (typeof el.link === 'string' && !isAllowedLink(el.link)) {
      el.link = null
      cuts.links++
    }
    el.link ??= null
    if (el.customData !== undefined) {
      delete el.customData
      cuts.customData++
    }
    if (el.type === 'text' && !isLobbyFontFamily(el.fontFamily)) {
      el.fontFamily = FONT_MAP[el.fontFamily as number] ?? FALLBACK_FONT
      cuts.fonts++
    }
    el.created = null
    if (typeof el.updated !== 'number') el.updated = now
    el.locked = false
    kept.push(el)
  }
  relayLabels(kept, cuts)
  const ok: El[] = []
  for (const el of kept) {
    if (checkElement(el).ok) ok.push(el)
    else cuts.invalid++
  }
  return { elements: ok, cuts }
}

/** Lays each bound label out again with the engine's text layout, in the face it now has. */
function relayLabels(elements: El[], cuts: ItemCuts): void {
  const byId = new Map(elements.map((e) => [e.id as string, e]))
  for (const el of elements) {
    if (el.type !== 'text' || typeof el.containerId !== 'string') continue
    const container = byId.get(el.containerId)
    if (!container || !FITTED_CONTAINERS.has(String(container.type))) continue
    try {
      const lay = layoutBoundText(container as unknown as EngineElement, el as unknown as TextElement)
      Object.assign(container, lay.container)
      Object.assign(el, lay.text)
      cuts.relaid++
    } catch {
      // keep the label as the file had it
    }
  }
}

/** One item as the import body wants it, or why it was left out. */
export type ItemResult =
  | { ok: true; name: string; elements: WireElement[]; cuts: ItemCuts }
  | { ok: false; problem: LibraryItemProblem | 'no-elements'; count: number; cuts: ItemCuts }

/**
 * An item of an `.excalidrawlib` (its name, if it has one, and its restored elements) as an import item: cleaned,
 * then through serializeLibraryItem (re-keyed to item-local ids at the origin, checked as the room would, held to the
 * item's limits).
 */
export function normaliseLibraryItem(
  item: { name?: unknown; elements: readonly unknown[] },
  position: number,
  now?: number,
): ItemResult {
  const { elements, cuts } = cleanLibraryElements(item.elements, now)
  if (!elements.length) return { ok: false, problem: 'no-elements', count: 0, cuts }
  const made = serializeLibraryItem(elements, {
    limits: IMPORT_ITEM_LIMITS,
    ...(now !== undefined ? { now } : {}),
  })
  if (!made.ok) return { ok: false, problem: made.problem, count: made.count, cuts }
  const given = typeof item.name === 'string' ? item.name.trim() : ''
  const name = [...(given || made.item.suggestedName || `Imported item ${position + 1}`)]
    .slice(0, LIBRARY_LIMITS.nameChars)
    .join('')
  return { ok: true, name, elements: made.item.elements, cuts }
}
