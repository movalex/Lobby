// Canvas overlays for canvas-ux, rendered as a child of <Tldraw> (inside the editor + UI contexts):
//  - BulkPastePrompt: "Paste as sticky notes or as text?" (COL-05)
//  - SearchHighlights: dims everything but the board-search matches while the search panel is open (MAK-12)
//  - SelectionBar: copy link (PRS-04), align / distribute (MAK-03) and lock for the selection
//  - LockedHintBar: "Locked. Inside locked frame …" where a click on a locked shape did nothing (F8)
//  - LockedFrameBadges: a lock glyph before the heading of every locked frame (F8)
// All positions are viewport coordinates (Editor.pageToViewport), relative to the editor container.

import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from 'react'
import { type Editor, type TLShapeId, useActions, useEditor, useValue } from 'tldraw'
import { isReadonlyRole } from '../../board/access.ts'
import type { FeatureContext } from '../types.ts'
import {
  activePanel,
  lockedHint,
  pendingPaste,
  searchMatches,
  searchState,
  setFeatureCtx,
  startViewResult,
} from './bridge.ts'
import { pasteAsNotes } from './bulk-paste-handler.ts'
import { copySelectionLink } from './copy-link.ts'
import { DEFAULT_MAX_NOTES } from './deps.ts'
import { AlignIcons, LinkIcon, LockIcon } from './icons.tsx'
import { PANEL } from './overrides.tsx'
import { hasNotePalette, withNotePalette } from './palette.ts'

/** Applies Draftroom's note palette to the editor's current theme (idempotent). */
export function applyNotePalette(editor: Editor) {
  const theme = editor.getCurrentTheme()
  if (!hasNotePalette(theme)) editor.updateTheme(withNotePalette(theme))
}

