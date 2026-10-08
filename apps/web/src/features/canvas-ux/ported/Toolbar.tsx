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
// right after clicking a tool still reach the board; the toolbar is one Tab stop (a roving tab index, W5-42),
// and arrow keys, Home and End move along it (ARIA toolbar). Each tool says its key (`aria-keyshortcuts`
// and its tooltip, W5-50).
//
// The wave-5 review: More works from the keyboard (W5-22): Enter, Space or ArrowUp on it opens a menu of
// tool picks right after the tools in the DOM, on its first tool (or the one in use); arrows move, Enter
// picks, Esc closes it and gives More the keyboard back, Tab leaves it closed; a canvas press or another
// tool closes it. It holds D4's polygon tools (./polygons.ts) in tldraw's order. On a canvas wider than
// 840 px Undo and Redo hang left of the tools (W5-33, ./QuickActions.tsx HistoryBar).
import { type ComponentType, type RefObject, useEffect, useId, useRef } from 'react'
import type { CanvasFeatureContext, FeatureToolSpec } from '../../../canvas/api/index.ts'
import { currentPlatform, formatChord } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { TemplatesIcon } from '../icons.tsx'
import { setToolLock } from './commands.ts'
import { MediaIcon, MoreIcon, TOOL_ICONS } from './icons.tsx'
import { pickFiles } from './insert-file.ts'
import { POLYGON_TOOLS } from './polygons.ts'
import { HistoryBar, QuickActions } from './QuickActions.tsx'
import { hasStyleTarget, StylePanelBody, styleSwatchOf } from './StylePanel.tsx'
import { uxState } from './state.ts'
import { toolLock } from './tool-lock.ts'
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

const polygon = (id: string): BuiltInToolInfo => {
  const t = POLYGON_TOOLS.find((p) => p.id === id)
  return { id, label: t?.label ?? id }
}

/**
 * One level down, in "More" (tldraw's order: eraser, the geo shapes, line, highlight, laser). D4: the geo
 * shapes Excalidraw has no type for are canvas-ux's polygon tools (./polygons.ts).
 */
export const OVERFLOW_TOOLS: readonly BuiltInToolInfo[] = [
  { id: 'eraser', label: 'Eraser', key: 'e' },
  { id: 'ellipse', label: 'Ellipse', key: 'o' },
  polygon('triangle'),
  { id: 'diamond', label: 'Diamond' },
  polygon('hexagon'),
  polygon('rhombus'),
  polygon('star'),
  polygon('cloud'),
  polygon('heart'),
  polygon('arrow-left'),
  polygon('arrow-up'),
  polygon('arrow-down'),
  polygon('arrow-right'),
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
  /** K2-2: the tool lock is on and this is the tool in use (it stays picked after each placement) */
  readonly locked?: boolean
  /** the More button: the id of the popover it opens */
  readonly controls?: string
  onSelect(e?: { readonly detail: number }): void
}

const title = (label: string, key?: string) =>
  key ? `${label} — ${formatChord(key, currentPlatform())}` : label

/** The `aria-keyshortcuts` value of a Lobby chord (W5-50: the tools say their keys again). */
export function ariaKeys(key: string | undefined): string | undefined {
  if (!key) return undefined
  return key
    .split('+')
    .map((p) => (p === 'mod' ? (currentPlatform() === 'mac' ? 'Meta' : 'Control') : p))
    .map((p) => (p.length === 1 ? p.toUpperCase() : p[0]?.toUpperCase() + p.slice(1)))
    .join('+')
}

function ToolButton({
  slot,
  menuItem = false,
  tabIndex,
}: {
  slot: Slot
  /** an item of the More popover (role menuitemradio) */
  menuItem?: boolean
  /** roving tab index (W5-42): one Tab stop per bar */
  tabIndex?: number
}) {
  const Icon = slot.icon
  const common = {
    type: 'button' as const,
    className: 'cux-tool',
    'data-testid': slot.testId,
    'data-tool': slot.id,
    'aria-label': slot.label,
    'aria-keyshortcuts': ariaKeys(slot.key),
    title: slot.locked
      ? `${title(slot.label, slot.key)} (tool lock on: Q to turn it off)`
      : title(slot.label, slot.key),
    'data-state': slot.active ? 'selected' : undefined,
    'data-locked': slot.locked ? 'true' : undefined,
    tabIndex,
    // the board keeps the keyboard: a click on a tool is not a move of the focus
    onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
    onClick: (e: { detail: number }) => slot.onSelect({ detail: e.detail }),
  }
  if (menuItem)
    return (
      <button {...common} role="menuitemradio" aria-checked={slot.active}>
        <Icon />
      </button>
    )
  return (
    <button
      {...common}
      aria-pressed={slot.expanded === undefined ? slot.active : undefined}
      aria-expanded={slot.expanded}
      aria-haspopup={slot.controls ? 'menu' : undefined}
      aria-controls={slot.controls && slot.expanded ? slot.controls : undefined}
    >
      <Icon />
    </button>
  )
}

/**
 * W5-42: a bar's roving tab stop: the pressed button, else the first. The bar is one Tab stop and the
 * arrow keys move inside it (./toolbar-keys.ts).
 */
