// Mind-map overlays on the new canvas (a `screen` layer of the board page's overlay root; overlay-root
// pixels through `LobbyCanvas.sceneToOverlay`). The port of ../Overlay.tsx, same copy and test ids:
//  - TopicBar: above the one selected topic: add child (Tab), add sibling (Enter), move up a level
//    (Shift+Tab), collapse/expand, Tidy up and the outline menu. Read-only people get the outline only.
//  - CollapsedBadges: "+N" at the outer edge of every collapsed topic on screen; a click expands it.
//  - DeleteConfirm: "Delete 14 topics?" before a big branch goes.
//  - a polite status line for screen readers.
// The layer is hidden in focus mode (present), by the board page. Every reactive read is narrow: the
// selection, one topic's bounds, the viewport and the index's structure version.

import type { MindmapSide } from '@draftroom/contracts'
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isReadonlyRole } from '../../../board/access.ts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { Dialog } from '../../../ui/Dialog.tsx'
import {
  AddChildIcon,
  AddSiblingIcon,
  ChevronIcon,
  CollapseIcon,
  ExpandIcon,
  OutlineIcon,
  TidyIcon,
} from '../icons.tsx'
import '../mindmap.css'
import { mindmapOf } from './bridge.ts'
import {
  addChildTopic,
  addSiblingTopic,
  copyOutline,
  downloadOutline,
  type Mindmap,
  promoteTopic,
  selectedTopic,
  tidyMindmap,
  toggleTopicCollapsed,
} from './commands.ts'
import { MINDMAP_MAX_DEPTH, type MindmapRuntime } from './runtime.ts'

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const UNDO_KEYS = IS_MAC ? 'Cmd+Z' : 'Ctrl+Z'

/**
 * Keeps keys and pointers inside our floating UI away from the canvas's and the engine's listeners. With
 * `keepCanvasFocus`, a mouse press does not take the focus off the board (Ctrl+Z, Tab and Delete keep
 * working after a click).
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
function sideOf(rt: MindmapRuntime, id: string): MindmapSide {
  let meta = rt.metaOf(id)
  for (let i = 0; meta && i <= MINDMAP_MAX_DEPTH; i++) {
    if (meta.parentId === null) return 'right'
    if (meta.parentId === meta.rootId) return meta.side
    meta = rt.metaOf(meta.parentId)
  }
  return 'right'
}

/** A JSON value selector (re-renders only when the value's content changes, not on every pointer move). */
function useJson<T>(name: string, fn: () => T, deps: readonly unknown[]): T {
  const json = useValue(name, () => JSON.stringify(fn() ?? null), deps)
  return useMemo(() => JSON.parse(json) as T, [json])
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

function OutlineMenu({ m, canvas, topicId }: { m: Mindmap; canvas: LobbyCanvas; topicId: string }) {
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
    canvas.focus()
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
            onClick={() => choose(() => copyOutline(m, topicId))}
          >
            Copy outline (Markdown)
          </button>
          <button
            type="button"
            role="menuitem"
            className="dr-mm-menu__item"
            data-testid="mindmap-download-md"
            onClick={() => choose(() => downloadOutline(m, 'md', topicId))}
          >
            Download as Markdown
          </button>
          <button
            type="button"
            role="menuitem"
            className="dr-mm-menu__item"
            data-testid="mindmap-download-csv"
            onClick={() => choose(() => downloadOutline(m, 'csv', topicId))}
          >
            Download as CSV
          </button>
        </div>
      )}
    </span>
  )
}

interface BarState {
  id: string
  cx: number
  vw: number
  y: number
  collapsed: boolean
  hasChildren: boolean
  isRoot: boolean
  canPromote: boolean
  exportOk: boolean
}

