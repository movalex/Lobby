// Renders the feature slots (docs/FEATURES-M2-CONTRACTS.md): the dock rail + open panel, top-bar
// items, canvas overlays, and the merged tldraw overrides/components/options. Integration owner.

import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react'
import type { TLComponents, TLUiOverrides, TldrawOptions } from 'tldraw'
import { isFocusLost, isTextEntry, tryFocus } from '../ui/focus.ts'
import type { BoardFeature, FeatureContext, FeaturePanel } from './types.ts'

export interface MergedFeatureProps {
  overrides: TLUiOverrides[]
  components: Partial<TLComponents>
  options: Partial<TldrawOptions>
}

/** Computed once from the (module-level) registry, so the <Tldraw> props stay referentially stable. */
export function mergeFeatureProps(
  features: readonly BoardFeature[],
  base: { overrides: TLUiOverrides; components: TLComponents },
): MergedFeatureProps {
  const overrides = [base.overrides, ...features.flatMap((f) => (f.overrides ? [f.overrides] : []))]
  const components: Partial<TLComponents> = { ...base.components }
  const options: Partial<TldrawOptions> = {}
  for (const f of features) {
    Object.assign(components, f.components ?? {})
    Object.assign(options, f.options ?? {})
  }
  return { overrides, components, options }
}

export function visiblePanels(features: readonly BoardFeature[], ctx: FeatureContext | null): FeaturePanel[] {
  if (!ctx) return []
  return features.flatMap((f) => f.panels ?? []).filter((p) => (p.visible ? p.visible(ctx) : true))
}

/** Runs every feature's onMount once per editor + event stream (not on role/panel changes). */
export function useFeatureMounts(features: readonly BoardFeature[], ctx: FeatureContext | null) {
  const editor = ctx?.editor
  const events = ctx?.events
  // Deliberately keyed on editor + stream only: ctx changes (role, panel) must not remount features.
  useEffect(() => {
    if (!ctx) return
    const cleanups: (() => void)[] = []
    for (const f of features) {
      try {
        const c = f.onMount?.(ctx)
        if (typeof c === 'function') cleanups.push(c)
      } catch (e) {
        console.error(`feature ${f.id} failed to mount`, e)
      }
    }
    return () => {
      for (const c of cleanups.reverse()) c()
    }
  }, [features, editor, events])
}

/**
 * Features whose top-bar item stays in the bar on narrow screens (PRI-02): the comments item holds
 * the notifications bell. Every other item moves into the "⋯" menu there.
 */
export const PINNED_TOP_BAR_FEATURES: readonly string[] = ['comments']

/** A heading for a feature's controls inside the "⋯" menu (the controls themselves are unchanged). */
const OVERFLOW_CAPTION: Record<string, string> = {
  workshops: 'Timer and voting',
  'present-export': 'Present and export',
  sharing: 'Sharing',
}

export function FeatureTopBarItems({
  features,
  ctx,
  only,
  except,
  stacked = false,
}: {
  features: readonly BoardFeature[]
  ctx: FeatureContext | null
  /** Render just these features' items (by id). */
  only?: readonly string[]
  /** Render every item but these. */
  except?: readonly string[]
  /** Inside the "⋯" menu: one captioned row per feature, the feature component wrapped as is. */
  stacked?: boolean
}) {
  if (!ctx) return null
  const shown = features.filter(
    (f) => f.TopBarItem && (!only || only.includes(f.id)) && !except?.includes(f.id),
  )
  if (!stacked) return <>{shown.map((f) => (f.TopBarItem ? <f.TopBarItem key={f.id} ctx={ctx} /> : null))}</>
  return (
    <>
      {shown.map((f) =>
        f.TopBarItem ? (
          <div key={f.id} className="dr-overflow__item" data-feature={f.id}>
            {OVERFLOW_CAPTION[f.id] && (
              <span className="dr-overflow__caption" aria-hidden="true">
                {OVERFLOW_CAPTION[f.id]}
              </span>
            )}
            <div className="dr-overflow__controls">
              <f.TopBarItem ctx={ctx} />
            </div>
          </div>
        ) : null,
      )}
    </>
  )
}

export function FeatureOverlays({
  features,
  ctx,
}: {
  features: readonly BoardFeature[]
  ctx: FeatureContext | null
}) {
  if (!ctx) return null
  return (
    <>{features.map((f) => (f.Overlay ? <f.Overlay key={f.id} ctx={ctx} /> : <Fragment key={f.id} />))}</>
  )
}

/**
 * Moves the keyboard into a panel that just opened (A11Y-02) when the user opened it with a control (a
 * rail button, a toolbar button, a chip) or the focus had nowhere to be. A panel opened while someone
 * works on the canvas or types in a field (a remote event, a background open) leaves their focus alone.
 */
function shouldFocusOpenedPanel(active: Element | null, editing: boolean): boolean {
  if (isFocusLost()) return true
  if (editing || isTextEntry(active)) return false
  const tag = active?.tagName
  return tag === 'BUTTON' || tag === 'A' || active?.getAttribute('role') === 'menuitem'
}

export function FeatureDock({
  features,
  ctx,
}: {
  features: readonly BoardFeature[]
  ctx: FeatureContext | null
}) {
  const panels = useMemo(() => visiblePanels(features, ctx), [features, ctx])
  const active = (ctx && panels.find((p) => p.id === ctx.activePanel)) ?? null
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
  const editor = ctx?.editor

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
        if (!tryFocus(opener.current)) tryFocus(rail)
      }
    }
    if (activeId) {
      const a = document.activeElement
      opener.current =
        a instanceof HTMLElement && a !== document.body && !panelRef.current?.contains(a) ? a : null
      openerWasControl.current = shouldFocusOpenedPanel(a, editor?.getEditingShapeId() != null)
    }
  }, [activeId, editor])

  // Opening: after the panel's own effects (a search field focuses itself), move the keyboard into it.
  useEffect(() => {
    if (!activeId || !openerWasControl.current) return
    openerWasControl.current = false
    const panel = panelRef.current
    if (!panel || panel.contains(document.activeElement)) return
    headingRef.current?.focus({ preventScroll: true })
  }, [activeId])

  if (!ctx || panels.length === 0) return null
  const close = () => ctx.openPanel(null)
  return (
    <aside className="dr-dock" data-testid="feature-dock" data-open={active ? 'true' : 'false'}>
      <nav ref={railRef} className="dr-dock__rail" aria-label="Board panels">
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
            onClick={() => ctx.openPanel(active?.id === p.id ? null : p.id)}
          >
            {p.icon}
          </button>
        ))}
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
          <div className="dr-dock__body">
            <active.Component ctx={ctx} close={close} />
          </div>
        </section>
      )}
    </aside>
  )
}
