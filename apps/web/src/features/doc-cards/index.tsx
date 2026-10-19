// OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2). The 'doc-cards' feature on the Excalidraw board page:
// a formatted text card on the canvas, Miro's "doc" as an ordinary board element.
//
//  - ./model.ts: what a doc card is (a rectangle of kind 'doc-card' with a bound label of Markdown-lite words), the
//    insert and "Turn into doc card" (one undo step each);
//  - ./markdown-lite.ts: the parser (React nodes only, never HTML: ./DocBlocks.tsx draws them);
//  - ./DocFace.tsx: the formatted face over every visible card (the scene layer `doc-cards.faces`);
//  - ./DocEditor.tsx: the side panel (the dock panel `doc-card`), a lease client of the card's text lease
//    (canvas/lease/panelEditor.ts) on the input guard's list (canvas/input/dblclick.ts PANEL_TEXT_EDITORS);
//  - ./export.ts: the export layer `doc-cards` (PNG, SVG and PDF draw the words with their marks taken out; the face is
//    never in an export).
//
// It opens on a double-click or a double-tap on a card (the board's input stream, before the engine's lease flow), on
// Enter with one card selected, on the face's Open, the selection bar's Open, the context menu and the palette. A
// read-only role reads it there. Everything is offered only while `docCardsOn()` (FORMATS_FLAGS.docCards AND the api's
// DRAFTROOM_DOC_CARDS): off, a placed card is a rectangle with its words, edited in place like any label.
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CanvasInputEvent,
  CanvasPanelSpec,
  CommandSpec,
  FeatureOverlaySpec,
  MenuEntrySpec,
  SelectionBarItemSpec,
} from '../../canvas/api/index.ts'
import { panelEditorTarget } from '../../canvas/input/dblclick.ts'
import { useValue } from '../../lib/signals.ts'
import { registerExportOverlay } from '../present-export/ported/badges.ts'
import { DocEditorPanel } from './DocEditor.tsx'
import { DocFaceLayer } from './DocFace.tsx'
import { DOC_CARDS_OVERLAY } from './export.ts'
import { docCardFromText, fromTextTarget, insertDocCard, isDocCard } from './model.ts'
import { DOC_PANEL_ID, docCardsOn, docState, openDocPanel } from './state.ts'

export const DOC_CARD_INSERT_COMMAND_ID = 'doc-card.insert'
export const DOC_CARD_FROM_TEXT_COMMAND_ID = 'doc-card.from-text'

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V4a.5.5 0 0 1 0-.5zM14 3.5V8h4M9 12h6M9 15.5h6M9 9h2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The one doc card selected (live), or null. */
function selectedCard(
  ctx: CanvasFeatureContext,
  ids: readonly string[] = ctx.canvas.selection,
): string | null {
  if (ids.length !== 1) return null
  const el = ctx.canvas.get(ids[0] as string)
  return isDocCard(el) ? (el?.id ?? null) : null
}

/** Inserts a card and opens its panel for typing (one undo step for the card; the words are their own steps). */
function insertAndOpen(ctx: CanvasFeatureContext, at?: { x: number; y: number } | null): string | null {
  const id = insertDocCard(ctx.canvas, { at: at ?? null })
  if (id) openDocPanel(ctx, id, { edit: true })
  return id
}

function fromText(ctx: CanvasFeatureContext, ids: readonly string[]): void {
  const r = docCardFromText(ctx.canvas, ids)
  if (r.ok) return
  ctx.notify({
    key: 'doc-card:from-text',
    tone: 'error',
    testId: 'doc-card-toast',
    text:
      r.reason === 'leased'
        ? 'Someone is typing in that text. Try again when they are done.'
        : r.reason === 'too-long'
          ? 'That text is too long for a doc card.'
          : 'Select one text first.',
  })
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: DOC_CARD_INSERT_COMMAND_ID,
    label: 'Doc card',
    group: 'Insert',
    keywords: ['doc', 'document', 'page', 'notes', 'write', 'markdown', 'checklist', 'text card'],
    available: () => docCardsOn(),
    disabledReason: (ctx) => (ctx.canvas.readOnly() ? 'You can view this board but not add to it' : null),
    run: (ctx) => {
      insertAndOpen(ctx)
    },
  },
  {
    id: DOC_CARD_FROM_TEXT_COMMAND_ID,
    label: 'Turn text into doc card',
    group: 'Insert',
    keywords: ['doc', 'document', 'convert', 'text', 'markdown'],
    available: () => docCardsOn(),
    disabledReason: (ctx) =>
      ctx.canvas.readOnly()
        ? 'You can view this board but not change it'
        : fromTextTarget(ctx.canvas, ctx.canvas.selection)
          ? null
          : 'Select one text first',
    run: (ctx) => fromText(ctx, ctx.canvas.selection),
  },
]

export const PANELS: readonly CanvasPanelSpec[] = [
  {
    id: DOC_PANEL_ID,
    label: 'Doc card',
    icon: DocIcon,
    order: 95,
    visible: (ctx) => docCardsOn() && docState(ctx.canvas).target.get() !== null,
    component: DocEditorPanel,
  },
]

