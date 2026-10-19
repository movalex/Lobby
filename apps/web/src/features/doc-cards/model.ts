// OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2). What a doc card is, and the two ways one is made.
//
// A doc card is an ordinary board element: a `rectangle` with `customData.lobby.kind = 'doc-card'` (contracts
// FORMAT_ELEMENT_KINDS.docCard, create-only) and a bound label whose `originalText` holds the card's Markdown-lite words
// (./markdown-lite.ts), left- and top-aligned in the body font. An old tab, an export, search and Ask read the label as
// plain text; this tab draws the formatted face over it (./DocFace.tsx) and edits it in the side panel
// (./DocEditor.tsx, a lease client: canvas/lease/panelEditor.ts).
//
//  - `insertDocCard`: a new card (640 × 400, white, a 1 px stroke) at the free spot nearest the middle of the view
//    (or centred on a point the person chose), inside the unlocked frame there when it fits, in ONE transact (one
//    undo step), selected, in view;
//  - `docCardFromText`: a selected free text becomes a new card holding its words, the text removed, in ONE
//    transact (one undo step brings the text back). Its label is laid out before the create (Excalidraw's own layout:
//    canvas/lease/panelEditor.ts `layoutDocWords`), so no text is written outside a create.
import { LOBBY_INK } from '@draftroom/board-ops/elements'
import { DOC_CARD_LIMITS, FORMAT_ELEMENT_KINDS } from '@draftroom/contracts'
import type { CanvasElement, LobbyCanvas, ScenePoint } from '../../canvas/api/index.ts'
import { layoutDocWords } from '../../canvas/lease/panelEditor.ts'
import { spotNear } from '../ai/ported/apply.ts'
import { revealResult } from '../ai/reveal.ts'
import { frameAt } from '../canvas-ux/ported/notes.ts'

export const DOC_CARD_KIND = FORMAT_ELEMENT_KINDS.docCard
export const DOC_CARD_W = DOC_CARD_LIMITS.width
export const DOC_CARD_H = DOC_CARD_LIMITS.height
/**
 * The words a card holds at most: DOC_CARD_LIMITS.maxChars (canvas-schema MAX_ORIGINAL_TEXT_CHARS). The NAS
 * measurement of the room's commit and relayout cost decides whether wave W ships 20,000 or 12,000
 * (docs/WAVE-W-CONTRACTS.md §2 Risks; the WS1 gate report).
 */
export const DOC_MAX_CHARS = DOC_CARD_LIMITS.maxChars
/** What search indexes of each card (apps/sync board-text ENTRY_MAX_CHARS; raising it is a sync change). */
export const DOC_SEARCH_CHARS = DOC_CARD_LIMITS.searchIndexedChars
/** The body font (Excalidraw's Nunito, the link cards' and notes' family) and its size. */
export const DOC_FONT_FAMILY = 6
export const DOC_FONT_SIZE = 16
export const DOC_STROKE = '#c4bfb0'
export const DOC_FILL = '#ffffff'
export const DOC_RADIUS = 8
/** Excalidraw's BOUND_TEXT_PADDING: the label's inset in its card. */
export const DOC_PAD = 5
/** A new card's words: a title to type over. */
export const NEW_DOC_WORDS = '# Untitled doc\n\n'
export const NEW_DOC_TITLE_RANGE = [2, 14] as const

export const DOC_LABEL_STYLE = {
  fontFamily: DOC_FONT_FAMILY,
  fontSize: DOC_FONT_SIZE,
  strokeColor: LOBBY_INK,
} as const

type Kinded = { readonly type: string; readonly customData?: unknown; readonly isDeleted?: boolean }

/** A doc card: a live rectangle of kind 'doc-card'. */
export function isDocCard(el: Kinded | null | undefined): boolean {
  if (!el || el.isDeleted || el.type !== 'rectangle') return false
  return (el.customData as { lobby?: { kind?: unknown } } | undefined)?.lobby?.kind === DOC_CARD_KIND
}

