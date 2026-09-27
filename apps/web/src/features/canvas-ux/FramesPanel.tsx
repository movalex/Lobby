// MAK-13 frame outline (dock panel `frames`): every frame by name in presentation order (nested frames
// indented under their parent). Click → camera fits the frame, heading included, clear of the page bar,
// the bottom toolbar and the dock, never past 100% (PRI-10), and selects it; Shift/Ctrl/Cmd-click adds
// the frame to the selection or takes it out (F12), e.g. to export several frames. Drag (or the ↑/↓
// buttons, or Alt+↑/↓ on a focused row) reorders; the order is written as meta.presentationIndex on the
// frames in one undo step, so every collaborator sees it through sync. "Auto-order" returns to layout
// order (rows, then left to right), also one undo step. "Skip" writes meta.presentationSkip. A frame
// whose name starts with a number shows no row number of its own (F20).

import { type DragEvent, type KeyboardEvent, type MouseEvent, useMemo, useState } from 'react'
import { type Editor, type TLShape, type TLShapeId, useValue } from 'tldraw'
import { isReadonlyRole } from '../../board/access.ts'
import type { FeatureContext } from '../types.ts'
import { copySelectionLink } from './copy-link.ts'
import { frameOutline, presentationOrder } from './deps.ts'
import {
  autoOrderPatches,
  hasManualOrder,
  isSkipped,
  type MetaPatch,
  moveItem,
  presentationIndexPatches,
  rowNumberLabel,
  skipPatch,
  toggleInSelection,
} from './frame-order.ts'
import { ArrowDownIcon, ArrowUpIcon, DragHandleIcon, EyeOffIcon, LinkIcon } from './icons.tsx'
import { frameCamera, type Insets } from './placement.ts'

interface Row {
  id: string
  name: string
  depth: number
  skip: boolean
  children: { id: string; name: string; depth: number }[]
}
interface Model {
  rows: Row[]
  manual: boolean
}

function readModel(editor: Editor): Model {
  const pageId = editor.getCurrentPageId()
  const shapes = editor.getCurrentPageShapes()
  const frames = shapes.filter((s) => s.type === 'frame')
  if (!frames.length) return { rows: [], manual: false }
  // board-ops only needs the frames and their ancestors (for page-space bounds): keep the index small
  // on big boards, since this re-runs on every shape change while the panel is open.
  const needed = new Map<string, TLShape>()
  for (const f of frames) {
    let s: TLShape | undefined = f
    while (s && !needed.has(s.id)) {
      needed.set(s.id, s)
      s = s.parentId.startsWith('shape:') ? editor.getShape(s.parentId as TLShapeId) : undefined
    }
  }
  const subset = [...needed.values()]
  const outline = frameOutline(subset, pageId)
  const order = presentationOrder(subset, pageId)
  const byId = new Map(frames.map((f) => [f.id as string, f]))
  const nested = new Map<string, { id: string; name: string; depth: number }[]>()
  // Nested frames under their top-level ancestor, in outline (depth-first reading) order.
  let top: string | null = null
  for (const e of outline) {
    if (e.depth === 0) top = e.id
    else if (top) {
      const list = nested.get(top) ?? []
      list.push({ id: e.id, name: e.name, depth: e.depth })
      nested.set(top, list)
    }
  }
  return {
    rows: order.map((e) => ({
      id: e.id,
      name: e.name,
      depth: 0,
      skip: isSkipped(byId.get(e.id)?.meta),
      children: nested.get(e.id) ?? [],
    })),
    manual: hasManualOrder(frames.map((f) => ({ id: f.id, meta: f.meta }))),
  }
}

function applyPatches(editor: Editor, patches: MetaPatch[], label: string) {
  if (!patches.length) return
  editor.markHistoryStoppingPoint(label)
  // Presentation order is board-level metadata: locked frames are reordered too.
  editor.run(
    () =>
      editor.updateShapes(
        patches.map((p) => ({ id: p.id as TLShapeId, type: 'frame', meta: p.meta as never })),
      ),
    { ignoreShapeLock: true },
  )
}

/**
 * How much of the editor the UI covers on each side (screen px): the menu and page bar at the top, the
 * bottom row (navigation, toolbar), and the dock panel when it overlaps the canvas (narrow layouts).
 */
function uiInsets(editor: Editor): Insets {
  const container = editor.getContainer()
  const c = container.getBoundingClientRect()
  const rect = (el: Element | null) => {
    const r = el?.getBoundingClientRect()
    return r && r.width > 0 && r.height > 0 ? r : null
  }
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
  // The top-left column is as tall as the editor; its children (menu + page bar, helper buttons) are not.
  for (const el of container.querySelectorAll('.tlui-layout__top__left > *')) {
    const r = rect(el)
    if (r) insets.top = Math.max(insets.top, r.bottom - c.top)
  }
  let bottomEdge = c.bottom
  for (const el of container.querySelectorAll('.tlui-layout__bottom__main > *')) {
    const r = rect(el)
    if (r) bottomEdge = Math.min(bottomEdge, r.top)
  }
  insets.bottom = Math.max(0, c.bottom - bottomEdge)
  const dock = rect(container.ownerDocument.querySelector('.dr-dock'))
  if (dock && dock.right > c.left && dock.left < c.left + c.width / 2) {
    insets.left = Math.max(0, dock.right - c.left)
  }
  return insets
}

