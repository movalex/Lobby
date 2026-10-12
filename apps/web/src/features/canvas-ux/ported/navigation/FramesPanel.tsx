// MAK-13 frame outline on the new canvas (dock panel `frames`): every frame by name in presentation order
// (frames never nest on the new canvas). Click → the camera fits the frame, heading included, clear of the
// chrome, never past 100% (PRI-10), without selecting it (DANA2-03; a second click on the row selects it);
// Shift/Ctrl/Cmd-click adds the frame to the selection or takes it out (F12). Drag (or the ↑/↓ buttons, or
// Alt+↑/↓ on a focused row) reorders; the order is written as `customData.lobby.present.index` on the
// frames in one undo step, so every collaborator sees it through sync. "Auto-order" returns to layout
// order (rows, then left to right), also one undo step. "Skip" writes `present.skip`. A frame whose name
// starts with a number shows no row number of its own (F20).
//
// A locked frame (a template's slide) still takes `present` from an account (CR-3b-4: the registry's
// `lockExempt`, canvas-schema custom-data.ts): the facilitator reorders and skips locked slides. A name-only
// guest can neither lock nor unlock, and the room refuses its `present` on a locked frame (LOCKED), so for a
// guest a locked frame keeps its place and skip mark: its row cannot be reordered or skipped, and a reorder of
// the others leaves it out.
//
// Wave L (L5-1 run of show): each row also plans minutes for its section (`present.mins`, a stepper under the
// name). `present` is a whole-value key, so EVERY write of it carries index, skip and mins together
// (`presentWith`): reordering or skipping never drops the minutes. The stepper shows only in a room whose
// `contracts` frame says PRESENT_MINS_REV (12) or more (`canvas.room.contractsRev()`): a web deployed before
// the sync would otherwise send a field the older room refuses. One press is one canvas.transact (one undo step).
import { PRESENT_MINS_REV } from '@draftroom/canvas-schema/protocol'
import { type DragEvent, type KeyboardEvent, type MouseEvent, useMemo, useState } from 'react'
import { isReadonlyRole } from '../../../../board/access.ts'
import { type CanvasFeatureContext, geometry, type LobbyCanvas } from '../../../../canvas/api/index.ts'
import { knownUserKind, useUserKind } from '../../../../invite/guest.tsx'
import { useValue } from '../../../../lib/signals.ts'
import { countUsage } from '../../../../lib/usage.ts'
import { stepMins } from '../../../present-export/live/agenda.ts'
import { moveItem, rowNumberLabel, toggleInSelection } from '../../frame-order.ts'
import { ArrowDownIcon, ArrowUpIcon, DragHandleIcon, EyeOffIcon, LinkIcon } from '../../icons.tsx'
import { goToFrameCamera } from './camera.ts'
import { copySelectionLink } from './copy-link.ts'
import { type FrameRow, frameRows } from './model.ts'
import { lastFrameJump } from './state.ts'

/** A frame's `present` value: its place, whether it is skipped and the minutes planned for its section. */
export interface PresentPatch {
  index?: number
  skip?: boolean
  mins?: number
}

/**
 * A frame's `present` value after a patch (null removes the key: no index, not skipped, no minutes). The key is
 * written whole, so what the patch does not name is carried over from the row.
 */
function presentWith(
  row: FrameRow,
  patch: { index?: number | null; skip?: boolean; mins?: number | null },
): PresentPatch | null {
  const index = patch.index === undefined ? row.presentIndex : patch.index
  const skip = patch.skip === undefined ? row.skip : patch.skip
  const mins = patch.mins === undefined ? row.mins : patch.mins
  const out: PresentPatch = {}
  if (typeof index === 'number') out.index = index
  if (skip) out.skip = true
  if (typeof mins === 'number') out.mins = mins
  return Object.keys(out).length ? out : null
}

/**
 * Whether this person's `present` writes reach a locked frame: an account's do, a name-only guest's never
 * (the room's rule, CR-3b-4).
 */
export interface FrameWriteOptions {
  readonly includeLocked?: boolean
}

/**
 * The present-value writes that make `orderedIds` the explicit order (unchanged frames get none, nor do
 * locked ones unless `includeLocked`).
 */
export function presentOrderWrites(
  rows: readonly FrameRow[],
  orderedIds: readonly string[],
  opts: FrameWriteOptions = {},
): { id: string; present: PresentPatch | null }[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: { id: string; present: PresentPatch | null }[] = []
  orderedIds.forEach((id, index) => {
    const row = byId.get(id)
    if (!row || (row.locked && !opts.includeLocked) || row.presentIndex === index) return
    out.push({ id, present: presentWith(row, { index }) })
  })
  return out
}

