// Renders the feature slots (docs/FEATURES-M2-CONTRACTS.md): the dock rail + open panel, top-bar
// items, canvas overlays, and the merged tldraw overrides/components/options. Integration owner.

import { Fragment, useEffect, useMemo } from 'react'
import { type Editor, type TLComponents, type TLUiOverrides, type TldrawOptions, useValue } from 'tldraw'
import { can } from '../lib/permissions.ts'
import { installPlaceOnEnter, placeAtCenter } from '../ui/place-at-center.ts'
import { type DockPanelView, FeatureDockView, TopBarOverflowRow } from './FeatureHostCore.tsx'
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
          <TopBarOverflowRow key={f.id} featureId={f.id} caption={OVERFLOW_CAPTION[f.id]}>
            <f.TopBarItem ctx={ctx} />
          </TopBarOverflowRow>
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
    <>
      <PlaceOnEnter editor={ctx.editor} />
      {features.map((f) => (f.Overlay ? <f.Overlay key={f.id} ctx={ctx} /> : <Fragment key={f.id} />))}
    </>
  )
}

/** A11Y-07: Enter with the note, shape or text tool picked places that shape in the middle of the view. */
function PlaceOnEnter({ editor }: { editor: Editor }) {
  useEffect(() => installPlaceOnEnter(editor), [editor])
  return null
}

/**
 * A11Y-07: "Add a sticky note" at the end of the rail, for people who can edit: a keyboard-only way to
 * put the first note on a blank board (it lands in the middle of the view, ready to type in).
 */
function AddNoteButton({ ctx, onPress }: { ctx: FeatureContext; onPress?: () => void }) {
  const editor = ctx.editor
  const readonly = useValue('dr-add-note-readonly', () => editor.getIsReadonly(), [editor])
  if (readonly || !can(ctx.role, 'edit', ctx.board.status)) return null
  return (
    <button
      type="button"
      className="dr-dock__tab"
      data-testid="dock-add-note"
      aria-label="Add a sticky note"
      title="Add a sticky note in the middle of the view (or press N, then Enter)"
      onClick={() => {
        onPress?.()
        // The board takes the keyboard first, so the new note's text field keeps it.
        editor.focus()
        editor.getContainer().focus({ preventScroll: true })
        placeAtCenter(editor, 'note')
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          d="M5 4h10l4 4v12H5z M15 4v4h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M12 11v6M9 14h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span className="dr-dock__label" aria-hidden="true">
        Add a sticky note
      </span>
    </button>
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
  const views = useMemo<DockPanelView[]>(
    () =>
      ctx
        ? panels.map((p) => ({
            id: p.id,
            label: p.label,
            icon: p.icon,
            ...(p.shortcutHint ? { shortcutHint: p.shortcutHint } : {}),
            render: (close: () => void) => <p.Component ctx={ctx} close={close} />,
          }))
        : [],
    [panels, ctx],
  )
  const editor = ctx?.editor
  if (!ctx || views.length === 0) return null
  return (
    <FeatureDockView
      panels={views}
      activePanel={ctx.activePanel}
      openPanel={ctx.openPanel}
      isEditingText={() => editor?.getEditingShapeId() != null}
      renderAddNote={(closeRail) => <AddNoteButton ctx={ctx} onPress={closeRail} />}
    />
  )
}
