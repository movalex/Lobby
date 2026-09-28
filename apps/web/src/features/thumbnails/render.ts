// Renders the board thumbnail (browser only). Areas with up to DETAILED_MAX_SHAPES shapes go through
// tldraw 5.4.2's export pipeline: `editor.getSvgString` with explicit `bounds` (exact area, no
// auto-trim), `scale` ≤ 1 and `pixelRatio: 1` (so assets resolve to screen-sized previews, never
// originals), light mode with the board background, then `getSvgAsImage`. Larger areas are drawn by
// schematic.ts, because the export's cost grows with every shape and runs on the main thread. Either
// way the picture is made once and encoded as WebP, PNG where the browser cannot encode WebP (Safari's
// canvas falls back to PNG), or JPEG when those are over the size target.
//
// Keeping it cheap: plan.ts picks the area and only shapes inside it are drawn, and the work starts in
// an idle period while the person is not in the middle of something (re-checked right before it starts).

import { THUMBNAIL_MIME_TYPES, THUMBNAIL_TARGET_BYTES, type ThumbnailMimeType } from '@draftroom/contracts'
import { Box, type Editor, getSvgAsImage, type TLPageId, type TLShapeId } from 'tldraw'
import { parseBoardStartView } from '../canvas-ux/board-start-view.ts'
import { stripNoteAuthors } from '../present-export/note-authors.ts'
import {
  chooseArea,
  intersects,
  type Rect,
  rendererFor,
  type ThumbnailFrame,
  thumbnailFrame,
} from './plan.ts'
import type { RenderResult } from './scheduler.ts'
import { renderSchematic } from './schematic.ts'

const ENCODINGS: readonly { type: 'webp' | 'jpeg'; quality: number }[] = [
  { type: 'webp', quality: 0.82 },
  { type: 'jpeg', quality: 0.8 },
  { type: 'jpeg', quality: 0.6 },
]

const toRect = (b: { x: number; y: number; w: number; h: number }): Rect => ({
  x: b.x,
  y: b.y,
  w: b.w,
  h: b.h,
})

/** The page's visible top-level shapes and the union of their bounds. */
function pageContent(editor: Editor, pageId: TLPageId) {
  const ids: TLShapeId[] = []
  let bounds: Box | null = null
  for (const id of editor.getSortedChildIdsForParent(pageId)) {
    if (editor.isShapeHidden(id)) continue
    const b = editor.getShapeMaskedPageBounds(id)
    if (!b) continue
    ids.push(id)
    bounds = bounds ? bounds.union(b) : b.clone()
  }
  return { ids, bounds }
}

/** Whether the board has anything a thumbnail could show (any page). */
export function boardHasContent(editor: Editor): boolean {
  return editor.getPages().some((p) => pageContent(editor, p.id).bounds !== null)
}

/**
 * The person is in the middle of something: dragging, panning, a moving camera, editing text or typing
 * in a field, a menu or dialog open (an export, the share dialog, a context menu), or presenting.
 * (capture.ts adds "any pointer, key or wheel input in the last few seconds".)
 */
export function isBusy(editor: Editor): boolean {
  const i = editor.inputs
  if (i.getIsDragging() || i.getIsPointing() || i.getIsPanning()) return true
  if (editor.getCameraState() === 'moving' || editor.getEditingShapeId() !== null) return true
  if (editor.menus.hasOpenMenus()) return true
  if (typeof document === 'undefined') return false
  if (document.querySelector('dialog[open]') !== null) return true
  if (document.documentElement.hasAttribute('data-dr-presenting')) return true
  const a = document.activeElement
  return (
    a instanceof HTMLElement && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)
  )
}

type Plan =
  | { kind: 'empty' }
  | { kind: 'too-many' }
  | {
      kind: 'draw'
      ids: TLShapeId[]
      frame: ThumbnailFrame
      renderer: 'detailed' | 'schematic'
      shapeCount: number
    }

