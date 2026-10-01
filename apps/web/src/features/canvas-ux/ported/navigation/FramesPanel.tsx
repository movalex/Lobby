// MAK-13 frame outline on the new canvas (dock panel `frames`): every frame by name in presentation order
// (frames never nest on the new canvas). Click → the camera fits the frame, heading included, clear of the
// chrome, never past 100% (PRI-10), without selecting it (DANA2-03; a second click on the row selects it);
// Shift/Ctrl/Cmd-click adds the frame to the selection or takes it out (F12). Drag (or the ↑/↓ buttons, or
// Alt+↑/↓ on a focused row) reorders; the order is written as `customData.lobby.present.index` on the
// frames in one undo step, so every collaborator sees it through sync. "Auto-order" returns to layout
// order (rows, then left to right), also one undo step. "Skip" writes `present.skip`. A frame whose name
// starts with a number shows no row number of its own (F20).
//
// The server refuses `customData` writes on a locked element (LOCKED), so a locked frame keeps its own
// place and skip mark: its row cannot be reordered or skipped, and a reorder of the others leaves it out.
import { type DragEvent, type KeyboardEvent, type MouseEvent, useMemo, useState } from 'react'
import { isReadonlyRole } from '../../../../board/access.ts'
import { type CanvasFeatureContext, geometry, type LobbyCanvas } from '../../../../canvas/api/index.ts'
import { useValue } from '../../../../lib/signals.ts'
import { moveItem, rowNumberLabel, toggleInSelection } from '../../frame-order.ts'
import { ArrowDownIcon, ArrowUpIcon, DragHandleIcon, EyeOffIcon, LinkIcon } from '../../icons.tsx'
import { goToFrameCamera } from './camera.ts'
import { copySelectionLink } from './copy-link.ts'
import { type FrameRow, frameRows } from './model.ts'
import { lastFrameJump } from './state.ts'

/** A frame's `present` value after a patch (null removes the key: no index and not skipped). */
function presentWith(
  row: FrameRow,
  patch: { index?: number | null; skip?: boolean },
): { index?: number; skip?: boolean } | null {
  const index = patch.index === undefined ? row.presentIndex : patch.index
  const skip = patch.skip === undefined ? row.skip : patch.skip
  const out: { index?: number; skip?: boolean } = {}
  if (typeof index === 'number') out.index = index
  if (skip) out.skip = true
  return Object.keys(out).length ? out : null
}

/** The present-value writes that make `orderedIds` the explicit order (unchanged and locked frames get none). */
export function presentOrderWrites(
  rows: readonly FrameRow[],
  orderedIds: readonly string[],
): { id: string; present: { index?: number; skip?: boolean } | null }[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: { id: string; present: { index?: number; skip?: boolean } | null }[] = []
  orderedIds.forEach((id, index) => {
    const row = byId.get(id)
    if (!row || row.locked || row.presentIndex === index) return
    out.push({ id, present: presentWith(row, { index }) })
  })
  return out
}

/** "Auto-order": every explicit index cleared (the order follows the layout again). */
export function autoOrderWrites(rows: readonly FrameRow[]) {
  return rows
    .filter((r) => r.presentIndex !== null && !r.locked)
    .map((r) => ({ id: r.id, present: presentWith(r, { index: null }) }))
}

function applyWrites(
  canvas: LobbyCanvas,
  writes: readonly { id: string; present: { index?: number; skip?: boolean } | null }[],
  label: string,
) {
  if (!writes.length) return
  canvas.transact(label, (tx) => {
    for (const w of writes) tx.update(w.id, { customData: { lobby: { present: w.present } } })
  })
}

/**
 * Goes to the frame without selecting it (DANA2-03): with the frame selected, the next drag inside it (a
 * box-select over its notes) moved the whole frame onto its neighbour. The selection is cleared too.
 */
function goToFrame(canvas: LobbyCanvas, id: string) {
  canvas.select([])
  lastFrameJump(canvas).set(id)
  goToFrameCamera(canvas, id)
}

/** Row click: go to the frame; a second click once it is in view selects it. Shift/Ctrl/Cmd toggles it in the selection. */
function onFrameClick(canvas: LobbyCanvas, id: string, e: MouseEvent) {
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    e.preventDefault()
    canvas.select(toggleInSelection(canvas.selection, id))
    return
  }
  const b = canvas.bounds(id)
  const v = canvas.viewport.get()
  if (b && lastFrameJump(canvas).get() === id && geometry.containsRect(v, b)) {
    canvas.select([id])
    return
  }
  goToFrame(canvas, id)
}

