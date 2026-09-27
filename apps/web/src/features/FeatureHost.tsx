// Renders the feature slots (docs/FEATURES-M2-CONTRACTS.md): the dock rail + open panel, top-bar
// items, canvas overlays, and the merged tldraw overrides/components/options. Integration owner.

import { Fragment, useEffect, useMemo } from 'react'
import type { TLComponents, TLUiOverrides, TldrawOptions } from 'tldraw'
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

export function FeatureTopBarItems({
  features,
  ctx,
}: {
  features: readonly BoardFeature[]
  ctx: FeatureContext | null
}) {
  if (!ctx) return null
  return <>{features.map((f) => (f.TopBarItem ? <f.TopBarItem key={f.id} ctx={ctx} /> : null))}</>
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

export function FeatureDock({
  features,
  ctx,
}: {
  features: readonly BoardFeature[]
  ctx: FeatureContext | null
}) {
  const panels = useMemo(() => visiblePanels(features, ctx), [features, ctx])
  if (!ctx || panels.length === 0) return null
  const active = panels.find((p) => p.id === ctx.activePanel) ?? null
  return (
    <aside className="dr-dock" data-testid="feature-dock" data-open={active ? 'true' : 'false'}>
      <nav className="dr-dock__rail" aria-label="Board panels">
        {panels.map((p) => (
          <button
            key={p.id}
            type="button"
            className="dr-dock__tab"
            data-testid={`dock-tab-${p.id}`}
            aria-pressed={active?.id === p.id}
            title={p.shortcutHint ? `${p.label} (${p.shortcutHint})` : p.label}
            aria-label={p.label}
            onClick={() => ctx.openPanel(active?.id === p.id ? null : p.id)}
          >
            {p.icon}
          </button>
        ))}
      </nav>
      {active && (
        <section className="dr-dock__panel" data-testid={`dock-panel-${active.id}`} aria-label={active.label}>
          <header className="dr-dock__head">
            <h2>{active.label}</h2>
            <button
              type="button"
              className="dr-iconbtn"
              aria-label={`Close ${active.label}`}
              onClick={() => ctx.openPanel(null)}
            >
              ×
            </button>
          </header>
          <div className="dr-dock__body">
            <active.Component ctx={ctx} close={() => ctx.openPanel(null)} />
          </div>
        </section>
      )}
    </aside>
  )
}