/** The doc card `el` is or belongs to (the card itself, or the card of its bound label), else null. */
export function docCardOf(canvas: Pick<LobbyCanvas, 'get'>, el: CanvasElement | null | undefined) {
  if (!el) return null
  if (isDocCard(el)) return el
  const containerId = (el as { containerId?: string | null }).containerId
  if (el.type === 'text' && containerId) {
    const card = canvas.get(containerId)
    return isDocCard(card) ? (card as CanvasElement) : null
  }
  return null
}

/** The card's words (its bound label's originalText); '' for a card without a label. */
export function docWords(canvas: Pick<LobbyCanvas, 'get'>, card: CanvasElement): string {
  const ref = (
    (card as { boundElements?: readonly { id: string; type: string }[] | null }).boundElements ?? []
  ).find((b) => b.type === 'text')
  const label = ref ? canvas.get(ref.id) : undefined
  if (!label || label.isDeleted) return ''
  return String((label as { originalText?: unknown }).originalText ?? '')
}

/** The live bound label of a card, or null. */
export function docLabel(canvas: Pick<LobbyCanvas, 'get'>, card: CanvasElement): CanvasElement | null {
  const ref = (
    (card as { boundElements?: readonly { id: string; type: string }[] | null }).boundElements ?? []
  ).find((b) => b.type === 'text')
  const label = ref ? canvas.get(ref.id) : undefined
  return label && !label.isDeleted && label.type === 'text' ? label : null
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return `${prefix}${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** The card's props before its label is laid out (what `layoutDocWords` reads as the container). */
function draftCard(id: string, x: number, y: number, w: number, h: number, frameId: string | null) {
  return {
    id,
    type: 'rectangle',
    x: round2(x),
    y: round2(y),
    width: w,
    height: h,
    angle: 0,
    strokeColor: DOC_STROKE,
    backgroundColor: DOC_FILL,
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: { type: 3, value: DOC_RADIUS },
    groupIds: [] as string[],
    frameId,
    boundElements: [] as { id: string; type: string }[],
    isDeleted: false,
    locked: false,
    link: null,
    customData: { lobby: { kind: DOC_CARD_KIND } },
  }
}

/**
 * The card and its label laid out as Excalidraw lays out a label (the label wrapped at the card's width, the card
 * grown to fit), ready for `tx.create`.
 */
export function docCardCreates(
  words: string,
  at: { x: number; y: number },
  opts: { width?: number; frameId?: string | null; id?: string } = {},
): { card: Record<string, unknown>; label: Record<string, unknown> } {
  const id = opts.id ?? newId('dc')
  const w = Math.max(DOC_CARD_W, Math.round(opts.width ?? 0))
  const card = draftCard(id, at.x, at.y, w, DOC_CARD_H, opts.frameId ?? null)
  const reader = { get: (x: string) => (x === id ? (card as unknown as CanvasElement) : undefined) }
  const { patches, create } = layoutDocWords(reader as Pick<LobbyCanvas, 'get'>, id, words, DOC_LABEL_STYLE)
  const fit = patches.get(id) ?? {}
  const label = create ?? {
    id: `${id}.t`,
    x: card.x + DOC_PAD,
    y: card.y + DOC_PAD,
    text: words,
    originalText: words,
    containerId: id,
  }
  const { boundElements: _b, ...fitRest } = fit as Record<string, unknown>
  return {
    card: {
      ...card,
      ...fitRest,
      boundElements: [{ id: label.id as string, type: 'text' }],
    },
    label: {
      ...label,
      fontFamily: DOC_FONT_FAMILY,
      fontSize: DOC_FONT_SIZE,
      textAlign: 'left',
      verticalAlign: 'top',
      strokeColor: LOBBY_INK,
      containerId: id,
      autoResize: true,
      ...(opts.frameId ? { frameId: opts.frameId } : {}),
    },
  }
}

/** The props a `tx.create` takes (the engine assigns version, seed and index). */
function createProps(el: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(el))
    if (!['type', 'version', 'versionNonce', 'updated', 'seed', 'index', 'isDeleted'].includes(k)) out[k] = v
  return out
}

/**
 * A new doc card: centred on `at` when given (a menu opened on the board), else at the free spot nearest the middle
 * of the view; inside the unlocked frame there when it fits. One undo step, selected, in view. Returns its id, or
 * null on a read-only board.
 */
export function insertDocCard(
  canvas: LobbyCanvas,
  opts: { at?: ScenePoint | null; words?: string } = {},
): string | null {
  if (canvas.readOnly()) return null
  const words = opts.words ?? NEW_DOC_WORDS
  let x: number
  let y: number
  let frameId: string | null = null
  if (opts.at) {
    x = opts.at.x - DOC_CARD_W / 2
    y = opts.at.y - DOC_CARD_H / 2
    const frame = frameAt(canvas, opts.at, { unlockedOnly: true })
    const b = frame ? canvas.bounds(frame.id) : null
    if (frame && b && b.width >= DOC_CARD_W && b.height >= DOC_CARD_H) {
      x = Math.min(Math.max(x, b.x), b.x + b.width - DOC_CARD_W)
      y = Math.min(Math.max(y, b.y), b.y + b.height - DOC_CARD_H)
      frameId = frame.id
    }
  } else {
    const spot = spotNear(canvas, { w: DOC_CARD_W, h: DOC_CARD_H }, [])
    x = spot.x
    y = spot.y
    frameId = spot.frameId
  }
  const { card, label } = docCardCreates(words, { x, y }, { frameId })
  const id = canvas.transact('Add doc card', (tx) => {
    tx.create('rectangle', createProps(card))
    tx.create('text', createProps(label))
    return card.id as string
  })
  canvas.select([id])
  void revealResult(canvas, [id])
  return id
}

/** The free text a "Turn into doc card" acts on: exactly one live, unlocked free text selected, else null. */
export function fromTextTarget(canvas: LobbyCanvas, selection: readonly string[]): CanvasElement | null {
  if (selection.length !== 1 || canvas.readOnly()) return null
  const el = canvas.get(selection[0] as string)
  if (!el || el.isDeleted || el.type !== 'text') return null
  if ((el as { containerId?: string | null }).containerId) return null
  if (canvas.isLocked(el.id) || canvas.isHidden(el.id)) return null
  return el
}

export type FromTextResult = { ok: true; id: string } | { ok: false; reason: 'none' | 'leased' | 'too-long' }

/**
 * Turns the selected free text into a doc card holding its words, where the text was, in one undo step (the text is
 * removed in the same step). Refused while someone else types in the text (its lease), and for words past the cap.
 */
export function docCardFromText(canvas: LobbyCanvas, selection: readonly string[]): FromTextResult {
  const text = fromTextTarget(canvas, selection)
  if (!text) return { ok: false, reason: 'none' }
  const holder = canvas.leaseHolder(text.id)
  if (holder || canvas.editingId() === text.id) return { ok: false, reason: 'leased' }
  const words = String(
    (text as { originalText?: unknown }).originalText ?? (text as { text?: unknown }).text ?? '',
  )
  if (words.length > DOC_MAX_CHARS) return { ok: false, reason: 'too-long' }
  const frameId = (text as { frameId?: string | null }).frameId ?? null
  const { card, label } = docCardCreates(
    words,
    { x: text.x - DOC_PAD, y: text.y - DOC_PAD },
    {
      frameId,
      width: Math.min(1_600, text.width + 2 * DOC_PAD),
    },
  )
  const id = canvas.transact('Turn into doc card', (tx) => {
    tx.create('rectangle', createProps(card))
    tx.create('text', createProps(label))
    tx.delete(text.id)
    return card.id as string
  })
  canvas.select([id])
  return { ok: true, id }
}