/** "Auto-order": every explicit index cleared (the order follows the layout again). */
export function autoOrderWrites(rows: readonly FrameRow[], opts: FrameWriteOptions = {}) {
  return rows
    .filter((r) => r.presentIndex !== null && (!r.locked || opts.includeLocked))
    .map((r) => ({ id: r.id, present: presentWith(r, { index: null }) }))
}

function applyWrites(
  canvas: LobbyCanvas,
  writes: readonly { id: string; present: PresentPatch | null }[],
  label: string,
) {
  if (!writes.length) return
  canvas.transact(label, (tx) => {
    for (const w of writes) tx.update(w.id, { customData: { lobby: { present: w.present } } })
  })
}

/**
 * L5-1: plans `mins` minutes (null: none) for a frame's section, keeping its place and skip mark, as one undo
 * step. Returns false (and writes nothing) when the row already has them.
 */
export function setMins(canvas: LobbyCanvas, row: FrameRow, mins: number | null): boolean {
  if (mins === row.mins) return false
  applyWrites(canvas, [{ id: row.id, present: presentWith(row, { mins }) }], 'set section minutes')
  // N1 (wave M follow-up 2): planning a section's time is setting the run of show (the event name only)
  countUsage('runofshow.set')
  return true
}

/** "5 min" / "No time planned" */
export const minsText = (mins: number | null) => (mins === null ? 'No time planned' : `${mins} min`)

/**
 * The minutes stepper under a frame's name: "+ minutes" until minutes are planned, then − 5 min +. Each press
 * is one write (`setMins`). Wave M (M1-6, FTU-10): it said "+ time", with no hint that it plans the presentation.
 */
export function MinsStepper({ canvas, row }: { canvas: LobbyCanvas; row: FrameRow }) {
  const label = row.name || 'frame'
  return (
    <div className="dr-ros-mins" data-testid="frame-mins-stepper" data-mins={row.mins ?? ''}>
      {row.mins === null ? (
        <button
          type="button"
          className="dr-ros-mins__add"
          data-testid="frame-mins-add"
          aria-label={`Plan minutes for ${label}`}
          title="Plan minutes for this section of the presentation"
          onClick={() => setMins(canvas, row, stepMins(row.mins, 1))}
        >
          + minutes
        </button>
      ) : (
        <>
          <button
            type="button"
            className="dr-iconbtn dr-iconbtn--sm"
            data-testid="frame-mins-down"
            aria-label={`Less time for ${label}`}
            onClick={() => setMins(canvas, row, stepMins(row.mins, -1))}
          >
            −
          </button>
          <span className="dr-ros-mins__value" data-testid="frame-mins" role="status">
            <span className="dr-sr-only">Planned time for {label}: </span>
            {minsText(row.mins)}
          </span>
          <button
            type="button"
            className="dr-iconbtn dr-iconbtn--sm"
            data-testid="frame-mins-up"
            aria-label={`More time for ${label}`}
            disabled={stepMins(row.mins, 1) === row.mins}
            onClick={() => setMins(canvas, row, stepMins(row.mins, 1))}
          >
            +
          </button>
        </>
      )}
    </div>
  )
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
  // CR-3b-4: an account orders and skips locked frames too; a name-only guest does not (the room refuses it)
  const guest = (useUserKind() ?? knownUserKind(ctx.me.user.id)) === 'guest'
  const writeOpts: FrameWriteOptions = { includeLocked: !guest }
  // L5-1: the minutes stepper needs a room that accepts `present.mins` (null: not known, so offer nothing)
  const room = useValue('nav-room-rev', () => canvas.room.contractsRev(), [canvas])
  const minsOk = (room ?? 0) >= PRESENT_MINS_REV
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
    applyWrites(canvas, presentOrderWrites(rows, ids, writeOpts), 'reorder frames')
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
            onClick={() => applyWrites(canvas, autoOrderWrites(rows, writeOpts), 'auto-order frames')}
          >
            Auto-order
          </button>
        )}
      </div>
      {/* wave M (M1-6, FTU-10): what "+ minutes" is for, once, where the stepper is offered */}
      {canEdit && minsOk && (
        <p className="dr-cux-muted dr-cux-hint" data-testid="frames-minutes-hint">
          Each frame is a section of the presentation: + minutes plans its time in the run of show.
        </p>
      )}
      <ol
        className="dr-cux-frames__list"
        aria-label="Frames in presentation order"
        onDragLeave={() => setDropAt(null)}
      >
        {rows.map((row, index) => {
          const editable = canEdit && (!row.locked || !guest)
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
              {/* L5-1: the section's planned time; plain text for people who cannot change it */}
              {editable && minsOk ? (
                <MinsStepper canvas={canvas} row={row} />
              ) : (
                row.mins !== null && (
                  <p className="dr-ros-mins dr-ros-mins--read" data-testid="frame-mins-read">
                    {minsText(row.mins)}
                  </p>
                )
              )}
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