function TopicBar({ ctx, m }: { ctx: CanvasFeatureContext; m: Mindmap }) {
  const { canvas } = ctx
  const ref = useIsland<HTMLDivElement>({ keepCanvasFocus: true })
  const canEdit = !isReadonlyRole(ctx.role, ctx.board.status)
  const state = useJson<BarState | null>('mindmap.bar', () => {
    const { rt } = m
    rt.index.version.get()
    const id = selectedTopic(rt)
    if (!id) return null
    // hidden while something moves or is typed in; a press (on the bar's own buttons, too) keeps it
    const g = canvas.gesture()
    if ((g !== 'idle' && g !== 'pressing') || canvas.editingId()) return null
    const b = canvas.bounds(id)
    if (!b) return null
    const vp = canvas.viewport.screenRect()
    const top = canvas.sceneToOverlay({ x: b.x + b.width / 2, y: b.y })
    const bottom = canvas.sceneToOverlay({ x: b.x + b.width / 2, y: b.y + b.height })
    if (bottom.y < 0 || top.y > vp.height || bottom.x < -200 || bottom.x > vp.width + 200) return null
    // the selection bar sits below the selection, or above it when the selection is near the bottom:
    // this bar goes above, and above that one when it moved up
    const selbarAbove = bottom.y + 14 + 40 > vp.height - 100
    let y = top.y - 50 - (selbarAbove ? 50 : 0)
    if (y < 56) y = bottom.y + 14 + (selbarAbove ? 0 : 50)
    const meta = rt.metaOf(id)
    const kids = rt.index.children.get(id)?.size ?? 0
    const depth = meta?.parentId === null ? 0 : meta?.parentId === meta?.rootId ? 1 : 2
    return {
      id,
      cx: Math.round(top.x),
      vw: Math.round(vp.width),
      y: Math.round(y),
      collapsed: !!meta?.collapsed,
      hasChildren: kids > 0,
      isRoot: depth === 0,
      canPromote: depth >= 2,
      exportOk: m.gate.allowed(),
    }
  }, [canvas, m])
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
    if (ref.current?.contains(document.activeElement)) canvas.focus()
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
            onClick={() => void addChildTopic(m)}
          >
            <AddChildIcon />
          </BarButton>
          <BarButton
            label={state.isRoot ? 'Add branch (Enter)' : 'Add sibling topic (Enter)'}
            testId="mindmap-add-sibling"
            onClick={() => void addSiblingTopic(m)}
          >
            <AddSiblingIcon />
          </BarButton>
          {state.canPromote && (
            <BarButton
              label="Move up a level (Shift+Tab)"
              testId="mindmap-promote"
              onClick={() => {
                promoteTopic(m)
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
                toggleTopicCollapsed(m, state.id)
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
              tidyMindmap(m)
              back()
            }}
          >
            <TidyIcon />
          </BarButton>
        </>
      )}
      {state.exportOk && <OutlineMenu m={m} canvas={canvas} topicId={state.id} />}
    </div>
  )
}

interface Badge {
  id: string
  x: number
  y: number
  n: number
  side: MindmapSide
  s: number
}

function CollapsedBadges({ ctx, m }: { ctx: CanvasFeatureContext; m: Mindmap }) {
  const { canvas } = ctx
  const canEdit = !isReadonlyRole(ctx.role, ctx.board.status)
  const badges = useJson<Badge[]>('mindmap.badges', () => {
    const { rt } = m
    rt.index.version.get()
    const hidden = rt.hidden.get()
    const vp = canvas.viewport.screenRect()
    // zoomed far out, the badge shrinks with the map (down to about half size) instead of covering it
    const s = Math.round(clamp(canvas.viewport.get().zoom, 0.55, 1) * 100) / 100
    const out: Badge[] = []
    for (const id of rt.index.collapsed) {
      const n = rt.index.descendantCount(id)
      if (!n || hidden.has(id)) continue
      // only in a live map (a map whose central topic was deleted hides nothing)
      const rootId = rt.metaOf(id)?.rootId
      if (!rootId || !canvas.get(rootId) || rt.metaOf(rootId)?.parentId !== null) continue
      const b = canvas.bounds(id)
      if (!b) continue
      const side = sideOf(rt, id)
      const p = canvas.sceneToOverlay({ x: side === 'right' ? b.x + b.width : b.x, y: b.y + b.height / 2 })
      if (p.x < -40 || p.y < -40 || p.x > vp.width + 40 || p.y > vp.height + 40) continue
      out.push({ id, x: Math.round(p.x), y: Math.round(p.y), n, side, s })
    }
    return out
  }, [canvas, m])
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
            if (m.rt.toggleCollapsed(b.id, false)) canvas.select([b.id])
            canvas.focus()
          }}
        >
          +{b.n}
        </button>
      ))}
    </>
  )
}

function DeleteConfirm({ ctx, m }: { ctx: CanvasFeatureContext; m: Mindmap }) {
  const plan = useValue('mindmap.pending-delete', () => m.rt.pendingDelete.get(), [m])
  if (!plan) return null
  const close = () => {
    m.rt.pendingDelete.set(null)
    ctx.canvas.focus()
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
            m.rt.pendingDelete.set(null)
            m.rt.runDelete(plan)
            ctx.canvas.focus()
          }}
        >
          Delete {plan.topics} topics
        </button>
      </div>
    </Dialog>
  )
}

function Status({ m }: { m: Mindmap }) {
  const status = useValue('mindmap.status', () => m.rt.status.get(), [m])
  return (
    <div className="dr-sr-only" role="status" aria-live="polite" data-testid="mindmap-status">
      {status.text}
    </div>
  )
}

export function MindmapOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const m = useValue('mindmap.ready', () => mindmapOf(ctx.canvas), [ctx.canvas])
  if (!m) return null
  return (
    <div className="dr-mm-overlay" data-testid="mindmap-overlay">
      <CollapsedBadges ctx={ctx} m={m} />
      <TopicBar ctx={ctx} m={m} />
      <DeleteConfirm ctx={ctx} m={m} />
      <Status m={m} />
    </div>
  )
}
