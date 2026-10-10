// The engine-neutral half of the feature host (./FeatureHost.tsx): the dock rail and its open panel, and
// the "⋯" menu rows of top-bar items. Both board pages render these: the tldraw page through
// FeatureHost.tsx (BOARD_FEATURES, `FeatureContext`), the Excalidraw page through its registries
// (CANVAS_FEATURES, the frozen `CanvasFeatureContext`, canvas/board/**). No tldraw, no engine: what differs
// per engine (which panels, what a panel renders, whether a text editor is open, the add-note action)
// comes in as props. Integration owner (2C).

import { Component, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { isFocusLost, isTextEntry, tryFocus } from '../ui/focus.ts'

/** One dock panel as the rail shows it (from a BoardFeature panel or a CanvasPanelSpec). */
export interface DockPanelView {
  readonly id: string
  readonly label: string
  readonly icon: ReactNode
  readonly shortcutHint?: string
  /** the open panel's body */
  render(close: () => void): ReactNode
}

/**
 * Moves the keyboard into a panel that just opened (A11Y-02) when the user opened it with a control (a
 * rail button, a toolbar button, a chip) or the focus had nowhere to be. A panel opened while someone
 * works on the canvas or types in a field (a remote event, a background open) leaves their focus alone.
 */
export function shouldFocusOpenedPanel(active: Element | null, editing: boolean): boolean {
  if (isFocusLost()) return true
  if (editing || isTextEntry(active)) return false
  const tag = active?.tagName
  return tag === 'BUTTON' || tag === 'A' || active?.getAttribute('role') === 'menuitem'
}

export interface FeatureDockViewProps {
  readonly panels: readonly DockPanelView[]
  readonly activePanel: string | null
  openPanel(panelId: string | null): void
  /** a text editor is open on the canvas (a panel opening then leaves the focus there) */
  isEditingText(): boolean
  /** the rail's last button (the tldraw page's "Add a sticky note"); `closeRail` folds the phone rail */
  renderAddNote?(closeRail: () => void): ReactNode
}

export function FeatureDockView({
  panels,
  activePanel,
  openPanel,
  isEditingText,
  renderAddNote,
}: FeatureDockViewProps) {
  const active = panels.find((p) => p.id === activePanel) ?? null
  const activeId = active?.id ?? null
  const railRef = useRef<HTMLElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const panelDomId = useId()
  /** The focus was inside the open panel at the last focus change (it is gone once the panel closes). */
  const focusInPanel = useRef(false)
  /** What had the focus when the panel opened; it gets it back when the panel closes (A11Y-01/02). */
  const opener = useRef<HTMLElement | null>(null)
  const openerWasControl = useRef(false)
  const shown = useRef<string | null>(null)
  const editingRef = useRef(isEditingText)
  editingRef.current = isEditingText
  // R13 / A11Y-06: on phones (styles.css, below 600 px) the rail folds behind one button over the board
  // and a panel opens as a full-width sheet over it. Wider screens ignore this state.
  const [railOpen, setRailOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const railId = useId()

  // The open phone rail lies over the board: a press anywhere else folds it away again.
  useEffect(() => {
    if (!railOpen) return
    const onDown = (e: PointerEvent) => {
      if (!railRef.current?.contains(e.target as Node)) setRailOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [railOpen])

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      focusInPanel.current = panelRef.current?.contains(e.target as Node) === true
    }
    document.addEventListener('focusin', onFocusIn, true)
    return () => document.removeEventListener('focusin', onFocusIn, true)
  }, [])

  // Closing (×, Escape, the panel's own close, another feature closing it): the keyboard goes back to
  // whatever opened the panel, else to its rail button, never to <body>.
  useLayoutEffect(() => {
    const prev = shown.current
    if (prev === activeId) return
    shown.current = activeId
    if (prev && (focusInPanel.current || isFocusLost())) {
      focusInPanel.current = false
      if (!activeId) {
        const rail = railRef.current?.querySelector(`[data-panel-id="${CSS.escape(prev)}"]`)
        // On phones the rail is folded away again: its button takes the keyboard instead.
        if (!tryFocus(opener.current) && !tryFocus(rail)) tryFocus(toggleRef.current)
      }
    }
    if (activeId) {
      const a = document.activeElement
      opener.current =
        a instanceof HTMLElement && a !== document.body && !panelRef.current?.contains(a) ? a : null
      openerWasControl.current = shouldFocusOpenedPanel(a, editingRef.current())
    }
  }, [activeId])

  // Opening: after the panel's own effects (a search field focuses itself), move the keyboard into it.
  useEffect(() => {
    if (!activeId || !openerWasControl.current) return
    openerWasControl.current = false
    const panel = panelRef.current
    if (!panel || panel.contains(document.activeElement)) return
    headingRef.current?.focus({ preventScroll: true })
  }, [activeId])

  if (panels.length === 0) return null
  const close = () => openPanel(null)
  return (
    <aside
      className="dr-dock"
      data-testid="feature-dock"
      data-open={active ? 'true' : 'false'}
      data-rail={railOpen ? 'open' : 'closed'}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !railOpen || e.defaultPrevented) return
        if (!railRef.current?.contains(e.target as Node)) return
        e.preventDefault()
        e.stopPropagation()
        setRailOpen(false)
        tryFocus(toggleRef.current)
      }}
    >
      <nav ref={railRef} id={railId} className="dr-dock__rail" aria-label="Board panels">
        <button
          ref={toggleRef}
          type="button"
          className="dr-dock__tab dr-dock__toggle"
          data-testid="dock-rail-toggle"
          aria-expanded={railOpen}
          aria-controls={railId}
          aria-label={railOpen ? 'Hide board panels' : 'Board panels'}
          title={railOpen ? 'Hide board panels' : 'Board panels'}
          onClick={() => setRailOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            {railOpen ? (
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            ) : (
              <path
                d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            )}
          </svg>
        </button>
        {panels.map((p) => (
          <button
            key={p.id}
            type="button"
            className="dr-dock__tab"
            data-testid={`dock-tab-${p.id}`}
            data-panel-id={p.id}
            aria-expanded={active?.id === p.id}
            aria-controls={active?.id === p.id ? panelDomId : undefined}
            title={p.shortcutHint ? `${p.label} (${p.shortcutHint})` : p.label}
            aria-label={p.label}
            onClick={() => {
              setRailOpen(false)
              openPanel(active?.id === p.id ? null : p.id)
            }}
          >
            {p.icon}
            <span className="dr-dock__label" aria-hidden="true">
              {p.label}
            </span>
          </button>
        ))}
        {renderAddNote?.(() => setRailOpen(false))}
      </nav>
      {active && (
        <section
          ref={panelRef}
          id={panelDomId}
          className="dr-dock__panel"
          data-testid={`dock-panel-${active.id}`}
          aria-label={active.label}
          onKeyDown={(e) => {
            // Controls with their own Escape (a composer, a rename field, a menu) handle it first.
            if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return
            e.preventDefault()
            e.stopPropagation()
            close()
          }}
        >
          <header className="dr-dock__head">
            <h2 ref={headingRef} tabIndex={-1}>
              {active.label}
            </h2>
            <button
              type="button"
              className="dr-iconbtn"
              data-testid="dock-panel-close"
              aria-label={`Close ${active.label}`}
              onClick={close}
            >
              ×
            </button>
          </header>
          <div className="dr-dock__body">{active.render(close)}</div>
        </section>
      )}
    </aside>
  )
}

