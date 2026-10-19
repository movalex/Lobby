// OWNER: WS1 (wave W, doc cards). What the doc card parts share on one board page: whether the feature is offered, the
// card the panel shows, the panel's lease client, and the parsed words (memoized: a face re-renders on every camera
// move, the words change only when someone types).
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { canvasWriter, type PanelEditorLease, panelEditorOf } from '../../canvas/lease/panelEditor.ts'
import { type Atom, atom } from '../../lib/signals.ts'
import { formatsEnabled } from '../formats/flags.ts'
import { type ParsedDoc, parseMarkdownLite, toggleCheck } from './markdown-lite.ts'
import { DOC_LABEL_STYLE, DOC_MAX_CHARS, docCardOf, docWords } from './model.ts'

export const DOC_PANEL_ID = 'doc-card'

/** The feature is offered on this page: its web switch AND the api's offer (DRAFTROOM_DOC_CARDS). Reactive. */
export const docCardsOn = (): boolean => formatsEnabled('docCards')

interface DocState {
  /** the card the panel shows (null: no panel) */
  readonly target: Atom<string | null>
  /** mounted panel components (DocEditor's close is decided once none is left) */
  mounted: number
}

const states = new WeakMap<object, DocState>()

export function docState(canvas: LobbyCanvas): DocState {
  let s = states.get(canvas)
  if (!s) {
    s = { target: atom<string | null>('doc-card-target', null), mounted: 0 }
    states.set(canvas, s)
  }
  return s
}

/** The panel's lease client on this board page (null on a canvas with no board session: nothing can write). */
export function docPanelOf(canvas: LobbyCanvas): PanelEditorLease | null {
  return panelEditorOf(canvas, () => ({
    board: canvasWriter(canvas, { style: DOC_LABEL_STYLE, label: 'Edit doc card' }),
    maxChars: DOC_MAX_CHARS,
    thing: 'doc card',
  }))
}

const parseCache = new Map<string, ParsedDoc>()

/** The parsed words (the last 64 texts kept). */
export function parsedWords(words: string): ParsedDoc {
  const hit = parseCache.get(words)
  if (hit) {
    parseCache.delete(words)
    parseCache.set(words, hit)
    return hit
  }
  const doc = parseMarkdownLite(words)
  parseCache.set(words, doc)
  if (parseCache.size > 64) {
    const oldest = parseCache.keys().next().value
    if (oldest !== undefined) parseCache.delete(oldest)
  }
  return doc
}

/**
 * Opens the panel on `cardId`: for editing (it asks for the lease; read-only until granted) when this person can edit
 * it, else to read. The dock shows it.
 */
export function openDocPanel(ctx: CanvasFeatureContext, cardId: string, opts: { edit: boolean }): void {
  const card = ctx.canvas.get(cardId)
  if (!docCardOf(ctx.canvas, card ?? null)) return
  const panel = docPanelOf(ctx.canvas)
  docState(ctx.canvas).target.set(cardId)
  panel?.open(cardId, { edit: opts.edit && !ctx.canvas.readOnly() })
  ctx.openPanel(DOC_PANEL_ID)
}

/** Closes the panel's card (its words written, its lease given back). */
export function closeDocPanel(canvas: LobbyCanvas): void {
  docPanelOf(canvas)?.close()
  docState(canvas).target.set(null)
}

/**
 * Ticks or unticks a checklist item from the face: through the open panel when it holds this card (its words and the
 * tick stay one text), else as one `text.replace` (the lease asked for, the words written in one undo step, the
 * lease given back). Says who is typing when someone else holds the card.
 */
export async function toggleDocCheck(ctx: CanvasFeatureContext, cardId: string, line: number): Promise<void> {
  const canvas = ctx.canvas
  if (canvas.readOnly()) return
  const panel = docPanelOf(canvas)
  const ps = panel?.state()
  if (panel && ps?.cardId === cardId && panel.isWritable()) {
    const next = toggleCheck(ps.text, line)
    if (next !== null) panel.input(next)
    return
  }
  const card = canvas.get(cardId)
  if (!card) return
  const next = toggleCheck(docWords(canvas, card), line)
  if (next === null) return
  const holder = canvas.leaseHolder(cardId)
  const ok = holder ? false : await canvas.text.replace(cardId, next, 'Tick checklist item')
  if (!ok)
    ctx.notify({
      key: `doc-card:${cardId}`,
      text: holder ? `${holder.name} is editing this doc card` : 'Couldn’t tick that item. Try again.',
      testId: 'doc-card-toast',
    })
}
