// The main toolbar on the Excalidraw canvas (host slot `toolbar`; the tldraw page's ../Toolbar.tsx, COL-07):
// Select, Hand, Note, Text, Shape, Pen, Connector, Frame, Media (insert file), the tools other features
// register for the main toolbar (Comment, a vote tool…), and Templates, in that fixed order. The other
// tools (eraser, ellipse, diamond, line, highlighter, laser, lasso, and features' "more" tools) are one
// level down in "More"; the one used last takes the one extra slot before "More" (the eraser until then),
// so the main tools never move (PRF-09). People who cannot edit get only the tools their role may use:
// Select, Hand (CR-3A-6: a read-only Hand, canvas/api/parts/tools.ts) and the features' read-only tools.
//
// By canvas width, as tldraw lays out its own toolbar (./toolbar-layout.ts): fewer tools on a narrow
// canvas (the rest in "More", in order); the quick actions (./QuickActions.tsx) on top of the tools at
// 840 px or less; at 640 px or less a Styles button to the right of the tools, which opens the style
// panel above it (tldraw's MobileStylePanel). The bar never covers the navigation slot at the bottom left.
//
// A click never takes the keyboard from the board (the button's mousedown is prevented), so T or Delete
// right after clicking a tool still reach the board; the toolbar is still one Tab stop, and arrow keys,
// Home and End move along it (ARIA toolbar).
import { type ComponentType, type RefObject, useEffect, useRef } from 'react'
import type { CanvasFeatureContext, FeatureToolSpec } from '../../../canvas/api/index.ts'
import { currentPlatform, formatChord } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { TemplatesIcon } from '../icons.tsx'
import { MediaIcon, MoreIcon, TOOL_ICONS } from './icons.tsx'
import { pickFiles } from './insert-file.ts'
import { QuickActions } from './QuickActions.tsx'
import { hasStyleTarget, StylePanelBody, styleSwatchOf } from './StylePanel.tsx'
import { uxState } from './state.ts'
import { moveInToolbar } from './toolbar-keys.ts'
import { planToolbar, STYLES_BUTTON_MAX, useCanvasRoom } from './toolbar-layout.ts'

export interface BuiltInToolInfo {
  readonly id: string
  readonly label: string
  /** the key that picks it (canvas/input/keymap.ts TOOL_KEYS, or canvas-ux's own keys) */
  readonly key?: string
}

/** COL-07's main tools, in their fixed order. */
export const MAIN_TOOLS: readonly BuiltInToolInfo[] = [
  { id: 'select', label: 'Select', key: 'v' },
  { id: 'hand', label: 'Hand', key: 'h' },
  { id: 'note', label: 'Note', key: 'n' },
  { id: 'text', label: 'Text', key: 't' },
  { id: 'rectangle', label: 'Rectangle', key: 'r' },
  { id: 'freedraw', label: 'Pen', key: 'p' },
  { id: 'arrow', label: 'Connector', key: 'l' },
  { id: 'frame', label: 'Frame', key: 'f' },
]

/** One level down, in "More" (tldraw's order: …, line, highlight, laser). */
export const OVERFLOW_TOOLS: readonly BuiltInToolInfo[] = [
  { id: 'eraser', label: 'Eraser', key: 'e' },
  { id: 'ellipse', label: 'Ellipse', key: 'o' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'line', label: 'Line' },
  { id: 'highlight', label: 'Highlight', key: 'shift+d' },
  { id: 'laser', label: 'Laser', key: 'k' },
  { id: 'lasso', label: 'Lasso select' },
]

/** What people who cannot edit get of the built-in tools (tldraw's read-only tools; laser: CR-3A-8). */
export const READONLY_TOOLS: readonly BuiltInToolInfo[] = [
  { id: 'select', label: 'Select', key: 'v' },
  { id: 'hand', label: 'Hand', key: 'h' },
]

/** The toolbar's templates entry opens this dock panel (navigation's). */
export const TEMPLATES_PANEL = 'templates'

interface Slot {
  readonly id: string
  readonly testId: string
  readonly label: string
  readonly key?: string
  readonly icon: ComponentType
  readonly active: boolean
  readonly expanded?: boolean
  onSelect(): void
}

const title = (label: string, key?: string) =>
  key ? `${label} — ${formatChord(key, currentPlatform())}` : label

