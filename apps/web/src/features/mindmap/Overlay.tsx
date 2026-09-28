// Mind-map overlays, rendered as a child of <Tldraw> (viewport coordinates, relative to the editor):
//  - TopicBar: above the one selected topic: add child (Tab), add sibling (Enter), move up a level
//    (Shift+Tab), collapse/expand, Tidy up and the outline menu. Read-only people get the outline only.
//  - CollapsedBadges: "+N" at the edge of every collapsed topic on screen; a click expands it (editors).
//  - DeleteConfirm: "Delete 14 topics?" before a big branch goes.
//  - a polite status line for screen readers.
// Every reactive read is narrow (tldraw useValue): the selection, one topic's bounds, the camera and the
// index's structure version; nothing here runs per store change.

import { MINDMAP_MAX_DEPTH, type MindmapSide } from '@draftroom/contracts'
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { type Editor, type TLShapeId, useEditor, useValue } from 'tldraw'
import { isReadonlyRole } from '../../board/access.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { exportAllowed } from '../sharing/export-policy.ts'
import type { FeatureContext } from '../types.ts'
import { getRuntime, setMindmapCtx } from './bridge.ts'
import {
  addChildTopic,
  addSiblingTopic,
  copyOutline,
  downloadOutline,
  promoteTopic,
  tidyMindmap,
  toggleTopicCollapsed,
} from './commands.ts'
import {
  AddChildIcon,
  AddSiblingIcon,
  ChevronIcon,
  CollapseIcon,
  ExpandIcon,
  OutlineIcon,
  TidyIcon,
} from './icons.tsx'
import type { MindmapRuntime } from './runtime.ts'
import './mindmap.css'

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const UNDO_KEYS = IS_MAC ? 'Cmd+Z' : 'Ctrl+Z'

/**
 * Keeps keys and pointers inside our floating UI away from tldraw's container/body listeners (native,
 * bubble phase, which run before React's root listener). With `keepCanvasFocus`, a mouse press does
 * not take the focus off the board (Ctrl+Z, Tab and Delete keep working after a click).
 */
function useIsland<T extends HTMLElement>(opts: { onEscape?: () => void; keepCanvasFocus?: boolean } = {}) {
  const ref = useRef<T>(null)
  const escapeRef = useRef(opts.onEscape)
  escapeRef.current = opts.onEscape
  const keepFocus = opts.keepCanvasFocus === true
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    const onDown = (e: Event) => {
      e.stopPropagation()
      if (keepFocus) e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape' && escapeRef.current) {
        e.preventDefault()
        escapeRef.current()
      }
    }
    el.addEventListener('keydown', onKey)
    el.addEventListener('keyup', stop)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('mousedown', onDown)
    el.addEventListener('wheel', stop, { passive: true })
    return () => {
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('keyup', stop)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('mousedown', onDown)
      el.removeEventListener('wheel', stop)
    }
  })
  return ref
}

/** Effective side of a topic from the index (first-level topics carry it; deeper ones follow). */
function sideOf(rt: MindmapRuntime, id: TLShapeId): MindmapSide {
  let meta = rt.metaOf(id)
  for (let i = 0; meta && i <= MINDMAP_MAX_DEPTH; i++) {
    if (meta.parentId === null) return 'right'
    if (meta.parentId === meta.rootId) return meta.side
    meta = rt.metaOf(meta.parentId as TLShapeId)
  }
  return 'right'
}

function BarButton(props: {
  label: string
  testId: string
  onClick(): void
  children: ReactNode
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      className="dr-mm-bar__btn"
      aria-label={props.label}
      title={props.label}
      data-testid={props.testId}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function OutlineMenu({ editor, topicId }: { editor: Editor; topicId: TLShapeId }) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])
  const choose = (fn: () => unknown) => {
    setOpen(false)
    fn()
    editor.focus()
  }
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
      next?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      button.current?.focus()
    }
  }
  return (
    <span className="dr-mm-outline" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="dr-mm-bar__btn dr-mm-bar__btn--wide"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Mind map outline"
        title="Mind map outline"
        data-testid="mindmap-outline-button"
        onClick={() => setOpen((o) => !o)}
      >
        <OutlineIcon />
        <ChevronIcon />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Mind map outline"
          className="dr-mm-menu"
          data-testid="mindmap-outline-menu"
          onKeyDown={onMenuKey}
          tabIndex={-1}
        >
          <button
            type="button"
            role="menuitem"
            className="dr-mm-menu__item"
            data-testid="mindmap-copy-outline"
            onClick={() => choose(() => copyOutline(editor, topicId))}
          >
            Copy outline (Markdown)
          </button>
          <button
            type="button"
            role="menuitem"
            className="dr-mm-menu__item"
            data-testid="mindmap-download-md"
            onClick={() => choose(() => downloadOutline(editor, 'md', topicId))}
          >
            Download as Markdown
          </button>
          <button
            type="button"
            role="menuitem"
            className="dr-mm-menu__item"
            data-testid="mindmap-download-csv"
            onClick={() => choose(() => downloadOutline(editor, 'csv', topicId))}
          >
            Download as CSV
          </button>
        </div>
      )}
    </span>
  )
}