export function rovingIndex(slots: readonly { readonly active: boolean }[]): number {
  const i = slots.findIndex((s) => s.active)
  return i < 0 ? 0 : i
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
  const locked = useValue(toolLock)
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
  const moreId = useId()

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
    locked: locked && tool === t.id,
    onSelect: (e) => {
      // K2-2: a double-click on a tool keeps it picked (the tool lock; Q does the same)
      if ((e?.detail ?? 1) >= 2 && t.id !== 'select' && t.id !== 'hand' && !readOnly) setToolLock(ctx, true)
      pick(t.id)
    },
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
  // W5-22: a tool picked any other way (a key, the canvas) closes More too
  useEffect(() => {
    void tool
    state.moreOpen.set(false)
  }, [tool, state])
  // W5-22: opened from the keyboard, More gives its first tool (or the one in use) the keyboard
  const focusMore = useRef(false)
  useEffect(() => {
    if (!moreOpen || !focusMore.current) return
    focusMore.current = false
    const items = [...(moreRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    ;(items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
  }, [moreOpen])
  // W5-22: Escape closes More wherever the keyboard is (the board, the More button), and the keyboard goes
  // back to More when it was inside the popover
  useEffect(() => {
    if (!moreOpen) return
    const doc = wrapRef.current?.ownerDocument ?? document
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const inside = !!moreRef.current?.contains(doc.activeElement)
      const onMore = doc.activeElement === moreButton()
      state.moreOpen.set(false)
      if (inside || onMore) {
        e.preventDefault()
        e.stopPropagation()
        moreButton()?.focus()
      }
    }
    doc.addEventListener('keydown', onKey, true)
    return () => doc.removeEventListener('keydown', onKey, true)
  }, [moreOpen, state])
  const moreButton = () =>
    barRef.current?.querySelector<HTMLButtonElement>('[data-testid="tools.more-button"]') ?? null

  const phone = room.width <= STYLES_BUTTON_MAX
  const shownTab = rovingIndex(plan.shown)
  const moreTab = rovingIndex(moreSlots)
  return (
    <div
      ref={wrapRef}
      className="cux-toolbar-wrap"
      data-quick={plan.quickOnToolbar ? 'toolbar' : undefined}
      data-phone={phone ? 'true' : undefined}
      data-tool-size={plan.toolPx}
      style={plan.shift ? { transform: `translateX(${Math.round(plan.shift)}px)` } : undefined}
    >
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
        {plan.historyBar && <HistoryBar ctx={ctx} />}
        <div
          ref={barRef}
          className="cux-toolbar"
          role="toolbar"
          aria-label="Tools"
          data-testid="main-toolbar"
          onKeyDown={(e) => {
            // W5-22: ArrowUp on More opens it from the keyboard
            if (e.key === 'ArrowUp' && e.target === moreButton() && !moreOpen) {
              e.preventDefault()
              state.stylesOpen.set(false)
              focusMore.current = true
              state.moreOpen.set(true)
              return
            }
            moveInToolbar(e.nativeEvent, barRef.current)
          }}
          onFocus={(e) => {
            // W5-42: the button that has the keyboard is the bar's one Tab stop until the bar re-renders
            for (const b of barRef.current?.querySelectorAll<HTMLButtonElement>(':scope > button') ?? [])
              b.tabIndex = b === (e.target as Element) ? 0 : -1
          }}
        >
          {plan.shown.map((s, i) => (
            <ToolButton key={s.id} slot={s} tabIndex={i === shownTab ? 0 : -1} />
          ))}
          {hiddenIds.size > 0 && (
            <ToolButton
              tabIndex={-1}
              slot={{
                id: 'more',
                testId: 'tools.more-button',
                label: 'More',
                icon: MoreIcon,
                active: moreOpen,
                expanded: moreOpen,
                controls: moreId,
                onSelect: (e) => {
                  state.stylesOpen.set(false)
                  // a keyboard activation (Enter, Space: a click of detail 0) moves into the popover
                  focusMore.current = !moreOpen && (e?.detail ?? 1) === 0
                  state.moreOpen.set(!moreOpen)
                },
              }}
            />
          )}
        </div>
        {moreOpen && moreSlots.length > 0 && (
          // W5-22: right after More in the DOM (and the Tab order), a menu of tool picks
          <div
            ref={moreRef}
            id={moreId}
            className="cux-toolbar-more"
            role="menu"
            aria-label="More tools"
            aria-orientation="horizontal"
            data-testid="tools.more-content"
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                // leaving the menu closes it; the keyboard goes on from More
                state.moreOpen.set(false)
                return
              }
              moveInToolbar(e.nativeEvent, moreRef.current)
            }}
            onBlur={(e) => {
              const to = e.relatedTarget as Node | null
              if (to && !moreRef.current?.contains(to) && !barRef.current?.contains(to))
                state.moreOpen.set(false)
            }}
          >
            {moreSlots.map((s, i) => (
              <ToolButton key={s.id} slot={s} menuItem tabIndex={i === moreTab ? 0 : -1} />
            ))}
          </div>
        )}
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
