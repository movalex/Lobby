// OWNER: WS3 (wave Q, the Elements panel; registered by the wave Q foundation, hidden behind ELEMENTS_PANEL). One dock
// panel, Elements (panel id 'elements', order 35, the Shapes panel's place: features/pieces retires its dock entry when
// this one is on), with three sources: the built-in icons (WS1: Lucide and Tabler outline, generated index and shards
// under /lobby-assets/icons/; ./icons-port.ts), the built-in shapes and kits (WS4: @draftroom/templates pieces) and the
// library (WS2's routes, ./client.ts). Every insert goes through ./place.ts placeElements: native elements, one
// transaction, one undo step. Read-only roles get no panel.
//
// What it adds when on: the panel, the palette command 'elements.open', the drop of a tile onto the board
// (text/plain `lobby-element:<source>:<id>`, priority 200, drops only: a paste is never taken), and "Save to library…"
// in the selection bar and the context menu (people with the library: ./access.ts), which opens ./SaveDialog.tsx.
//
// While elementsPanelOn() (./flags.ts) is false the feature contributes nothing: no panel, no command, no drop handler,
// and the board page is exactly as before wave Q. docs/WAVE-Q-CONTRACTS.md §4 is the contract.
import {
  ELEMENTS_OPEN_COMMAND_ID,
  ELEMENTS_PANEL_ID,
  ELEMENTS_PANEL_LABEL,
  parseElementDrag,
} from '@draftroom/contracts'
import { memo } from 'react'
import { isReadonlyRole } from '../../board/access.ts'
import {
  type CanvasFeature,
  type CanvasFeatureContext,
  type CanvasPanelSpec,
  type CommandSpec,
  type ContentHandlerSpec,
  type MenuEntrySpec,
  type SelectionBarItemSpec,
  useCanvasFeatureContext,
} from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { PiecesIcon } from '../pieces/icons.tsx'
import { elementsAccess } from './access.ts'
import { ElementsPanel } from './ElementsPanel.tsx'
import { elementsPanelOn } from './flags.ts'
import { accessFactsOf, useElementsAccess } from './hooks.ts'
import { insertFailureText, insertTile } from './insert.ts'
import { marksOf } from './marks.ts'
import { loadInsertOptions } from './options.ts'
import { SaveDialog } from './SaveDialog.tsx'
import { elementsState } from './state.ts'

/** The dock panel. */
export const ELEMENTS_PANEL_SPEC: CanvasPanelSpec = {
  id: ELEMENTS_PANEL_ID,
  label: ELEMENTS_PANEL_LABEL,
  icon: PiecesIcon,
  order: 35,
  // inserting is editing: viewers, commenters and archived boards get no panel
  visible: (ctx) => !isReadonlyRole(ctx.role, ctx.board.status),
  component: ElementsPanel,
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: ELEMENTS_OPEN_COMMAND_ID,
    label: 'Elements',
    group: 'Insert',
    keywords: ['icons', 'shapes', 'library', 'stickers', 'elements', 'insert'],
    run: (ctx) => ctx.openPanel(ctx.activePanel === ELEMENTS_PANEL_ID ? null : ELEMENTS_PANEL_ID),
  },
]

/** A tile dropped on the board: it lands at the pointer (inside the unlocked frame there). */
export const DROP_HANDLER: ContentHandlerSpec = {
  id: 'elements.drop',
  kinds: ['text'],
  // above every text handler (bulk paste 50, link cards 100), like the Shapes panel's own drop
  priority: 200,
  async handle(content, ctx, at, source) {
    if (content.kind !== 'text' || source !== 'drop') return false
    const target = parseElementDrag(content.text.trim())
    if (!target) return false
    // a viewer's drop never reaches here (the input layer takes it); a locked-down board says why
    if (isReadonlyRole(ctx.role, ctx.board.status) || ctx.canvas.readOnly()) return true
    // a library item needs the library (a guest's page never offers one; a stale drag is refused here)
    if (target.source === 'item' && !elementsAccess(accessFactsOf(ctx)).library) return true
    const r = await insertTile(ctx, target, { options: loadInsertOptions(), at })
    if (!r.ok) {
      ctx.notify({
        key: 'elements-insert',
        tone: 'error',
        text: insertFailureText(r.reason),
        testId: 'element-insert-failed',
      })
      return true
    }
    const library = elementsAccess(accessFactsOf(ctx)).library
    marksOf(ctx.workspace.id, () => library).used(r.markKey, target.source !== 'item')
    ctx.canvas.focus({ preventScroll: true })
    return true
  },
}

/** "Save to library…" is offered for a selection to people with the library. */
export const saveOffered = (ctx: CanvasFeatureContext, ids: readonly string[]): boolean =>
  ids.length > 0 && elementsAccess(accessFactsOf(ctx)).library

const openSave = (ctx: CanvasFeatureContext, ids: readonly string[]) => {
  if (saveOffered(ctx, ids)) elementsState(ctx.canvas).saving.set([...ids])
}

const SaveBarButton = memo(function SaveBarButton({ selection }: { selection: readonly string[] }) {
  const ctx = useCanvasFeatureContext()
  return (
    <button
      type="button"
      className="dr-cux-selbar__btn"
      aria-label="Save to library"
      title="Save to library"
      data-testid="selection-save-to-library"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => openSave(ctx, selection)}
    >
      <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M6 3.5h12v17l-6-4-6 4z" />
        <path d="M12 7.5v5M9.5 10h5" />
      </svg>
    </button>
  )
})

export const SELECTION_BAR: readonly SelectionBarItemSpec[] = [
  {
    id: 'elements.save',
    // the arrange row (from 100), after "Arrange as grid" (200) and Sort (210)
    order: 260,
    visible: (ctx, selection) => saveOffered(ctx, selection),
    component: ({ selection }) => <SaveBarButton selection={selection} />,
  },
]

export const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'elements.save',
    group: 'organize',
    order: 40,
    label: 'Save to library…',
    visible: (ctx, t) => saveOffered(ctx, t.ids),
    run: (ctx, t) => {
      const ids = [...t.ids]
      // after the menu has closed (its focus handling first)
      setTimeout(() => openSave(ctx, ids), 0)
    },
  },
]

function SaveOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const page = elementsState(ctx.canvas)
  const ids = useValue(page.saving)
  const access = useElementsAccess(ctx)
  if (!ids || !access.library) return null
  return (
    <SaveDialog
      ctx={ctx}
      ids={ids}
      access={access}
      onClose={() => {
        page.saving.set(null)
        ctx.canvas.focus({ preventScroll: true })
      }}
    />
  )
}

/** The feature with the panel switched on or off (`feature` is the page's; tests build both). */
export function elementsFeature(enabled: boolean): CanvasFeature {
  if (!enabled) return { id: 'elements' }
  return {
    id: 'elements',
    panels: [ELEMENTS_PANEL_SPEC],
    commands: COMMANDS,
    contentHandlers: [DROP_HANDLER],
    selectionBar: SELECTION_BAR,
    contextMenu: CONTEXT_MENU,
    overlays: [{ id: 'elements.save', layer: 'screen', order: 31, pointer: 'auto', component: SaveOverlay }],
  }
}

export const feature: CanvasFeature = elementsFeature(elementsPanelOn())