function goToFrame(editor: Editor, id: string) {
  const bounds = editor.getShapePageBounds(id as TLShapeId)
  if (!bounds) return
  editor.select(id as TLShapeId)
  const vp = editor.getViewportScreenBounds()
  const steps = editor.getCameraOptions().zoomSteps
  const camera = frameCamera(bounds, { w: vp.w, h: vp.h }, uiInsets(editor), {
    minZoom: steps[0],
    maxZoom: Math.min(1, steps[steps.length - 1] ?? 1),
  })
  if (camera) editor.setCamera(camera, { animation: { duration: 280 } })
  else editor.zoomToBounds(bounds, { targetZoom: 1, animation: { duration: 280 }, inset: 48 })
}

/** Row click: go to the frame; with Shift/Ctrl/Cmd, add it to (or take it out of) the selection. */
function onFrameClick(editor: Editor, id: string, e: MouseEvent) {
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    e.preventDefault()
    editor.setSelectedShapes(toggleInSelection(editor.getSelectedShapeIds(), id as TLShapeId))
    return
  }
  goToFrame(editor, id)
}

export function FramesPanel({ ctx }: { ctx: FeatureContext; close(): void }) {
  const editor = ctx.editor
  const canEdit = !isReadonlyRole(ctx.role, ctx.board.status)
  const key = useValue('dr-frame-outline', () => JSON.stringify(readModel(editor)), [editor])
  const model = useMemo(() => JSON.parse(key) as Model, [key])
  const selected = useValue('dr-selected-ids', () => editor.getSelectedShapeIds().join(','), [editor])
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  const frameMeta = () =>
    model.rows.map((r) => ({ id: r.id, meta: editor.getShape(r.id as TLShapeId)?.meta ?? {} }))

  const reorder = (from: number, to: number) => {
    if (!canEdit || from === to) return
    const ids = moveItem(
      model.rows.map((r) => r.id),
      from,
      to,
    )
    applyPatches(editor, presentationIndexPatches(ids, frameMeta()), 'reorder frames')
  }

  const onRowKeyDown = (e: KeyboardEvent, index: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    // tldraw binds Alt+↑/↓ to page switching on document.body: keep the key for this list.
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

  if (!model.rows.length) {
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
          {model.manual ? 'Custom order' : 'Order follows the layout'}
        </span>
        {canEdit && (
          <button
            type="button"
            className="dr-btn dr-btn--ghost"
            data-testid="frames-auto-order"
            disabled={!model.manual}
            title="Sort frames left to right, then top to bottom (undo restores your order)"
            onClick={() => applyPatches(editor, autoOrderPatches(frameMeta()), 'auto-order frames')}
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
        {model.rows.map((row, index) => (
          <li
            key={row.id}
            className="dr-cux-frame"
            data-testid="frame-row"
            data-frame-id={row.id}
            data-skipped={row.skip ? 'true' : 'false'}
            data-selected={selected.split(',').includes(row.id) ? 'true' : 'false'}
            data-drop={
              dropAt === index
                ? 'before'
                : dropAt === index + 1 && index === model.rows.length - 1
                  ? 'after'
                  : undefined
            }
            draggable={canEdit}
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
              {canEdit && (
                <span className="dr-cux-frame__handle" aria-hidden="true" title="Drag to reorder">
                  <DragHandleIcon />
                </span>
              )}
              {rowNumberLabel(row.name, index) !== null && (
                <span className="dr-cux-frame__num" aria-hidden="true">
                  {rowNumberLabel(row.name, index)}
                </span>
              )}
              <button
                type="button"
                className="dr-cux-frame__name"
                onClick={(e) => onFrameClick(editor, row.id, e)}
                onKeyDown={(e) => onRowKeyDown(e, index)}
                aria-label={`${rowNumberLabel(row.name, index) === null ? '' : `${index + 1}. `}${row.name || 'Untitled frame'}${row.skip ? ' (skipped in presentation)' : ''}. Go to frame; Shift+click adds it to the selection${canEdit ? '; Alt+Up or Alt+Down to reorder' : ''}`}
              >
                {row.name || <span className="dr-cux-muted">Untitled frame</span>}
              </button>
              <div className="dr-cux-frame__actions">
                {canEdit && (
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
                      disabled={index === model.rows.length - 1}
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
                      title={row.skip ? 'Skipped in presentation (click to include)' : 'Skip in presentation'}
                      onClick={() => {
                        const shape = editor.getShape(row.id as TLShapeId)
                        const patch = shape ? skipPatch({ id: row.id, meta: shape.meta }, !row.skip) : null
                        if (patch) applyPatches(editor, [patch], 'skip frame')
                      }}
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
                  onClick={() => void copySelectionLink(editor, [row.id as TLShapeId])}
                >
                  <LinkIcon />
                </button>
              </div>
            </div>
            {row.children.length > 0 && (
              <ul className="dr-cux-frame__children">
                {row.children.map((c) => (
                  <li key={c.id} style={{ paddingLeft: `${(c.depth - 1) * 12}px` }}>
                    <button
                      type="button"
                      className="dr-cux-frame__child"
                      data-testid="frame-row"
                      data-frame-id={c.id}
                      data-nested="true"
                      data-selected={selected.split(',').includes(c.id) ? 'true' : 'false'}
                      onClick={(e) => onFrameClick(editor, c.id, e)}
                    >
                      {c.name || 'Untitled frame'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {canEdit && (
        <p className="dr-cux-muted dr-cux-hint">
          Drag frames (or use Alt+↑/↓) to set the presentation order. Shift+click a frame to select several.
        </p>
      )}
    </div>
  )
}