/**
 * Stops keys and pointers inside our floating UI from reaching tldraw's container/body listeners
 * (native, bubble phase; they run before React's root listener, so React's stopPropagation would be
 * too late). Because React then never sees those keydowns either, Escape is handled here natively.
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
    // Mouse clicks on the selection bar must not pull focus off the canvas (Ctrl+Z, Delete… keep working).
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

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function BulkPastePrompt() {
  const editor = useEditor()
  const pending = useValue('dr-pending-paste', () => pendingPaste(editor).get(), [editor])
  const finish = () => {
    pendingPaste(editor).set(null)
    editor.focus()
  }
  const ref = useIsland<HTMLDivElement>({ onEscape: finish })
  const titleId = useId()
  const pos = useValue('dr-paste-pos', () => {
    const p = pendingPaste(editor).get()
    if (!p) return null
    const v = editor.pageToViewport(p.center)
    const vp = editor.getViewportScreenBounds()
    return { x: clamp(v.x, 170, Math.max(170, vp.w - 170)), y: clamp(v.y, 70, Math.max(70, vp.h - 90)) }
  }, [editor])
  if (!pending || !pos) return null

  const { cells } = pending.analysis
  const notes = Math.min(cells, DEFAULT_MAX_NOTES)
  return (
    <div
      // A new paste replaces the prompt: remount so the Notes button takes focus again.
      key={pending.id}
      ref={ref}
      className="dr-cux-paste"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="bulk-paste-prompt"
      style={{ left: pos.x, top: pos.y }}
    >
      <p id={titleId} className="dr-cux-paste__title">
        Paste {cells} {cells === 1 ? 'item' : 'items'} as sticky notes or as text?
      </p>
      {cells > DEFAULT_MAX_NOTES && (
        <p className="dr-cux-muted">Only the first {DEFAULT_MAX_NOTES} become notes.</p>
      )}
      <div className="dr-cux-paste__actions">
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="bulk-paste-notes"
          // biome-ignore lint/a11y/noAutofocus: the prompt exists to take this one decision
          autoFocus
          onClick={() => {
            const p = pendingPaste(editor).get()
            pendingPaste(editor).set(null)
            if (p) pasteAsNotes(editor, p.text, p.center)
            editor.focus()
          }}
        >
          {notes} sticky {notes === 1 ? 'note' : 'notes'}
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="bulk-paste-text"
          onClick={() => {
            const p = pendingPaste(editor).get()
            pendingPaste(editor).set(null)
            if (p) {
              editor.markHistoryStoppingPoint('paste as text')
              void p.asText()
            }
            editor.focus()
          }}
        >
          Text
        </button>
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm"
          data-testid="bulk-paste-cancel"
          aria-label="Cancel paste"
          onClick={finish}
        >
          ×
        </button>
      </div>
    </div>
  )
}

function SearchHighlights() {
  const editor = useEditor()
  const maskId = useId().replace(/:/g, '')
  const view = useValue('dr-search-boxes', () => {
    const ids = searchMatches(editor).get()
    if (!ids.length) return null
    const vp = editor.getViewportScreenBounds()
    const z = editor.getZoomLevel()
    const active = searchState(editor).get().activeId
    const boxes: { id: string; x: number; y: number; w: number; h: number; active: boolean }[] = []
    for (const id of ids) {
      const b = editor.getShapePageBounds(id as never)
      if (!b) continue
      const tl = editor.pageToViewport({ x: b.x, y: b.y })
      boxes.push({ id, x: tl.x - 6, y: tl.y - 6, w: b.w * z + 12, h: b.h * z + 12, active: id === active })
    }
    return { w: vp.w, h: vp.h, boxes }
  }, [editor])
  if (!view) return null
  return (
    <svg
      className="dr-cux-search-dim"
      width={view.w}
      height={view.h}
      data-testid="search-highlights"
      data-match-count={view.boxes.length}
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId}>
          <rect width={view.w} height={view.h} fill="white" />
          {view.boxes.map((b) => (
            <rect key={b.id} x={b.x} y={b.y} width={b.w} height={b.h} rx="8" fill="black" />
          ))}
        </mask>
      </defs>
      <rect width={view.w} height={view.h} className="dr-cux-search-dim__veil" mask={`url(#${maskId})`} />
      {view.boxes.map((b) => (
        <rect
          key={b.id}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx="8"
          className={
            b.active ? 'dr-cux-search-dim__ring dr-cux-search-dim__ring--active' : 'dr-cux-search-dim__ring'
          }
          data-shape-id={b.id}
        />
      ))}
    </svg>
  )
}

function BarButton(props: {
  label: string
  testId?: string
  onClick(): void
  children: ReactNode
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      className="dr-cux-selbar__btn"
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

function SelectionBar({ ctx }: { ctx: FeatureContext }) {
  const editor = useEditor()
  const actions = useActions()
  const ref = useIsland<HTMLDivElement>({ keepCanvasFocus: true })
  const canEdit = !isReadonlyRole(ctx.role, ctx.board.status)
  const state = useValue('dr-selbar', () => {
    const ids = editor.getSelectedShapeIds()
    if (!ids.length || !editor.isIn('select.idle') || editor.getEditingShapeId()) return null
    if (editor.getInstanceState().isFocusMode) return null
    const b = editor.getSelectionPageBounds()
    if (!b) return null
    const vp = editor.getViewportScreenBounds()
    const bottom = editor.pageToViewport({ x: b.midX, y: b.maxY })
    const top = editor.pageToViewport({ x: b.midX, y: b.minY })
    // Keep clear of tldraw's panels: the menu/style row at the top and the toolbar at the bottom.
    const safeTop = 60
    const safeBottom = vp.h - 100
    let y = bottom.y + 14
    if (y + 40 > safeBottom) {
      y = top.y - 54
      // A selection that fills the view: sit just inside its lower edge.
      if (y < safeTop) y = Math.max(safeTop, Math.min(safeBottom - 40, bottom.y - 54))
    }
    if (bottom.y < 0 || top.y > vp.h || bottom.x < -200 || bottom.x > vp.w + 200) return null
    const locked = editor.getSelectedShapes().every((s) => s.isLocked)
    return {
      n: ids.length,
      x: clamp(bottom.x, 150, Math.max(150, vp.w - 150)),
      y,
      locked,
    }
  }, [editor])
  if (!state) return null
  const run = (id: string) => {
    actions[id]?.onSelect('toolbar')
    // Keyboard users who tabbed into the bar go back to the board after acting.
    if (ref.current?.contains(document.activeElement)) editor.focus()
  }
  return (
    <div
      ref={ref}
      className="dr-cux-selbar"
      role="toolbar"
      aria-label="Selection"
      data-testid="selection-bar"
      style={{ left: state.x, top: state.y }}
    >
      <BarButton
        label="Copy link to selection"
        testId="copy-link-selection"
        onClick={() => {
          void copySelectionLink(editor)
          if (ref.current?.contains(document.activeElement)) editor.focus()
        }}
      >
        <LinkIcon />
      </BarButton>
      {canEdit && (
        <BarButton
          label={state.locked ? 'Unlock (Ctrl+Shift+L)' : 'Lock (Ctrl+Shift+L)'}
          testId="selection-lock"
          pressed={state.locked}
          onClick={() => run('toggle-lock')}
        >
          <LockIcon />
        </BarButton>
      )}
      {canEdit && state.n >= 2 && (
        <>
          <span className="dr-cux-selbar__sep" aria-hidden="true" />
          <BarButton label="Align left" testId="align-left" onClick={() => run('align-left')}>
            <AlignIcons.left />
          </BarButton>
          <BarButton
            label="Align center"
            testId="align-center-horizontal"
            onClick={() => run('align-center-horizontal')}
          >
            <AlignIcons.centerH />
          </BarButton>
          <BarButton label="Align right" testId="align-right" onClick={() => run('align-right')}>
            <AlignIcons.right />
          </BarButton>
          <BarButton label="Align top" testId="align-top" onClick={() => run('align-top')}>
            <AlignIcons.top />
          </BarButton>
          <BarButton
            label="Align middle"
            testId="align-center-vertical"
            onClick={() => run('align-center-vertical')}
          >
            <AlignIcons.centerV />
          </BarButton>
          <BarButton label="Align bottom" testId="align-bottom" onClick={() => run('align-bottom')}>
            <AlignIcons.bottom />
          </BarButton>
        </>
      )}
      {canEdit && state.n >= 3 && (
        <>
          <BarButton
            label="Distribute horizontally"
            testId="distribute-horizontal"
            onClick={() => run('distribute-horizontal')}
          >
            <AlignIcons.distH />
          </BarButton>
          <BarButton
            label="Distribute vertically"
            testId="distribute-vertical"
            onClick={() => run('distribute-vertical')}
          >
            <AlignIcons.distV />
          </BarButton>
        </>
      )}
    </div>
  )
}

/** How long the locked hint stays up without another click. */
const LOCKED_HINT_MS = 6000

