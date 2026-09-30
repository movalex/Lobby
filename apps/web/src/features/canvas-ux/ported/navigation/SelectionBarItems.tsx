// The navigation feature's selection-bar buttons (3a's selection-bar shell renders them): "Copy link to
// selection" (PRS-04) and "Arrange as grid" with its columns stepper (MAK-18), as on the tldraw board's
// SelectionBar. A button pressed from the keyboard gives the keyboard back to the board.
import { isReadonlyRole } from '../../../../board/access.ts'
import {
  type CanvasFeatureContext,
  currentPlatform,
  formatChord,
  type SelectionBarItemSpec,
} from '../../../../canvas/api/index.ts'
import { useValue } from '../../../../lib/signals.ts'
import { GridIcon, LinkIcon } from '../../icons.tsx'
import { currentGridSession, hasArrangeable, runArrangeAsGrid } from './arrange-grid.ts'
import { copySelectionLink } from './copy-link.ts'

export const ARRANGE_CHORD = 'alt+shift+g'
const ARRANGE_KBD = formatChord(ARRANGE_CHORD, currentPlatform())

const backToBoard = (ctx: CanvasFeatureContext, el: HTMLElement) => {
  if (el.closest('[data-lobby-slot]')?.contains(document.activeElement))
    ctx.canvas.focus({ preventScroll: true })
}

function CopyLinkButton({ ctx }: { ctx: CanvasFeatureContext; selection: readonly string[] }) {
  return (
    <button
      type="button"
      className="dr-cux-selbar__btn"
      aria-label="Copy link to selection"
      title="Copy link to selection"
      data-testid="copy-link-selection"
      onClick={(e) => {
        const el = e.currentTarget
        void copySelectionLink(ctx)
        backToBoard(ctx, el)
      }}
    >
      <LinkIcon />
    </button>
  )
}

/** MAK-18: the column count of the grid just arranged (each change is its own undo step). */
function GridColumns({
  columns,
  max,
  onChange,
}: {
  columns: number
  max: number
  onChange(n: number): void
}) {
  return (
    <span className="dr-cux-gridcols" data-testid="grid-columns" data-columns={columns}>
      <button
        type="button"
        className="dr-cux-selbar__btn dr-cux-gridcols__step"
        aria-label="Fewer columns"
        title="Fewer columns"
        data-testid="grid-columns-less"
        disabled={columns <= 1}
        onClick={() => onChange(columns - 1)}
      >
        −
      </button>
      <span className="dr-cux-gridcols__label" aria-live="polite">
        {columns} {columns === 1 ? 'column' : 'columns'}
      </span>
      <button
        type="button"
        className="dr-cux-selbar__btn dr-cux-gridcols__step"
        aria-label="More columns"
        title="More columns"
        data-testid="grid-columns-more"
        disabled={columns >= max}
        onClick={() => onChange(columns + 1)}
      >
        +
      </button>
    </span>
  )
}

function ArrangeGridButton({ ctx }: { ctx: CanvasFeatureContext; selection: readonly string[] }) {
  const { canvas } = ctx
  const session = useValue('nav-grid-stepper', () => {
    const s = currentGridSession(canvas)
    return s ? `${s.columns}/${s.order.length}` : null
  }, [canvas])
  const [columns, max] = session ? session.split('/').map(Number) : [null, 0]
  return (
    <>
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="dr-cux-selbar__btn"
        aria-label={`Arrange as grid (${ARRANGE_KBD})`}
        title={`Arrange as grid (${ARRANGE_KBD})`}
        data-testid="arrange-grid"
        onClick={(e) => {
          const el = e.currentTarget
          runArrangeAsGrid(ctx)
          backToBoard(ctx, el)
        }}
      >
        <GridIcon />
      </button>
      {columns !== null && columns !== undefined && (
        // unlike the one-shot buttons, the stepper keeps the keyboard focus (for repeated presses)
        <GridColumns
          columns={columns}
          max={max ?? 0}
          onChange={(n) => void runArrangeAsGrid(ctx, { columns: n })}
        />
      )}
    </>
  )
}

const canEdit = (ctx: CanvasFeatureContext) =>
  !isReadonlyRole(ctx.role, ctx.board.status) && !ctx.canvas.readOnly()

export const SELECTION_BAR_ITEMS: readonly SelectionBarItemSpec[] = [
  { id: 'navigation.copy-link', order: 10, component: CopyLinkButton },
  {
    id: 'navigation.arrange-grid',
    order: 60,
    visible: (ctx, selection) => canEdit(ctx) && selection.length >= 2 && hasArrangeable(ctx.canvas),
    component: ArrangeGridButton,
  },
]
