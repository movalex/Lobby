/**
 * Pure readers over canvas elements for feature code (docs/EXCALIDRAW-CONTRACTS.md §5): the replacement
 * for tldraw's shape types (`TLShape`, `TLNoteShape`, `isShapeOfType`, `getShapeUtil(s).getText`,
 * `shape.meta.dr*`, parent chains). Excalidraw keeps structure in fields, not parents: a note's text is
 * its bound label, a frame's children carry `frameId`, a group is a shared `groupIds` entry. Readers
 * follow `containerId` and `boundElements`, never id suffixes (§3.6). Frozen at wave 1.
 *
 * Every function takes the element(s) and, where it must follow a reference, a lookup (usually
 * `canvas.get`), so it runs on live canvas data, on a snapshot or in a Node test alike.
 */
import type { CanvasElement } from '../port.ts'
import type { LobbyItemKind } from './lobby-canvas.ts'

export type Lookup = (id: string) => CanvasElement | undefined

type Bound = { readonly id: string; readonly type: string }

const boundOf = (el: CanvasElement): readonly Bound[] =>
  ((el as { boundElements?: readonly Bound[] | null }).boundElements ?? []) as readonly Bound[]

/** `customData.lobby[key]`, or undefined. */
export function lobbyValue(el: CanvasElement | undefined, key: string): unknown {
  return el?.customData?.lobby?.[key]
}

/** Every `customData.lobby` key starting with `prefix` (`tag:`, `plusOne:`), with its suffix. */
export function lobbyEntries(
  el: CanvasElement | undefined,
  prefix: string,
): { suffix: string; value: unknown }[] {
  const lobby = el?.customData?.lobby
  if (!lobby) return []
  return Object.entries(lobby)
    .filter(([k]) => k.startsWith(prefix) && k.length > prefix.length)
    .map(([k, value]) => ({ suffix: k.slice(prefix.length), value }))
}

/** The feature-level kind (tldraw's `shape.type` plus the geo/file-card distinctions). */
export function itemKindOf(el: CanvasElement): LobbyItemKind | null {
  switch (el.type) {
    case 'stickynote':
      return 'note'
    case 'text':
      return el.containerId ? 'label' : 'text'
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
      return 'shape'
    case 'arrow':
      return 'arrow'
    case 'line':
      return 'line'
    case 'freedraw':
      return lobbyValue(el, 'kind') === 'highlight' ? 'highlight' : 'draw'
    case 'image':
      return lobbyValue(el, 'file') !== undefined && !isPlainImageFile(el) ? 'file-card' : 'image'
    case 'frame':
      return 'frame'
    default:
      return null
  }
}

/** An image element whose file is a raster image shown as itself (not a PDF page, video or document card). */
function isPlainImageFile(el: CanvasElement): boolean {
  const file = lobbyValue(el, 'file') as { kind?: string } | undefined
  return file?.kind === 'image' && lobbyValue(el, 'pdfPage') === undefined
}

/** The bound text label of a container (a note, a shape, an arrow), or undefined. */
export function labelOf(el: CanvasElement, get: Lookup): CanvasElement | undefined {
  for (const b of boundOf(el)) {
    if (b.type !== 'text') continue
    const label = get(b.id)
    if (label && !(label as { isDeleted?: boolean }).isDeleted) return label
  }
  return undefined
}

/** The container of a bound label (or the element itself when it is not a label). */
export function containerOf(el: CanvasElement, get: Lookup): CanvasElement {
  if (el.type === 'text' && el.containerId) return get(el.containerId) ?? el
  return el
}

/** Plain text: a text's own words, a container's label words, a frame's name; '' when none. */
export function textOf(el: CanvasElement, get: Lookup): string {
  if (el.type === 'text') return String((el as { originalText?: string }).originalText ?? '')
  if (el.type === 'frame') return String((el as { name?: string | null }).name ?? '')
  const label = labelOf(el, get)
  return label ? String((label as { originalText?: string }).originalText ?? '') : ''
}

/** The arrows bound to an element (tldraw's `getBindingsToShape(id, 'arrow')`), as ids. */
export function arrowsOf(el: CanvasElement): string[] {
  return boundOf(el)
    .filter((b) => b.type === 'arrow')
    .map((b) => b.id)
}

/** An arrow's bound ends (tldraw's `getBindingsFromShape(arrow, 'arrow')`). */
export function arrowEnds(el: CanvasElement): { start: string | null; end: string | null } {
  const a = el as { startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null }
  return { start: a.startBinding?.elementId ?? null, end: a.endBinding?.elementId ?? null }
}

/** The ids of a frame's children, in paint order (tldraw's `getSortedChildIdsForParent(frame)`). */
export function childrenOf(frameId: string, items: readonly CanvasElement[]): string[] {
  return items.filter((e) => e.frameId === frameId).map((e) => e.id)
}

/** The outermost group id of an element, or null (tldraw's top group ancestor). */
export function outerGroupOf(el: CanvasElement): string | null {
  return el.groupIds.length ? (el.groupIds[el.groupIds.length - 1] ?? null) : null
}

/** Every element sharing `groupId` (tldraw's group children). */
export function groupMembers(groupId: string, items: readonly CanvasElement[]): string[] {
  return items.filter((e) => e.groupIds.includes(groupId)).map((e) => e.id)
}

/** Items, labels excluded, deleted excluded: what "the board's content" means for counts and search. */
export function contentItems(items: readonly CanvasElement[]): CanvasElement[] {
  return items.filter(
    (e) => !(e.type === 'text' && e.containerId) && !(e as { isDeleted?: boolean }).isDeleted,
  )
}