function LockedHintBar({ ctx }: { ctx: FeatureContext }) {
  const editor = useEditor()
  const hint = useValue('dr-locked-hint', () => lockedHint(editor).get(), [editor])
  const dismiss = () => lockedHint(editor).set(null)
  const ref = useIsland<HTMLDivElement>({ onEscape: dismiss, keepCanvasFocus: true })
  const canEdit = !isReadonlyRole(ctx.role, ctx.board.status)
  const pos = useValue('dr-locked-hint-pos', () => {
    const h = lockedHint(editor).get()
    if (!h) return null
    const v = editor.pageToViewport(h.point)
    const vp = editor.getViewportScreenBounds()
    // Above the pointer, clear of the top bar; below it when there is no room above.
    const y = v.y - 52 < 60 ? v.y + 28 : v.y - 52
    return { x: clamp(v.x, 180, Math.max(180, vp.w - 180)), y: clamp(y, 60, Math.max(60, vp.h - 100)) }
  }, [editor])
  const id = hint?.id
  useEffect(() => {
    if (id === undefined) return
    const t = setTimeout(() => {
      if (lockedHint(editor).get()?.id === id) lockedHint(editor).set(null)
    }, LOCKED_HINT_MS)
    return () => clearTimeout(t)
  }, [editor, id])
  if (!hint || !pos) return null
  return (
    <div
      ref={ref}
      className="dr-cux-selbar dr-cux-lockhint"
      role="status"
      data-testid="locked-hint"
      data-source-id={hint.sourceId}
      style={{ left: pos.x, top: pos.y }}
    >
      <span className="dr-cux-lockhint__icon" aria-hidden="true">
        <LockIcon />
      </span>
      <span className="dr-cux-lockhint__text">{hint.message}</span>
      {canEdit && (
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="locked-hint-unlock"
          onClick={() => {
            const source = editor.getShape(hint.sourceId as TLShapeId)
            dismiss()
            if (!source?.isLocked) return
            editor.markHistoryStoppingPoint('unlock')
            editor.toggleLock([source.id])
          }}
        >
          {hint.unlockLabel}
        </button>
      )}
      <button
        type="button"
        className="dr-iconbtn dr-iconbtn--sm"
        aria-label="Dismiss"
        data-testid="locked-hint-dismiss"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  )
}

/**
 * F8: a lock glyph before the heading of each locked frame on the page. tldraw draws frame headings
 * itself, so this is one stylesheet with a rule per locked frame; the glyph moves and scales with the
 * heading for free.
 */
function LockedFrameBadges() {
  const editor = useEditor()
  const ids = useValue(
    'dr-locked-frames',
    () =>
      editor
        .getCurrentPageShapes()
        .filter((s) => s.type === 'frame' && s.isLocked)
        .map((s) => s.id)
        .sort()
        .join(' '),
    [editor],
  )
  if (!ids) return null
  const list = ids.split(' ')
  const selector = list
    .map((id) => `.tl-shape[data-shape-id="${CSS.escape(id)}"] .tl-frame-heading-hit-area::before`)
    .join(',\n')
  return (
    <style data-testid="locked-frame-badges" data-count={list.length}>
      {`${selector} {${LOCK_BADGE_CSS}}`}
    </style>
  )
}

const LOCK_GLYPH = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="black" stroke-width="2.4"/></svg>',
)}")`
const LOCK_BADGE_CSS = `
  content: '';
  flex: none;
  width: 11px;
  height: 11px;
  margin: 0 2px 0 6px;
  background-color: currentColor;
  -webkit-mask: ${LOCK_GLYPH} center / contain no-repeat;
  mask: ${LOCK_GLYPH} center / contain no-repeat;
`

export function CanvasUxOverlay({ ctx }: { ctx: FeatureContext }) {
  const editor = useEditor()
  // Overrides and components are module-level; they read the latest context through the bridge.
  useLayoutEffect(() => {
    setFeatureCtx(editor, ctx)
    if (activePanel(editor).get() !== ctx.activePanel) activePanel(editor).set(ctx.activePanel)
  })
  useLayoutEffect(() => applyNotePalette(editor), [editor])
  const startView = useValue('dr-start-view', () => startViewResult(editor).get(), [editor])
  return (
    <div className="dr-cux-overlay" data-testid="canvas-ux-overlay" data-start-view={startView ?? undefined}>
      {ctx.activePanel === PANEL.search && <SearchHighlights />}
      <SelectionBar ctx={ctx} />
      <LockedHintBar ctx={ctx} />
      <LockedFrameBadges />
      <BulkPastePrompt />
    </div>
  )
}