function TopicBar({ ctx }: { ctx: FeatureContext }) {
  const editor = useEditor()
  const ref = useIsland<HTMLDivElement>({ keepCanvasFocus: true })
  const canEdit = !isReadonlyRole(ctx.role, ctx.board.status)
  const state = useValue('dr-mindmap-bar', () => {
    const rt = getRuntime(editor)
    if (!rt) return null
    rt.index.version.get()
    const only = editor.getOnlySelectedShape()
    if (!only || !rt.isTopic(only.id)) return null
    if (!editor.isIn('select.idle') || editor.getEditingShapeId()) return null
    if (editor.getInstanceState().isFocusMode) return null
    const b = editor.getSelectionPageBounds()
    if (!b) return null
    const vp = editor.getViewportScreenBounds()
    const top = editor.pageToViewport({ x: b.midX, y: b.minY })
    const bottom = editor.pageToViewport({ x: b.midX, y: b.maxY })
    if (bottom.y < 0 || top.y > vp.h || bottom.x < -200 || bottom.x > vp.w + 200) return null
    // canvas-ux's selection bar sits below the selection, or above it when the selection is near
    // the bottom (its own rule): this bar goes above, and above that one when it moved up.
    const selbarAbove = bottom.y + 14 + 40 > vp.h - 100
    let y = top.y - 50 - (selbarAbove ? 50 : 0)
    if (y < 56) y = bottom.y + 14 + (selbarAbove ? 0 : 50)
    const meta = rt.metaOf(only.id)
    const kids = rt.index.children.get(only.id)?.size ?? 0
    const depth = meta?.parentId === null ? 0 : meta?.parentId === meta?.rootId ? 1 : 2
    return {
      id: only.id,
      cx: top.x,
      vw: vp.w,
      y,
      collapsed: !!meta?.collapsed,
      hasChildren: kids > 0,
      isRoot: depth === 0,
      canPromote: depth >= 2,
      exportOk: exportAllowed(editor),
    }
  }, [editor])
  const [halfWidth, setHalfWidth] = useState(120)
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth
    if (!w) return
    const half = Math.ceil(w / 2) + 8
    if (half !== halfWidth) setHalfWidth(half)
  })
  if (!state) return null
  if (!canEdit && !state.exportOk) return null
  const left = clamp(state.cx, halfWidth, Math.max(halfWidth, state.vw - halfWidth))
  const back = () => {
    if (ref.current?.contains(document.activeElement)) editor.focus()
  }
  return (
    <div
      ref={ref}
      className="dr-mm-bar"
      role="toolbar"
      aria-label="Mind map topic"
      data-testid="mindmap-bar"
      data-topic-id={state.id}
      style={{ left, top: state.y }}
    >
      {canEdit && (
        <>
          <BarButton
            label="Add child topic (Tab)"
            testId="mindmap-add-child"
            onClick={() => void addChildTopic(editor)}
          >
            <AddChildIcon />
          </BarButton>
          <BarButton
            label={state.isRoot ? 'Add branch (Enter)' : 'Add sibling topic (Enter)'}
            testId="mindmap-add-sibling"
            onClick={() => void addSiblingTopic(editor)}
          >
            <AddSiblingIcon />
          </BarButton>
          {state.canPromote && (
            <BarButton
              label="Move up a level (Shift+Tab)"
              testId="mindmap-promote"
              onClick={() => {
                promoteTopic(editor)
                back()
              }}
            >
              <span className="dr-mm-bar__glyph" aria-hidden="true">
                ⇤
              </span>
            </BarButton>
          )}
          {state.hasChildren && (
            <BarButton
              label={state.collapsed ? 'Expand branch' : 'Collapse branch'}
              testId="mindmap-toggle-collapsed"
              pressed={state.collapsed}
              onClick={() => {
                toggleTopicCollapsed(editor, state.id)
                back()
              }}
            >
              {state.collapsed ? <ExpandIcon /> : <CollapseIcon />}
            </BarButton>
          )}
          <span className="dr-mm-bar__sep" aria-hidden="true" />
          <BarButton
            label="Tidy up mind map"
            testId="mindmap-tidy"
            onClick={() => {
              tidyMindmap(editor)
              back()
            }}
          >
            <TidyIcon />
          </BarButton>
        </>
      )}
      {state.exportOk && <OutlineMenu editor={editor} topicId={state.id} />}
    </div>
  )
}