export const OVERLAYS: readonly FeatureOverlaySpec[] = [
  // under the kanban columns, search's dimming and every chip; the layer takes no clicks (its links, boxes and Open do)
  { id: 'doc-cards.faces', layer: 'scene', order: 3, pointer: 'none', component: DocFaceLayer },
]

export const MAIN_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'doc-card.main-insert',
    group: 'board',
    order: 32,
    label: 'Add doc card',
    visible: (ctx) => docCardsOn() && !ctx.canvas.readOnly(),
    run: (ctx) => void setTimeout(() => insertAndOpen(ctx), 0),
  },
]

export const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'doc-card.ctx-open',
    group: 'edit',
    order: 5,
    label: (ctx) => (ctx.canvas.readOnly() ? 'Read doc card' : 'Edit doc card'),
    visible: (ctx, t) =>
      docCardsOn() && selectedCard(ctx, t.ids.length ? t.ids : t.hit ? [t.hit.id] : []) !== null,
    run: (ctx, t) => {
      const id = selectedCard(ctx, t.ids.length ? t.ids : t.hit ? [t.hit.id] : [])
      if (id) openDocPanel(ctx, id, { edit: true })
    },
  },
  {
    id: 'doc-card.ctx-from-text',
    group: 'edit',
    order: 6,
    label: 'Turn into doc card',
    visible: (ctx, t) => docCardsOn() && fromTextTarget(ctx.canvas, t.ids) !== null,
    run: (ctx, t) => fromText(ctx, t.ids),
  },
  {
    id: 'doc-card.ctx-insert',
    group: 'edit',
    order: 7,
    label: 'Add doc card here',
    visible: (ctx, t) => docCardsOn() && !ctx.canvas.readOnly() && t.ids.length === 0 && !t.hit,
    run: (ctx, t) => void setTimeout(() => insertAndOpen(ctx, t.point), 0),
  },
]

function OpenButton({ ctx, selection }: { ctx: CanvasFeatureContext; selection: readonly string[] }) {
  const id = useValue('doc-card.bar', () => (docCardsOn() ? selectedCard(ctx, selection) : null), [
    ctx,
    selection,
  ])
  const readOnly = useValue('doc-card.bar-ro', () => ctx.canvas.readOnly(), [ctx])
  if (!id) return null
  const label = readOnly ? 'Read doc card' : 'Edit doc card'
  return (
    <span className="lobby-doc-barslot">
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="dr-cux-selbar__btn"
        data-testid="selection-doc-card-open"
        aria-label={label}
        title={`${label} (Enter)`}
        onClick={() => openDocPanel(ctx, id, { edit: true })}
      >
        <DocIcon />
      </button>
    </span>
  )
}

export const SELECTION_BAR: readonly SelectionBarItemSpec[] = [
  {
    id: 'doc-card.open',
    order: 12,
    visible: (ctx, sel) => docCardsOn() && selectedCard(ctx, sel) !== null,
    component: OpenButton,
  },
]

/**
 * The board's input stream, before the engine and the key allowlist (canvas/board/input.ts):
 *  - a double-click or a double-tap on a doc card (or its label) opens its panel, taken before the engine's lease
 *    flow (canvas/input/dblclick.ts `panelEditorTarget`): the in-place editor never opens on a doc card from it;
 *  - Enter (a person's, never the lease's own synthetic one) with the one doc card selected and the board holding the
 *    keyboard opens its panel the same way. An observer of the stream, not a key claim: the mind map's Enter claim
 *    keeps its chord, and the two never meet (a topic is never a doc card).
 */
export function installInput(ctx: CanvasFeatureContext): () => void {
  const canvas = ctx.canvas
  return canvas.on('input', (e: CanvasInputEvent) => {
    if (!docCardsOn()) return
    if (e.type === 'key-down') {
      if (e.key !== 'Enter' || e.synthetic || e.composing || e.shift || e.ctrl || e.meta || e.alt) return
      if (canvas.editingId() !== null || !canvas.hasKeyboard() || ctx.registries.menusOpen.call()) return
      const id = selectedCard(ctx)
      if (!id) return
      e.handled()
      openDocPanel(ctx, id, { edit: true })
      return
    }
    if (e.type !== 'double-click' || e.button !== 0) return
    if (e.shift || e.ctrl || e.meta || e.alt || canvas.editingId() !== null) return
    const target = panelEditorTarget(e.hit as never, (id) => canvas.get(id) as never)
    if (!target) return
    e.handled()
    openDocPanel(ctx, target.id, { edit: true })
  })
}

export const feature: CanvasFeature = {
  id: 'doc-cards',
  panels: PANELS,
  overlays: OVERLAYS,
  commands: COMMANDS,
  mainMenu: MAIN_MENU,
  contextMenu: CONTEXT_MENU,
  selectionBar: SELECTION_BAR,
  onMount: (ctx) => {
    const offInput = installInput(ctx)
    // the export layer lives as long as the board page does
    const offLayer = registerExportOverlay(DOC_CARDS_OVERLAY)
    return () => {
      offLayer()
      offInput()
    }
  },
}
