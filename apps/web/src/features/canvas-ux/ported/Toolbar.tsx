// The main toolbar on the Excalidraw canvas (host slot `toolbar`; the tldraw page's ../Toolbar.tsx, COL-07):
// Select, Hand, Note, Text, Shape, Pen, Connector, Frame, Media (insert file), the tools other features
// register for the main toolbar (Comment, a vote tool…), and Templates, in that fixed order. The other
// tools (eraser, ellipse, diamond, line, laser, lasso, and features' "more" tools) are one level down in
// "More"; the one used last takes the one extra slot before "More" (the eraser until then), so the main
// tools never move (PRF-09). People who cannot edit get only the tools their role may use.
//
// A click never takes the keyboard from the board (the button's mousedown is prevented), so T or Delete
// right after clicking a tool still reach the board; the toolbar is still one Tab stop, and arrow keys,
// Home and End move along it (ARIA toolbar).
import { type ComponentType, useEffect, useRef } from 'react'
import type { CanvasFeatureContext, FeatureToolSpec } from '../../../canvas/api/index.ts'
import { currentPlatform, formatChord } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { TemplatesIcon } from '../icons.tsx'
import { MediaIcon, MoreIcon, TOOL_ICONS } from './icons.tsx'
import { pickFiles } from './insert-file.ts'
import { uxState } from './state.ts'
import { moveInToolbar } from './toolbar-keys.ts'

export interface BuiltInToolInfo {
  readonly id: string
  readonly label: string
  /** the key the allowlist routes to it (canvas/input/keymap.ts TOOL_KEYS) */
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

/** One level down, in "More". */
export const OVERFLOW_TOOLS: readonly BuiltInToolInfo[] = [
  { id: 'eraser', label: 'Eraser', key: 'e' },
  { id: 'ellipse', label: 'Ellipse', key: 'o' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'line', label: 'Line' },
  { id: 'laser', label: 'Laser', key: 'k' },
  { id: 'lasso', label: 'Lasso select' },
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

export function Toolbar({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const tool = useValue('cux-tool', () => canvas.tool(), [canvas])
  const readOnly = useValue('cux-readonly', () => canvas.readOnly(), [canvas])
  const moreOpen = useValue(state.moreOpen)
  const lastOverflow = useValue(state.lastOverflowTool)
  const barRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)

  const pick = (id: string, overflow = false) => {
    if (overflow) state.lastOverflowTool.set(id)
    state.moreOpen.set(false)
    canvas.setTool(id)
    const doc = barRef.current?.ownerDocument
    // a keyboard user who tabbed here goes back to the board after choosing
    if (!doc?.activeElement || barRef.current?.contains(doc.activeElement) || doc.activeElement === doc.body)
      canvas.focus({ preventScroll: true })
  }

  const slots: Slot[] = []
  const builtIn = (t: BuiltInToolInfo, overflow = false): Slot => ({
    id: t.id,
    testId: `tools.${t.id}`,
    label: t.label,
    key: t.key,
    icon: TOOL_ICONS[t.id] ?? MoreIcon,
    active: tool === t.id,
    onSelect: () => pick(t.id, overflow),
  })
  const featureSlot = (t: FeatureToolSpec, overflow = false): Slot => ({
    id: t.id,
    testId: `tools.${t.id}`,
    label: t.label,
    key: t.kbd?.[0],
    icon: t.toolbar?.icon ?? MoreIcon,
    active: tool === t.id,
    onSelect: () => pick(t.id, overflow),
  })
  if (readOnly) {
    slots.push(builtIn(MAIN_TOOLS[0] as BuiltInToolInfo))
    for (const t of featureTools(ctx, 'main', true)) slots.push(featureSlot(t))
    for (const t of featureTools(ctx, 'more', true)) slots.push(featureSlot(t))
  } else {
    for (const t of MAIN_TOOLS) slots.push(builtIn(t))
    slots.push({
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
    for (const t of featureTools(ctx, 'main', false)) slots.push(featureSlot(t))
    if (ctx.registries.panels.get(TEMPLATES_PANEL)) {
      const open = ctx.activePanel === TEMPLATES_PANEL
      slots.push({
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
    : [
        ...OVERFLOW_TOOLS.map((t) => builtIn(t, true)),
        ...featureTools(ctx, 'more', false).map((t) => featureSlot(t, true)),
      ]
  const extra = overflow.find((s) => s.id === lastOverflow) ?? overflow[0]

  // "More" closes on Escape and on a press anywhere else
  useEffect(() => {
    if (!moreOpen) return
    const doc = barRef.current?.ownerDocument ?? document
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && (moreRef.current?.contains(t) || barRef.current?.contains(t))) return
      state.moreOpen.set(false)
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [moreOpen, state])

  return (
    <div className="cux-toolbar-wrap">
      {moreOpen && overflow.length > 0 && (
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
          {overflow.map((s) => (
            <ToolButton key={s.id} slot={{ ...s, testId: `tools.more.${s.id}` }} />
          ))}
        </div>
      )}
      <div
        ref={barRef}
        className="cux-toolbar"
        role="toolbar"
        aria-label="Tools"
        data-testid="main-toolbar"
        onKeyDown={(e) => moveInToolbar(e.nativeEvent, barRef.current)}
      >
        {slots.map((s) => (
          <ToolButton key={s.id} slot={s} />
        ))}
        {extra && <ToolButton key={`extra-${extra.id}`} slot={extra} />}
        {overflow.length > 0 && (
          <ToolButton
            slot={{
              id: 'more',
              testId: 'tools.more-button',
              label: 'More',
              icon: MoreIcon,
              active: moreOpen,
              expanded: moreOpen,
              onSelect: () => state.moreOpen.set(!moreOpen),
            }}
          />
        )}
      </div>
    </div>
  )
}