function CollapsedBadges({ ctx }: { ctx: FeatureContext }) {
  const editor = useEditor()
  const canEdit = !isReadonlyRole(ctx.role, ctx.board.status)
  const badges = useValue('dr-mindmap-badges', () => {
    const rt = getRuntime(editor)
    if (!rt) return []
    rt.index.version.get()
    const page = editor.getCurrentPageId()
    const vp = editor.getViewportScreenBounds()
    // Zoomed far out, the badge shrinks with the map (down to about half size) instead of covering it.
    const s = Math.round(clamp(editor.getZoomLevel(), 0.55, 1) * 100) / 100
    const out: { id: TLShapeId; x: number; y: number; n: number; side: MindmapSide; s: number }[] = []
    for (const id of rt.index.collapsed) {
      const n = rt.index.descendantCount(id)
      if (!n || editor.isShapeHidden(id)) continue
      // Only in a live map (a map whose central topic was deleted hides nothing).
      const rootId = rt.metaOf(id)?.rootId as TLShapeId | undefined
      if (!rootId || !editor.getShape(rootId) || rt.metaOf(rootId)?.parentId !== null) continue
      const shape = editor.getShape(id)
      if (!shape || editor.getAncestorPageId(shape) !== page) continue
      const b = editor.getShapePageBounds(id)
      if (!b) continue
      const side = sideOf(rt, id)
      const p = editor.pageToViewport({ x: side === 'right' ? b.maxX : b.minX, y: b.midY })
      if (p.x < -40 || p.y < -40 || p.x > vp.w + 40 || p.y > vp.h + 40) continue
      out.push({ id, x: p.x, y: p.y, n, side, s })
    }
    return out
  }, [editor])
  if (!badges.length) return null
  return (
    <>
      {badges.map((b) => (
        <button
          key={b.id}
          type="button"
          className={`dr-mm-badge dr-mm-badge--${b.side}`}
          style={{ left: b.x, top: b.y, ['--dr-mm-scale' as string]: b.s }}
          data-testid="mindmap-collapsed-badge"
          data-topic-id={b.id}
          data-count={b.n}
          disabled={!canEdit}
          aria-label={`Expand branch: ${b.n} hidden ${b.n === 1 ? 'topic' : 'topics'}`}
          title={canEdit ? `Expand (${b.n} hidden)` : `${b.n} hidden`}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          onClick={() => {
            const rt = getRuntime(editor)
            if (rt?.toggleCollapsed(b.id, false)) editor.select(b.id)
            editor.focus()
          }}
        >
          +{b.n}
        </button>
      ))}
    </>
  )
}

function DeleteConfirm() {
  const editor = useEditor()
  const plan = useValue('dr-mindmap-pending-delete', () => getRuntime(editor)?.pendingDelete.get() ?? null, [
    editor,
  ])
  if (!plan) return null
  const rt = getRuntime(editor)
  const close = () => {
    rt?.pendingDelete.set(null)
    editor.focus()
  }
  return (
    <Dialog
      title={`Delete ${plan.topics} topics?`}
      description={
        plan.wholeMap
          ? `This deletes the whole mind map. Undo (${UNDO_KEYS}) brings it back.`
          : `This deletes the topic and everything under it, collapsed topics included. Undo (${UNDO_KEYS}) brings it back.`
      }
      onClose={close}
      testId="mindmap-delete-dialog"
    >
      <div className="dr-dialog__actions">
        <button type="button" className="dr-btn" data-testid="mindmap-delete-cancel" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="dr-btn dr-mm-danger"
          data-testid="mindmap-delete-confirm"
          // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this one decision (Esc cancels)
          autoFocus
          onClick={() => {
            rt?.pendingDelete.set(null)
            rt?.runDelete(plan)
            editor.focus()
          }}
        >
          Delete {plan.topics} topics
        </button>
      </div>
    </Dialog>
  )
}

function Status() {
  const editor = useEditor()
  const status = useValue('dr-mindmap-status', () => getRuntime(editor)?.status.get() ?? null, [editor])
  return (
    <div className="dr-sr-only" role="status" aria-live="polite" data-testid="mindmap-status">
      {status?.text ?? ''}
    </div>
  )
}

export function MindmapOverlay({ ctx }: { ctx: FeatureContext }) {
  const editor = useEditor()
  useLayoutEffect(() => {
    setMindmapCtx(editor, ctx)
  })
  const ready = useValue('dr-mindmap-ready', () => getRuntime(editor) !== null, [editor])
  if (!ready) return null
  return (
    <div className="dr-mm-overlay" data-testid="mindmap-overlay">
      <CollapsedBadges ctx={ctx} />
      <TopicBar ctx={ctx} />
      <DeleteConfirm />
      <Status />
    </div>
  )
}