/** One captioned row of the top bar's "⋯" menu (a feature's controls, wrapped as they are). */
export function TopBarOverflowRow({
  featureId,
  caption,
  children,
}: {
  featureId: string
  caption?: string | undefined
  children: ReactNode
}) {
  return (
    <div className="dr-overflow__item" data-feature={featureId}>
      {caption && (
        <span className="dr-overflow__caption" aria-hidden="true">
          {caption}
        </span>
      )}
      <div className="dr-overflow__controls">{children}</div>
    </div>
  )
}

// ---- one feature's error never blanks the board (H1, wave M M1-2; FTU-1) ------------------------------------

/** A contribution that crashes this many times within FEATURE_CRASH_WINDOW_MS stays off until the page reloads. */
export const FEATURE_CRASH_LIMIT = 3
export const FEATURE_CRASH_WINDOW_MS = 60_000

/** Crash times per contribution id, and the ids that are off until a reload (this page load only). */
const crashTimes = new Map<string, number[]>()
const offUntilReload = new Set<string>()

/** Records one crash of `id` at `now` (ms); true when that turned it off until the page reloads. */
export function recordFeatureCrash(id: string, now: number): boolean {
  const recent = (crashTimes.get(id) ?? []).filter((t) => now - t < FEATURE_CRASH_WINDOW_MS)
  recent.push(now)
  crashTimes.set(id, recent)
  if (recent.length >= FEATURE_CRASH_LIMIT) offUntilReload.add(id)
  return offUntilReload.has(id)
}

/** Whether `id` crashed FEATURE_CRASH_LIMIT times within a minute (it stays off until a reload). */
export const featureOff = (id: string): boolean => offUntilReload.has(id)

/** Tests only: forgets every crash. */
export function resetFeatureCrashes(): void {
  crashTimes.clear()
  offUntilReload.clear()
}

interface FeatureBoundaryProps {
  /** the contribution's id, kind first ("overlay:ai-menu", "selectionBar:tags.pick"): what the log line names */
  readonly featureId: string
  /** a change (the board, the selection) gives a crashed contribution another try */
  readonly resetKey?: string | undefined
  readonly children?: ReactNode
}

interface FeatureBoundaryState {
  readonly failed: boolean
  readonly key: string | undefined
}

/**
 * Wraps every component a feature renders on the board page (dock panels, overlays, host slots, top-bar items,
 * selection-bar items, menu rows). When one throws, only it renders nothing: the canvas and every other feature
 * keep running. It logs one line (`feature_crash <featureId>`, no props, no content), tries again when `resetKey`
 * changes, and after FEATURE_CRASH_LIMIT crashes within a minute stays off until the page reloads.
 */
export class FeatureBoundary extends Component<FeatureBoundaryProps, FeatureBoundaryState> {
  override state: FeatureBoundaryState = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError(): Partial<FeatureBoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(
    props: FeatureBoundaryProps,
    state: FeatureBoundaryState,
  ): FeatureBoundaryState | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey }
  }

  override componentDidCatch(): void {
    recordFeatureCrash(this.props.featureId, Date.now())
    console.warn(`feature_crash ${this.props.featureId}`)
  }

  override render(): ReactNode {
    if (this.state.failed || featureOff(this.props.featureId)) return null
    return this.props.children ?? null
  }
}
