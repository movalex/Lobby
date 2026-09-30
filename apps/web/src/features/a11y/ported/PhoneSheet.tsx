// OWNER: 3i. The `phoneSheet` host slot (docs/EXCALIDRAW-CONTRACTS.md §3; docs/EXCALIDRAW-MIGRATION.md §4.8
// "phone sheet"; spike B's `sheet` slot, B12): on a phone-width board (600 px and less, the dock's own phone
// breakpoint) one "Board actions" button opens a bottom sheet with the tools this role may use (Lobby's
// built-in ones and every feature tool with a toolbar entry: comment, vote, …), Undo / Redo and Zoom to fit.
// It stands in for tldraw's own phone toolbar, which Lobby does not have on the new canvas (`ui={false}`).
//
// Keyboard and touch: the button and every row are at least 44 px; Escape or Close shuts the sheet and gives
// the keyboard back to the button; a press outside it shuts it too; picking a tool shuts it and hands the
// keyboard to the board. Nothing renders on wider screens.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasFeatureContext, FeatureToolSpec } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'

/** The phone breakpoint (styles.css: the dock rail folds and panels become sheets below it). */
export const PHONE_QUERY = '(max-width: 600px)'

function usePhone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(PHONE_QUERY)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  )
}

interface ToolRow {
  readonly id: string
  readonly label: string
}

/** Lobby's built-in tools in toolbar order (COL-07's main tools, then the ones in "More"). */
const EDIT_TOOLS: readonly ToolRow[] = [
  { id: 'select', label: 'Select' },
  { id: 'hand', label: 'Hand' },
  { id: 'note', label: 'Note' },
  { id: 'text', label: 'Text' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'freedraw', label: 'Pen' },
  { id: 'arrow', label: 'Connector' },
  { id: 'frame', label: 'Frame' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'line', label: 'Line' },
  { id: 'highlight', label: 'Highlight' },
  { id: 'eraser', label: 'Eraser' },
  { id: 'laser', label: 'Laser' },
]
/** What a read-only role (commenter, viewer, a limited guest) may pick. */
const READONLY_TOOLS: readonly ToolRow[] = [
  { id: 'select', label: 'Select' },
  { id: 'hand', label: 'Hand' },
  { id: 'laser', label: 'Laser' },
]

/** The rows of the Tools section for this role: built-in tools, then the features' toolbar tools. */
export function sheetTools(readOnly: boolean, featureTools: readonly FeatureToolSpec[]): ToolRow[] {
  const own = featureTools
    .filter((t) => t.toolbar && (!readOnly || t.readOnlyAllowed))
    .sort(
      (a, b) =>
        (a.toolbar?.group === b.toolbar?.group ? 0 : a.toolbar?.group === 'main' ? -1 : 1) ||
        (a.toolbar?.order ?? 0) - (b.toolbar?.order ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .map((t) => ({ id: t.id, label: t.label }))
  return [...(readOnly ? READONLY_TOOLS : EDIT_TOOLS), ...own]
}

export function PhoneSheet({ ctx }: { readonly ctx: CanvasFeatureContext }) {
  const phone = usePhone()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!phone) setOpen(false)
  }, [phone])
  if (!phone) return null
  return <Sheet ctx={ctx} open={open} setOpen={setOpen} />
}

function Sheet({
  ctx,
  open,
  setOpen,
}: {
  ctx: CanvasFeatureContext
  open: boolean
  setOpen(open: boolean): void
}) {
  const canvas = ctx.canvas
  const sheetId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const readOnly = useValue('a11y.sheet-readonly', () => canvas.readOnly(), [canvas])
  const current = useValue('a11y.sheet-tool', () => canvas.tool(), [canvas])
  const canUndo = useValue('a11y.sheet-undo', () => !canvas.readOnly() && canvas.history.canUndo(), [canvas])
  const canRedo = useValue('a11y.sheet-redo', () => !canvas.readOnly() && canvas.history.canRedo(), [canvas])
  const tools = sheetTools(readOnly, ctx.registries.tools.list())

  // opening puts the keyboard on the first row; a press outside the sheet (and its button) shuts it
  useEffect(() => {
    if (!open) return
    sheetRef.current?.querySelector<HTMLElement>('[data-sheet-row]')?.focus({ preventScroll: true })
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (sheetRef.current?.contains(t) || toggleRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, setOpen])

  const shut = (to: 'button' | 'board') => {
    setOpen(false)
    if (to === 'board') canvas.focus({ preventScroll: true })
    else toggleRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="dr-a11y-sheet-root">
      <button
        ref={toggleRef}
        type="button"
        className="dr-a11y-sheet__toggle"
        data-testid="phone-sheet-open"
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        aria-label="Board actions"
        title="Board actions"
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <div
          ref={sheetRef}
          id={sheetId}
          className="dr-a11y-sheet"
          data-testid="phone-sheet"
          role="dialog"
          aria-label="Board actions"
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return
            e.preventDefault()
            e.stopPropagation()
            shut('button')
          }}
        >
          <header className="dr-a11y-sheet__head">
            <h2>Board actions</h2>
            <button
              type="button"
              className="dr-iconbtn dr-a11y-sheet__close"
              data-testid="phone-sheet-close"
              aria-label="Close board actions"
              onClick={() => shut('button')}
            >
              ×
            </button>
          </header>
          <section aria-label="Tools">
            <h3 className="dr-a11y-sheet__caption">Tools</h3>
            <div className="dr-a11y-sheet__grid">
              {tools.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="dr-a11y-sheet__row"
                  data-sheet-row=""
                  data-testid="phone-sheet-tool"
                  data-tool={t.id}
                  aria-pressed={current === t.id}
                  onClick={() => {
                    canvas.setTool(t.id)
                    shut('board')
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>
          <section aria-label="Edit and view">
            <h3 className="dr-a11y-sheet__caption">Board</h3>
            <div className="dr-a11y-sheet__grid">
              {readOnly ? null : (
                <>
                  <button
                    type="button"
                    className="dr-a11y-sheet__row"
                    data-sheet-row=""
                    data-testid="phone-sheet-undo"
                    disabled={!canUndo}
                    onClick={() => canvas.history.undo()}
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    className="dr-a11y-sheet__row"
                    data-sheet-row=""
                    data-testid="phone-sheet-redo"
                    disabled={!canRedo}
                    onClick={() => canvas.history.redo()}
                  >
                    Redo
                  </button>
                </>
              )}
              <button
                type="button"
                className="dr-a11y-sheet__row"
                data-sheet-row=""
                data-testid="phone-sheet-fit"
                onClick={() => {
                  canvas.viewport.fit(undefined, { animate: true })
                  shut('board')
                }}
              >
                Zoom to fit
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