function ToolButton({ slot }: { slot: Slot }) {
  const Icon = slot.icon
  return (
    <button
      type="button"
      className="cux-tool"
      data-testid={slot.testId}
      data-tool={slot.id}
      aria-label={slot.label}
      title={title(slot.label, slot.key)}
      aria-pressed={slot.expanded === undefined ? slot.active : undefined}
      aria-expanded={slot.expanded}
      data-state={slot.active ? 'selected' : undefined}
      // the board keeps the keyboard: a click on a tool is not a move of the focus
      onMouseDown={(e) => e.preventDefault()}
      onClick={slot.onSelect}
    >
      <Icon />
    </button>
  )
}

/** The tools a feature registered for the toolbar, sorted, that this role may use. */
function featureTools(
  ctx: CanvasFeatureContext,
  group: 'main' | 'more',
  readOnly: boolean,
): FeatureToolSpec[] {
  return ctx.registries.tools
    .list()
    .filter((t) => t.toolbar?.group === group && (!readOnly || t.readOnlyAllowed))
    .sort((a, b) => (a.toolbar?.order ?? 0) - (b.toolbar?.order ?? 0) || (a.id < b.id ? -1 : 1))
}

/** A press anywhere but inside `refs` closes a popover. */
function useCloseOnOutsidePress(open: boolean, close: () => void, ...refs: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return
    const doc = refs[0]?.current?.ownerDocument ?? document
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && refs.some((r) => r.current?.contains(t))) return
      close()
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [open, close])
}