export function FramesPanel({ ctx }: { ctx: CanvasFeatureContext; close(): void }) {
  const { canvas } = ctx
  const canEdit = !isReadonlyRole(ctx.role, ctx.board.status)
  const key = useValue('nav-frame-outline', () => JSON.stringify(frameRows(canvas.items())), [canvas])
  const rows = useMemo(() => JSON.parse(key) as FrameRow[], [key])
  const selected = useValue('nav-selected-ids', () => canvas.selection.join(','), [canvas])
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const manual = rows.some((r) => r.presentIndex !== null)

  const reorder = (from: number, to: number) => {
    if (!canEdit || from === to) return
    const ids = moveItem(
      rows.map((r) => r.id),
      from,
      to,
    )
    applyWrites(canvas, presentOrderWrites(rows, ids), 'reorder frames')
  }

  const onRowKeyDown = (e: KeyboardEvent, index: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    e.stopPropagation()
    reorder(index, e.key === 'ArrowUp' ? index - 1 : index + 1)
  }

  const onDragOver = (e: DragEvent, index: number) => {
    if (dragFrom === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDropAt(e.clientY < rect.top + rect.height / 2 ? index : index + 1)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    if (dragFrom !== null && dropAt !== null) reorder(dragFrom, dropAt > dragFrom ? dropAt - 1 : dropAt)
    setDragFrom(null)
    setDropAt(null)
  }

  if (!rows.length) {
    return (
      <div className="dr-cux-empty" data-testid="frame-outline">
        <p>No frames yet.</p>
        <p className="dr-cux-muted">
          Press <kbd>F</kbd> and click or drag on the board to add a frame, or select content and press{' '}
          <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>. Frames become the slides of a presentation.
        </p>
      </div>
    )
  }

  return (
    <div className="dr-cux-frames" data-testid="frame-outline">
      <div className="dr-cux-frames__bar">
        <span className="dr-cux-muted" data-testid="frames-order-mode">
          {manual ? 'Custom order' : 'Order follows the layout'}
        </span>
        {canEdit && (
          <button
            type="button"
            className="dr-btn dr-btn--ghost"
            data-testid="frames-auto-order"
            disabled={!manual}
            title="Sort frames left to right, then top to bottom (undo restores your order)"
            onClick={() => applyWrites(canvas, autoOrderWrites(rows), 'auto-order frames')}
          >
            Auto-order
          </button>
        )}
      </div>
      <ol
        className="dr-cux-frames__list"
        aria-label="Frames in presentation order"
        onDragLeave={() => setDropAt(null)}
      >
        {rows.map((row, index) => {
          const editable = canEdit && !row.locked
          const num = rowNumberLabel(row.name, index)
          return (
            <li
              key={row.id}
              className="dr-cux-frame"
              data-testid="frame-row"
              data-frame-id={row.id}
              data-skipped={row.skip ? 'true' : 'false'}
              data-locked={row.locked ? 'true' : undefined}
              data-selected={selected.split(',').includes(row.id) ? 'true' : 'false'}
              data-drop={
                dropAt === index
                  ? 'before'
                  : dropAt === index + 1 && index === rows.length - 1
                    ? 'after'
                    : undefined
              }
              draggable={editable}
              onDragStart={(e) => {
                setDragFrom(index)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', row.name)
              }}
              onDragEnd={() => {
                setDragFrom(null)
                setDropAt(null)
              }}
              onDragOver={(e) => onDragOver(e, index)}
              onDrop={onDrop}
            >
              <div className="dr-cux-frame__main">
                {editable && (
                  <span className="dr-cux-frame__handle" aria-hidden="true" title="Drag to reorder">
                    <DragHandleIcon />
                  </span>
                )}
                {num !== null && (
                  <span className="dr-cux-frame__num" aria-hidden="true">
                    {num}
                  </span>
                )}
                <button
                  type="button"
                  className="dr-cux-frame__name"
                  onClick={(e) => onFrameClick(canvas, row.id, e)}
                  onKeyDown={(e) => onRowKeyDown(e, index)}
                  aria-label={`${num === null ? '' : `${index + 1}. `}${row.name || 'Untitled frame'}${row.skip ? ' (skipped in presentation)' : ''}. Go to frame; click again to select it, Shift+click adds it to the selection${editable ? '; Alt+Up or Alt+Down to reorder' : ''}`}
                >
                  {row.name || <span className="dr-cux-muted">Untitled frame</span>}
                </button>
                <div className="dr-cux-frame__actions">
                  {editable && (
                    <>
                      <button
                        type="button"
                        className="dr-iconbtn dr-iconbtn--sm"
                        aria-label={`Move ${row.name || 'frame'} up`}
                        title="Move up"
                        disabled={index === 0}
                        onClick={() => reorder(index, index - 1)}
                      >
                        <ArrowUpIcon />
                      </button>
                      <button
                        type="button"
                        className="dr-iconbtn dr-iconbtn--sm"
                        aria-label={`Move ${row.name || 'frame'} down`}
                        title="Move down"
                        disabled={index === rows.length - 1}
                        onClick={() => reorder(index, index + 1)}
                      >
                        <ArrowDownIcon />
                      </button>
                      <button
                        type="button"
                        className="dr-iconbtn dr-iconbtn--sm"
                        data-testid="frame-skip"
                        aria-pressed={row.skip}
                        aria-label={`${row.skip ? 'Include' : 'Skip'} ${row.name || 'frame'} in presentation`}
                        title={
                          row.skip ? 'Skipped in presentation (click to include)' : 'Skip in presentation'
                        }
                        onClick={() =>
                          applyWrites(
                            canvas,
                            [{ id: row.id, present: presentWith(row, { skip: !row.skip }) }],
                            'skip frame',
                          )
                        }
                      >
                        <EyeOffIcon />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="dr-iconbtn dr-iconbtn--sm"
                    data-testid="frame-copy-link"
                    aria-label={`Copy link to ${row.name || 'frame'}`}
                    title="Copy link to frame"
                    onClick={() => void copySelectionLink(ctx, [row.id])}
                  >
                    <LinkIcon />
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      {canEdit && (
        <p className="dr-cux-muted dr-cux-hint">
          Drag frames (or use Alt+↑/↓) to set the presentation order. Shift+click a frame to select several.
        </p>
      )}
    </div>
  )
}
