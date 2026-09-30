// OWNER: 3f. How the workshops feature reads canvas elements on the Excalidraw page (the tldraw
// implementation read shapes: hooks.ts editorLookup, voting.ts shapeLabel). Pure, over CanvasElement and
// a lookup, so it runs in Node tests.
//
// - Votes, +1s and results name objects by their api ref, `shape:<elementId>` (canvas-schema refs.ts): the
//   workshop api, its events and the DOM (`data-shape-id`) all keep that form, as on the tldraw board.
// - The vote vocabulary is the api's (apps/api canvas/lobby-elements.ts `objectTypeOf`, the tldraw shape
//   types `VoteSession.shapeTypes` and VOTE_INELIGIBLE_TYPES use): a sticky note is `note`, a rectangle,
//   ellipse or diamond `geo`, a file card `dr-file-card` (a video `video`), a bound label nothing (it is
//   part of its container). The same rule on both sides means a vote the browser offers is one the api
//   accepts (`elements.test.ts` pins the table).
// - Frames hold their children through `frameId` (one level: no nested frames), so a frame-scoped vote's
//   parent chain is the element's frame, then the page.
import { fromShapeRef, toShapeRef } from '@draftroom/canvas-schema/refs'
import {
  isVoteEligible,
  VOTE_SHAPE_ID_PATTERN,
  type VoteEligibilityRule,
  type VoteShapeInfo,
} from '@draftroom/contracts'
import { type CanvasElement, items, SINGLE_PAGE_ID } from '../../../canvas/api/index.ts'
import { LINE_SEPARATOR, typeName } from '../voting.ts'

export type Lookup = (id: string) => CanvasElement | undefined

/**
 * The api ref of an element id (`shape:<id>`), or null for an id the workshop api cannot name: its
 * object-ref pattern (VOTE_SHAPE_ID_PATTERN) is narrower than the element id pattern (no `.` or `:`).
 */
export function refOf(elementId: string): string | null {
  try {
    const ref = toShapeRef(elementId)
    return VOTE_SHAPE_ID_PATTERN.test(ref) ? ref : null
  } catch {
    return null
  }
}

/** The element id of an api ref, or null. */
export const elementIdOf = (ref: string): string | null => fromShapeRef(ref)

const VERSION_RE = /^ver_[0-9A-Za-z]{10,40}$/
const PDF_PAGE_RE = /\.p[1-9][0-9]{0,3}$/

/** An image element's kind in the api's words: `image`, `video` or `dr-file-card` (apps/api lobby-elements.ts). */
function imageTypeOf(el: CanvasElement): string {
  const fileId = (el as { fileId?: unknown }).fileId
  if (typeof fileId !== 'string') return 'image'
  const versionId = fileId.replace(PDF_PAGE_RE, '')
  if (!VERSION_RE.test(versionId)) return 'image'
  const facts = items.lobbyValue(el, 'file') as { versionId?: unknown; kind?: unknown } | undefined
  const kind = facts && facts.versionId === versionId ? facts.kind : null
  if (PDF_PAGE_RE.test(fileId) || kind === 'image') return 'image'
  if (kind === 'video') return 'video'
  if (kind === 'pdf' || kind === 'other') return 'dr-file-card'
  return 'image'
}

/** The api's object type of an element (the vote vocabulary), or null for a bound label or an unknown type. */
export function voteTypeOf(el: CanvasElement): string | null {
  switch (el.type) {
    case 'stickynote':
      return 'note'
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
      return 'geo'
    case 'text':
      return el.containerId ? null : 'text'
    case 'freedraw':
      return items.lobbyValue(el, 'kind') === 'highlight' ? 'highlight' : 'draw'
    case 'arrow':
    case 'line':
    case 'frame':
      return el.type
    case 'image':
      return imageTypeOf(el)
    default:
      return null
  }
}

const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** The shared eligibility rule's lookup (packages/contracts isVoteEligible), by api ref. */
export function voteLookup(get: Lookup): (ref: string) => VoteShapeInfo | undefined {
  return (ref) => {
    const id = elementIdOf(ref)
    const el = id ? get(id) : undefined
    if (!isLive(el)) return undefined
    const type = voteTypeOf(el)
    if (!type) return undefined
    const frame = el.frameId ? refOf(el.frameId) : null
    return { id: ref, type, parentId: frame ?? SINGLE_PAGE_ID }
  }
}

/** Whether the element `id` may take a vote under `rule` (a bound label never does; its container may). */
export function isEligibleElement(id: string, get: Lookup, rule: VoteEligibilityRule): boolean {
  const ref = refOf(id)
  return !!ref && isVoteEligible(ref, voteLookup(get), rule)
}

/** One line: a note's lines joined with " · " (round-2 F17), blank lines dropped, spaces folded. */
export function oneLine(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(LINE_SEPARATOR)
}

/**
 * What to call a voted (or +1'd) object in the results, the stepper and the +1 labels: its words, a
 * frame's name, an image's alt text or a file's name; "Untitled …" when it has none, "Deleted object"
 * when it is gone (voting.ts shapeLabel on the tldraw board).
 */
export function elementLabel(el: CanvasElement | undefined, get: Lookup): string {
  if (!isLive(el)) return 'Deleted object'
  const text = oneLine(items.textOf(el, get))
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text
  const alt = items.lobbyValue(el, 'alt')
  if (typeof alt === 'string' && alt.trim()) return alt.trim()
  const file = items.lobbyValue(el, 'file') as { name?: unknown } | undefined
  if (typeof file?.name === 'string' && file.name.trim()) return file.name.trim()
  return `Untitled ${typeName(voteTypeOf(el) ?? el.type).toLowerCase()}`
}

/** The label of the object an api ref names. */
export function labelOfRef(ref: string, get: Lookup): string {
  const id = elementIdOf(ref)
  return elementLabel(id ? get(id) : undefined, get)
}

/** "Sticky note", "Shape", "File" … for the results CSV (voting.ts typeName over the vote vocabulary). */
export function typeNameOfRef(ref: string, get: Lookup): string {
  const id = elementIdOf(ref)
  const el = id ? get(id) : undefined
  if (!isLive(el)) return 'Deleted'
  return typeName(voteTypeOf(el) ?? el.type)
}

/** The frame an element is in, or is (a bound label counts as its container). */
export function frameOf(el: CanvasElement | undefined, get: Lookup): CanvasElement | null {
  if (!isLive(el)) return null
  const target = items.containerOf(el, get)
  if (target.type === 'frame') return target
  const frame = target.frameId ? get(target.frameId) : undefined
  return isLive(frame) && frame.type === 'frame' ? frame : null
}

/** A frame's name, or "Frame" (private-notes/canvas.ts frameName). */
export function frameName(el: CanvasElement | null | undefined): string {
  const name = (el as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' && name.trim() ? name.trim() : 'Frame'
}

/** Only sticky notes take +1s (plus-ones.ts isPlusOneTarget). */
export const isPlusOneTarget = (el: CanvasElement | null | undefined): boolean =>
  !!el && el.type === 'stickynote' && !(el as { isDeleted?: boolean }).isDeleted