export function Toolbar({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const tool = useValue('cux-tool', () => canvas.tool(), [canvas])
  const readOnly = useValue('cux-readonly', () => canvas.readOnly(), [canvas])
  const moreOpen = useValue(state.moreOpen)
  const stylesOpen = useValue(state.stylesOpen)
  const lastOverflow = useValue(state.lastOverflowTool)
  const styleTarget = useValue('cux-style-target-any', () => hasStyleTarget(canvas), [canvas])
  const swatch = useValue('cux-style-swatch', () => styleSwatchOf(canvas), [canvas])
  const sel = useValue('cux-toolbar-sel', () => canvas.selection.join(' '), [canvas])
  const room = useCanvasRoom(canvas)
  const barRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const stylesRef = useRef<HTMLDivElement>(null)
  const stylesButtonRef = useRef<HTMLButtonElement>(null)

  // the folded style panel folds again when the selection changes (the wave-3 integration's rule)
  useEffect(() => {
    void sel
    state.stylesOpen.set(false)
  }, [sel, state])

  const pick = (id: string, overflow = false) => {
    if (overflow) state.lastOverflowTool.set(id)
    state.moreOpen.set(false)
    canvas.setTool(id)
    const doc = barRef.current?.ownerDocument
    // a keyboard user who tabbed here goes back to the board after choosing
    if (!doc?.activeElement || wrapRef.current?.contains(doc.activeElement) || doc.activeElement === doc.body)
      canvas.focus({ preventScroll: true })
  }

  const builtIn = (t: BuiltInToolInfo): Slot => ({
    id: t.id,
    testId: `tools.${t.id}`,
    label: t.label,
    key: t.key,
    icon: TOOL_ICONS[t.id] ?? MoreIcon,
    active: tool === t.id,
    onSelect: () => pick(t.id),
  })
  const featureSlot = (t: FeatureToolSpec): Slot => ({
    id: t.id,
    testId: `tools.${t.id}`,
    label: t.label,
    key: t.kbd?.[0],
    icon: t.toolbar?.icon ?? MoreIcon,
    active: tool === t.id,
    onSelect: () => pick(t.id),
  })
  const main: Slot[] = []
  if (readOnly) {
    for (const t of READONLY_TOOLS) main.push(builtIn(t))
    for (const t of featureTools(ctx, 'main', true)) main.push(featureSlot(t))
    for (const t of featureTools(ctx, 'more', true)) main.push(featureSlot(t))
  } else {
    for (const t of MAIN_TOOLS) main.push(builtIn(t))
    main.push({
      id: 'asset',
      testId: 'tools.asset',
      label: 'Media',
      key: 'mod+u',
      icon: MediaIcon,
      active: false,
      onSelect: () => {
        state.moreOpen.set(false)
        void pickFiles(ctx)
      },
    })
    for (const t of featureTools(ctx, 'main', false)) main.push(featureSlot(t))
    if (ctx.registries.panels.get(TEMPLATES_PANEL)) {
      const open = ctx.activePanel === TEMPLATES_PANEL
      main.push({
        id: 'dr-templates',
        testId: 'tools.dr-templates',
        label: 'Templates',
        icon: TemplatesIcon,
        active: open,
        onSelect: () => {
          state.moreOpen.set(false)
          ctx.openPanel(open ? null : TEMPLATES_PANEL)
        },
      })
    }
  }
  const overflow: Slot[] = readOnly
    ? []
    : [...OVERFLOW_TOOLS.map(builtIn), ...featureTools(ctx, 'more', false).map(featureSlot)]
  const ordered = [...main, ...overflow]
  const planFor = (lastUsed: Slot | null) =>
    planToolbar({
      ordered,
      mainCount: main.length,
      lastUsed,
      room,
      editor: !readOnly,
      styles: true,
    })
  let plan = planFor(
    overflow.find((s) => s.id === lastOverflow) ?? ordered.find((s) => s.id === lastOverflow) ?? null,
  )
  // the tool in use is always on the bar (tldraw keeps the active overflow tool in the extra slot)
  const activeHidden = plan.more.find((s) => s.active)
  if (activeHidden) plan = planFor(activeHidden)
  const hiddenIds = new Set(plan.more.map((s) => s.id))
  // a pick from "More" of a main tool or an overflow tool remembers it for the extra slot
  const moreSlots = plan.more.map((s) => ({
    ...s,
    testId: `tools.more.${s.id}`,
    onSelect: () => {
      if (s.id === 'asset' || s.id === 'dr-templates') return s.onSelect()
      pick(s.id, true)
    },
  }))

  useCloseOnOutsidePress(moreOpen, () => state.moreOpen.set(false), moreRef, barRef)
  useCloseOnOutsidePress(stylesOpen, () => state.stylesOpen.set(false), stylesRef, stylesButtonRef)
  // the Styles button goes away on a wider canvas: so does its panel
  useEffect(() => {
    if (!plan.stylesButton && stylesOpen) state.stylesOpen.set(false)
  }, [plan.stylesButton, stylesOpen, state])

  const phone = room.width <= STYLES_BUTTON_MAX
  return (
    <div
      ref={wrapRef}
      className="cux-toolbar-wrap"
      data-quick={plan.quickOnToolbar ? 'toolbar' : undefined}
      data-phone={phone ? 'true' : undefined}
      style={plan.shift ? { transform: `translateX(${Math.round(plan.shift)}px)` } : undefined}
    >
      {moreOpen && moreSlots.length > 0 && (
        <div
          ref={moreRef}
          className="cux-toolbar-more"
          role="toolbar"
          aria-label="More tools"
          data-testid="tools.more-content"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              state.moreOpen.set(false)
              barRef.current?.querySelector<HTMLButtonElement>('[data-testid="tools.more-button"]')?.focus()
              return
            }
            moveInToolbar(e.nativeEvent, moreRef.current)
          }}
        >
          {moreSlots.map((s) => (
            <ToolButton key={s.id} slot={s} />
          ))}
        </div>
      )}
      {stylesOpen && plan.stylesButton && (
        <div
          ref={stylesRef}
          className="cux-toolbar-styles"
          role="dialog"
          aria-label="Styles"
          data-testid="mobile-styles.content"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            state.stylesOpen.set(false)
            stylesButtonRef.current?.focus()
          }}
        >
          <StylePanelBody ctx={ctx} />
        </div>
      )}
      {plan.quickOnToolbar && <QuickActions ctx={ctx} phone={phone} indent={plan.quickIndent} />}
      <div className="cux-toolbar-row">
        <div
          ref={barRef}
          className="cux-toolbar"
          role="toolbar"
          aria-label="Tools"
          data-testid="main-toolbar"
          onKeyDown={(e) => moveInToolbar(e.nativeEvent, barRef.current)}
        >
          {plan.shown.map((s) => (
            <ToolButton key={s.id} slot={s} />
          ))}
          {hiddenIds.size > 0 && (
            <ToolButton
              slot={{
                id: 'more',
                testId: 'tools.more-button',
                label: 'More',
                icon: MoreIcon,
                active: moreOpen,
                expanded: moreOpen,
                onSelect: () => {
                  state.stylesOpen.set(false)
                  state.moreOpen.set(!moreOpen)
                },
              }}
            />
          )}
        </div>
        {plan.stylesButton && (
          <button
            ref={stylesButtonRef}
            type="button"
            className="cux-style-toggle"
            data-testid="mobile-styles.button"
            aria-label="Styles"
            title="Styles"
            aria-expanded={stylesOpen}
            aria-haspopup="dialog"
            disabled={!styleTarget}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              state.moreOpen.set(false)
              state.stylesOpen.set(!stylesOpen)
            }}
          >
            <span
              className="cux-style-toggle__swatch"
              aria-hidden="true"
              style={{ background: styleTarget && swatch ? swatch : 'var(--dr-ink-2)' }}
            />
          </button>
        )}
      </div>
    </div>
  )
}