export function planThumbnail(editor: Editor): Plan {
  const view = parseBoardStartView(editor.getDocumentSettings().meta)
  let startFrame: Rect | null = null
  if (view?.frameId) {
    const frame = editor.getShape(view.frameId as TLShapeId)
    const b =
      frame?.type === 'frame' && editor.getAncestorPageId(frame) === view.pageId
        ? editor.getShapePageBounds(frame)
        : undefined
    if (b) startFrame = toRect(b)
  }
  const pages = editor.getPages().map((p) => ({ page: p.id, content: pageContent(editor, p.id) }))
  const choice = chooseArea({
    startView: view ? { pageId: view.pageId, area: { x: view.x, y: view.y, w: view.w, h: view.h } } : null,
    startFrame,
    pages: pages.map((p) => ({ pageId: p.page, bounds: p.content.bounds ? toRect(p.content.bounds) : null })),
  })
  if (choice.kind === 'empty') return { kind: 'empty' }
  const frame = thumbnailFrame(choice.area)
  const page = pages.find((p) => p.page === choice.pageId)
  if (!frame || !page) return { kind: 'empty' }
  // Only what shows inside the area is drawn (a start view over part of a big board stays cheap).
  const ids = page.content.ids.filter((id) => {
    const b = editor.getShapeMaskedPageBounds(id)
    return b ? intersects(toRect(b), frame.box) : false
  })
  if (!ids.length) return { kind: 'empty' }
  const shapeCount = editor.getShapeAndDescendantIds(ids).size
  const renderer = rendererFor(shapeCount)
  if (!renderer) return { kind: 'too-many' }
  return { kind: 'draw', ids, frame, renderer, shapeCount }
}

/** Waits for an idle period (or a short timeout where requestIdleCallback does not exist). */
function idle(timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => resolve(), { timeout: timeoutMs })
    else setTimeout(resolve, 50)
  })
}

const isAccepted = (t: string): t is ThumbnailMimeType =>
  (THUMBNAIL_MIME_TYPES as readonly string[]).includes(t)

/**
 * `force`: render now (the tab is being hidden). Otherwise wait for an idle period and give up with
 * 'busy' if `busy()` says the person is in the middle of something by then.
 */
export async function renderThumbnail(
  editor: Editor,
  opts: { force: boolean; busy?: () => boolean },
): Promise<RenderResult> {
  if (!opts.force) {
    await idle()
    if ((opts.busy ?? (() => isBusy(editor)))()) return { kind: 'busy' }
  }
  const plan = planThumbnail(editor)
  if (plan.kind === 'empty') return { kind: 'empty' }
  if (plan.kind === 'too-many') return { kind: 'skipped' }
  const { width, height } = plan.frame
  const encode =
    plan.renderer === 'detailed'
      ? await detailed(editor, plan.ids, plan.frame)
      : await schematic(editor, plan.ids, plan.frame)
  if (!encode) return { kind: 'empty' }
  // WebP first; where the browser cannot encode it (Safari) the canvas hands back PNG, which is fine
  // too unless it is over the size target; then JPEG.
  for (const enc of ENCODINGS) {
    const blob = await encode(enc)
    if (!blob || !isAccepted(blob.type)) continue
    if (blob.size <= THUMBNAIL_TARGET_BYTES)
      return { kind: 'image', blob, type: blob.type, width, height, renderer: plan.renderer }
  }
  return { kind: 'skipped' }
}

type Encoder = (enc: { type: 'webp' | 'jpeg'; quality: number }) => Promise<Blob | null>

/** tldraw's own export: exact rendering, text included (small areas only, see DETAILED_MAX_SHAPES). */
async function detailed(editor: Editor, ids: TLShapeId[], frame: ThumbnailFrame): Promise<Encoder | null> {
  const { box, scale, width, height } = frame
  // tldraw's export focuses document.body on the way ("weird but necessary"): give focus back to
  // whatever had it (the canvas, for keyboard shortcuts), so a capture never changes what the keys do.
  const focused = typeof document === 'undefined' ? null : document.activeElement
  let svg: Awaited<ReturnType<Editor['getSvgString']>>
  try {
    svg = await editor.getSvgString(ids, {
      bounds: new Box(box.x, box.y, box.w, box.h),
      scale,
      pixelRatio: 1,
      background: true,
      darkMode: false,
    })
  } finally {
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused)
      focused.focus({ preventScroll: true })
  }
  if (!svg) return null
  // Names never go onto the dashboard card (like "Hide note authors"); at card size they are noise.
  const markup = stripNoteAuthors(svg.svg)
  return (enc) => getSvgAsImage(markup, { ...enc, width, height, pixelRatio: 1 })
}

/** The simplified drawing (schematic.ts) for larger areas: a few milliseconds whatever the size. */
async function schematic(editor: Editor, ids: TLShapeId[], frame: ThumbnailFrame): Promise<Encoder | null> {
  const canvas = await renderSchematic(editor, ids, frame)
  if (!canvas) return null
  return (enc) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, `image/${enc.type}`, enc.quality))
}
