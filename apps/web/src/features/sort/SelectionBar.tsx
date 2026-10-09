// The selection bar's "Sort" button (a SelectionBarItemSpec in the arrange row): for two or more notes, or a
// frame of them, and only for people who can edit. It opens the sort popover under the bar.
import { memo, useRef } from 'react'
import type { SelectionBarItemSpec } from '../../canvas/api/index.ts'
import { useCanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { SortIcon } from './icons.tsx'
import { targetNotes } from './model.ts'
import { anchorAtElement, closeSortMenu, openSortMenu, sortMenu } from './state.ts'

const SortBarButton = memo(function SortBarButton() {
  const ctx = useCanvasFeatureContext()
  const { canvas } = ctx
  const open = useValue('lobby-sort-bar-open', () => sortMenu(canvas).get() !== null, [canvas])
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      type="button"
      className="dr-cux-selbar__btn dr-sort-barbtn"
      aria-label="Sort"
      title="Sort notes into columns"
      aria-haspopup="menu"
      aria-expanded={open}
      data-testid="selection-sort"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (open) {
          closeSortMenu(canvas)
          return
        }
        const el = ref.current
        if (!el) return
        // a keyboard user gets the keyboard back on the button when the popover closes
        const opener = document.activeElement === el ? el : null
        openSortMenu(ctx, 'menu', anchorAtElement(canvas, el), canvas.selection, opener)
      }}
    >
      <SortIcon />
      <span>Sort</span>
    </button>
  )
})

export const SELECTION_BAR: readonly SelectionBarItemSpec[] = [
  {
    id: 'sort',
    // the arrange row (from 100): after align and distribute, next to "Arrange as grid"
    order: 210,
    visible: (ctx, selection) => !ctx.canvas.readOnly() && targetNotes(ctx.canvas, selection).length >= 2,
    component: () => <SortBarButton />,
  },
]
