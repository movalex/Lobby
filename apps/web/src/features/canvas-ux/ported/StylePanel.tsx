// The style panel on the Excalidraw canvas (host slot `stylePanel`; the tldraw page's ../StylePanel.tsx
// with tldraw's DefaultStylePanel content, rebuilt on canvas/api `styles`):
//  - RETRO-20 / F24a: it shows only while something is selected or a creation tool is picked; R16: never
//    for a selection of frames only, and the opacity slider gets a visible "Opacity" label when it is the
//    only control (an image, a file card);
//  - COL-06: a selection of sticky notes gets Lobby's note palette as the notes will look (fill and ink),
//    "Paper" (white) included; one pick recolours every selected note in one undo step;
//  - everything else: tldraw's controls with tldraw's names (colour, opacity, fill, dash, size, font,
//    alignment, label alignment, arrowheads, line kind), mapped to the engine's fields by
//    ./style-vocabulary.ts. Every pick is one undo step and sets the style of the next shapes too.
// People who cannot edit get no style panel.
// The wave-5 review: one Tab stop per control, arrows inside (W5-42); the font buttons drawn in their own
// faces, icon arrowhead pickers, a visible opacity label with its value (W5-40); the note palette's legend in
// Lobby's muted ink in dark mode (W5-41, canvas-tools.css); D4's polygons styled on their outline, their
// see-through holder taking only the label's text styles (./polygons.ts); the folded panel on a low canvas
// (W5-46, ./toolbar-layout.ts stylesFold).
import {
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type {
  ArrowKind,
  CanvasElement,
  CanvasFeatureContext,
  LobbyCanvas,
  StyleValues,
} from '../../../canvas/api/index.ts'
import { items } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { NOTE_PALETTE, type NoteColorName } from '../palette.ts'
import { selectedRoots } from './commands.ts'
import { TOOL_ICONS } from './icons.tsx'
import { isPolygonHolder, isPolygonLine, POLYGON_TOOLS } from './polygons.ts'
import { uxState } from './state.ts'
import { LEFT_INSET, setStylePanelOpen, stylePanelOpen, stylePanelSide } from './style-panel-place.ts'
import {
  ALIGN_LABELS,
  ALIGNS,
  type AlignName,
  ARROWHEAD_LABELS,
  ARROWHEADS,
  type ArrowheadName,
  arrowheadField,
  arrowheadNameOf,
  COLOR_LABELS,
  COLOR_NAMES,
  type ColorName,
  colorNameOf,
  DASH_LABELS,
  DASHES,
  dashFields,
  dashNameOf,
  FILL_LABELS,
  FILLS,
  type FillName,
  FONT_FACE,
  FONT_FAMILY,
  FONT_LABELS,
  FONTS,
  FREEDRAW_WIDTH,
  fillNameOf,
  fontNameOf,
  HIGHLIGHT_SHADES,
  highlightNameOf,
  LABEL_SIZE,
  NEXT_STROKE_WIDTH,
  NOTE_FONT,
  NOTE_SIDE,
  noteColorOf,
  noteFillOf,
  noteSizeNameOf,
  OPACITY_STEPS,
  opacityStepOf,
  SHADES,
  SIZE_LABELS,
  SIZES,
  type SizeName,
  STROKE_WIDTH,
  shapeFields,
  sizeNameOf,
  TEXT_SIZE,
  THEME_FILTER,
  VALIGN_LABELS,
  VALIGNS,
  type VAlignName,
} from './style-vocabulary.ts'
import { moveInToolbar } from './toolbar-keys.ts'
import { stylesFold, useCanvasRoom } from './toolbar-layout.ts'

/** The next shape's shape picker (the shape tools): the engine's three, then D4's polygons. */
const GEO_OPTIONS: readonly string[] = ['rectangle', 'ellipse', 'diamond', ...POLYGON_TOOLS.map((t) => t.id)]
const GEO_LABELS: Readonly<Record<string, string>> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  ...Object.fromEntries(POLYGON_TOOLS.map((t) => [t.id, t.label])),
}

/** What the panel styles: an element kind, or the kind the picked tool makes. */
export type StyleKind =
  | 'note'
  | 'text'
  | 'shape'
  | 'arrow'
  | 'line'
  | 'draw'
  | 'highlight'
  | 'frame'
  | 'image'
  /** P-017: a link card or a board card (a rectangle Lobby draws as a card): never styled as a shape */
  | 'card'
  | 'other'

/**
 * Creation tools whose next shape the panel sets (Lobby tool names). CR-3A-7: the note tool's next note
 * takes the note colour, the label size and the font picked here (`styles.setNext`: the note palette's
 * fill as `noteColor`, the label size from LABEL_SIZE), and the text tool's next text its colour, size,
 * font and alignment (sizes from TEXT_SIZE), as on tldraw.
 */
export const STYLED_TOOLS: Readonly<Record<string, StyleKind>> = {
  note: 'note',
  text: 'text',
  rectangle: 'shape',
  ellipse: 'shape',
  diamond: 'shape',
  arrow: 'arrow',
  line: 'line',
  freedraw: 'draw',
  // the highlighter's next stroke takes a colour only (its width and opacity are the highlighter's)
  highlight: 'highlight',
  // D4: the polygon tools' shapes take the shapes' style
  ...Object.fromEntries(POLYGON_TOOLS.map((t) => [t.id, 'shape' as const])),
}

/** P-017: the cards Lobby draws over a rectangle (file-card/ported/link-cards.tsx): no shape styles. */
const CARD_KINDS: ReadonlySet<unknown> = new Set(['link-card', 'board-card'])

export function kindOf(el: CanvasElement): StyleKind {
  // D4: a polygon's outline is a shape (colour, fill, dash, size); its holder is set apart in targetOf
  if (isPolygonLine(el)) return 'shape'
  const lobbyKind = (el.customData as { lobby?: { kind?: unknown } } | undefined)?.lobby?.kind
  if (CARD_KINDS.has(lobbyKind)) return 'card'
  switch (items.itemKindOf(el)) {
    case 'note':
      return 'note'
    case 'text':
      return 'text'
    case 'shape':
      return 'shape'
    case 'arrow':
      return 'arrow'
    case 'line':
      return 'line'
    case 'draw':
    case 'highlight':
      return 'draw'
    case 'frame':
      return 'frame'
    case 'image':
    case 'file-card':
      return 'image'
    default:
      return 'other'
  }
}

/** RETRO-20 / R16: shown for a selection (not frames or cards only, P-017) or a creation tool. Pure. */
export function showStylePanel(kinds: readonly StyleKind[], toolId: string | null): boolean {
  if (kinds.length) return !kinds.every((k) => k === 'frame' || k === 'card')
  return toolId !== null && toolId in STYLED_TOOLS
}

/** What a pick styles (wave M, M1-4: the selection bar's tier one picks through the same functions). */
export interface Target {
  readonly els: readonly CanvasElement[]
  /** D4: selected polygons' see-through holders: only their labels take text styles (./polygons.ts) */
  readonly holders: readonly CanvasElement[]
  readonly kinds: ReadonlySet<StyleKind>
  /** no selection: the picked tool's next shape */
  readonly next: boolean
}

export function targetOf(canvas: LobbyCanvas): Target | null {
  const roots = selectedRoots(canvas)
  const holders = roots.filter((e) => isPolygonHolder(e, canvas))
  // frames and cards (P-017) are not styled: what else is selected is
  const els = roots.filter((e) => kindOf(e) !== 'frame' && kindOf(e) !== 'card' && !holders.includes(e))
  const selectedKinds = roots.filter((e) => !holders.includes(e)).map(kindOf)
  const tool = canvas.tool()
  if (!showStylePanel(selectedKinds, tool)) return null
  if (els.length) return { els, holders, kinds: new Set(els.map(kindOf)), next: false }
  const k = tool ? STYLED_TOOLS[tool] : undefined
  return k ? { els: [], holders: [], kinds: new Set([k]), next: true } : null
}

const has = (t: Target, ...k: StyleKind[]) => k.some((x) => t.kinds.has(x))

// ---- writing ---------------------------------------------------------------------------------------------

type Writes = Map<string, Record<string, unknown>>

function write(canvas: LobbyCanvas, label: string, writes: Writes, joinPrevious = false) {
  if (!writes.size || canvas.readOnly()) return
  canvas.transact(
    label,
    (tx) => {
      for (const [id, fields] of writes) tx.update(id, fields)
    },
    joinPrevious ? { joinPrevious: true } : undefined,
  )
}

const put = (w: Writes, id: string, f: Record<string, unknown>) => w.set(id, { ...(w.get(id) ?? {}), ...f })

function labelOf(canvas: LobbyCanvas, el: CanvasElement) {
  return items.labelOf(el, (x) => canvas.get(x))
}

/** A colour pick: notes take the note fill, shapes a stroke with their fill in the same colour, the rest a stroke. */
export function pickColor(canvas: LobbyCanvas, t: Target, name: ColorName) {
  const w: Writes = new Map()
  const c = SHADES[name]
  for (const el of t.els) {
    const k = kindOf(el)
    if (k === 'note') {
      if ((el as { backgroundColor?: string }).backgroundColor !== noteFillOf(name))
        put(w, el.id, { backgroundColor: noteFillOf(name) })
    } else if (k === 'shape') {
      const fill = fillNameOf(
        (el as { backgroundColor?: string }).backgroundColor,
        (el as { fillStyle?: string }).fillStyle,
      )
      const f = shapeFields(name, fill ?? 'none')
      put(
        w,
        el.id,
        fill && fill !== 'none'
          ? { strokeColor: f.strokeColor, backgroundColor: f.backgroundColor }
          : { strokeColor: c.solid },
      )
    } else if (k === 'text' || k === 'arrow' || k === 'line' || k === 'draw') {
      // a highlight stroke keeps the highlighter's shade of the colour
      const highlight = items.itemKindOf(el) === 'highlight'
      put(w, el.id, { strokeColor: highlight ? HIGHLIGHT_SHADES[name] : c.solid })
    }
  }
  write(canvas, 'color', w)
  // the highlighter's next stroke: its shade of the colour (the pen's own colour comes back after it)
  if (t.next && has(t, 'highlight')) {
    canvas.styles.setNext({ strokeColor: HIGHLIGHT_SHADES[name] })
    return
  }
  // the next shapes take the colour too (a pick on notes alone is only theirs: the note palette)
  if (t.next || t.els.some((e) => kindOf(e) !== 'note')) {
    const n = canvas.styles.next()
    const nextFill = fillNameOf(n.backgroundColor, n.fillStyle)
    canvas.styles.setNext(
      nextFill && nextFill !== 'none'
        ? { strokeColor: c.solid, backgroundColor: shapeFields(name, nextFill).backgroundColor }
        : { strokeColor: c.solid },
    )
  }
}

export function pickNoteColor(canvas: LobbyCanvas, t: Target, name: NoteColorName) {
  // the note tool's next note (CR-3A-7)
  if (t.next) {
    canvas.styles.setNext({ noteColor: noteFillOf(name) })
    return
  }
  const w: Writes = new Map()
  for (const el of t.els) if (kindOf(el) === 'note') put(w, el.id, { backgroundColor: noteFillOf(name) })
  write(canvas, 'note color', w)
}

export function pickFill(canvas: LobbyCanvas, t: Target, fill: FillName) {
  // K2-3: a fill picked here is the person's choice for the next shapes too (the light default steps aside)
  uxState(canvas).fillChosen.set(true)
  const w: Writes = new Map()
  for (const el of t.els) {
    if (kindOf(el) !== 'shape') continue
    const name = colorNameOf((el as { strokeColor?: string }).strokeColor) ?? 'black'
    const f = shapeFields(name, fill)
    put(w, el.id, { backgroundColor: f.backgroundColor, fillStyle: f.fillStyle })
  }
  write(canvas, 'fill', w)
  const nextName = colorNameOf(canvas.styles.next().strokeColor) ?? 'black'
  const f = shapeFields(nextName, fill)
  canvas.styles.setNext({ backgroundColor: f.backgroundColor, fillStyle: f.fillStyle })
}

export function pickPlain(
  canvas: LobbyCanvas,
  t: Target,
  label: string,
  fields: StyleValues,
  kinds: readonly StyleKind[],
  withLabels = false,
) {
  const w: Writes = new Map()
  for (const el of t.els) {
    if (!kinds.includes(kindOf(el))) continue
    put(w, el.id, fields as Record<string, unknown>)
    const l = withLabels ? labelOf(canvas, el) : undefined
    if (l) put(w, l.id, fields as Record<string, unknown>)
  }
  write(canvas, label, w)
  canvas.styles.setNext(fields)
}

/**
 * Text fields go through `styles.apply` (it lays the words out again); other fields join its step.
 * CR-3A-7: a note's label size and a free text's are two next sizes. With a selection, each kind's pick goes to
 * its own (`styles.apply` sends a font size to the kinds of text it is picked on); with the note or the text tool
 * picked, `setNext` writes the one the tool in hand makes (the port keeps the other: canvas/port-impl.ts), so a note's
 * L is never the next text's size.
 */
export function pickSize(canvas: LobbyCanvas, t: Target, size: SizeName) {
  const texts = t.els.filter((e) => kindOf(e) === 'text').map((e) => e.id)
  const notes = t.els.filter((e) => kindOf(e) === 'note').map((e) => e.id)
  let stepped = false
  if (texts.length) {
    canvas.styles.apply({ fontSize: TEXT_SIZE[size] }, texts)
    stepped = true
  }
  if (notes.length) {
    // P-011: a note's size is the note's (S/M/L/XL notes, as Miro's stickies), its words scaled with it
    const resize = () => canvas.styles.resizeNotes(NOTE_SIDE[size], NOTE_FONT[size], notes)
    // one undo step for the whole pick
    if (stepped) canvas.transact('note size', resize, { joinPrevious: true })
    else resize()
    stepped = true
  }
  const w: Writes = new Map()
  for (const el of t.els) {
    const k = kindOf(el)
    if (k === 'draw') put(w, el.id, { strokeWidth: FREEDRAW_WIDTH[size] })
    else if (['shape', 'arrow', 'line'].includes(k)) put(w, el.id, { strokeWidth: STROKE_WIDTH[size] })
  }
  write(canvas, 'size', w, stepped)
  if (!t.next) return
  // CR-3A-7: the note tool's next note takes a label size, the text tool's next text a font size
  if (has(t, 'note')) canvas.styles.setNext({ fontSize: LABEL_SIZE[size] })
  else if (has(t, 'text')) canvas.styles.setNext({ fontSize: TEXT_SIZE[size] })
  else canvas.styles.setNext({ strokeWidth: NEXT_STROKE_WIDTH[size] })
}

export function textTargets(t: Target) {
  return [
    ...t.els.filter((e) => ['text', 'note', 'shape', 'arrow'].includes(kindOf(e)) && !isPolygonLine(e)),
    ...t.holders,
  ].map((e) => e.id)
}

/**
 * One control's current value over several elements: undefined when none of them has it, 'mixed' when they
 * differ, else the one value (null: a value outside the vocabulary, e.g. a colour made elsewhere). Pure.
 */
export function sharedOf<T>(values: readonly (T | null)[]): T | 'mixed' | null | undefined {
  if (!values.length) return undefined
  const set = new Set(values)
  return set.size > 1 ? 'mixed' : (values[0] ?? null)
}

// ---- controls ------------------------------------------------------------------------------------------
//
// W5-42 (the wave-5 review): each control is ONE Tab stop (a roving tab index: the picked option, else the
// first), and the arrow keys, Home and End move inside it (./toolbar-keys.ts), as tldraw's style panel does.
// W5-40: the font buttons are drawn in their own face, the arrowheads are icon buttons (not native selects),
// and the opacity slider always says what it is and its value.

/** The roving tab index of option `i` of `options` whose picked value is `value`. Pure. */
export function rovingTab<T>(options: readonly T[], value: unknown, i: number): 0 | -1 {
  const at = options.indexOf(value as T)
  return i === (at < 0 ? 0 : at) ? 0 : -1
}

/** The keyboard inside one control: arrows, Home and End move between its buttons. */
const onGroupKey = (e: ReactKeyboardEvent<HTMLElement>) => moveInToolbar(e.nativeEvent, e.currentTarget)

function Segmented<T extends string>(props: {
  legend: string
  testPrefix: string
  options: readonly T[]
  labels: Readonly<Record<T, string>>
  /** 'mixed': the selection differs (the legend says so); null: none of the options (nothing pressed) */
  value: T | 'mixed' | null | undefined
  onPick(v: T): void
  /** icon buttons (the label is the button's name and tooltip) */
  icons?: Partial<Record<T, ComponentType>>
  /** each option's own font face (W5-40: the font buttons) */
  faces?: Partial<Record<T, string>>
}) {
  const icons = props.icons
  return (
    <fieldset className="cux-style__row" data-testid={`${props.testPrefix}`}>
      <legend className="cux-style__legend">
        {props.legend}
        {props.value === 'mixed' ? ' (mixed)' : ''}
      </legend>
      <div
        className={icons ? 'cux-style__options cux-style__options--icons' : 'cux-style__options'}
        role="toolbar"
        aria-label={props.legend}
        onKeyDown={onGroupKey}
      >
        {props.options.map((o, i) => {
          const Icon: ComponentType | undefined = icons?.[o]
          const face = props.faces?.[o]
          return (
            <button
              key={o}
              type="button"
              className={Icon ? 'cux-style__opt cux-style__opt--icon' : 'cux-style__opt'}
              data-testid={`${props.testPrefix}.${o}`}
              aria-pressed={props.value === o}
              aria-label={Icon ? props.labels[o] : undefined}
              title={Icon ? props.labels[o] : undefined}
              tabIndex={rovingTab(props.options, props.value, i)}
              style={face ? { fontFamily: `"${face}", var(--dr-font)` } : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onPick(o)}
            >
              {Icon ? <Icon /> : props.labels[o]}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

function NoteColorPicker({ canvas, t }: { canvas: LobbyCanvas; t: Target }) {
  const theme = useValue('cux-theme', () => canvas.theme(), [canvas])
  const current = useValue(
    'cux-note-color',
    () =>
      t.next
        ? // the note tool's next note (CR-3A-7)
          noteColorOf(canvas.styles.next().noteColor)
        : sharedOf(t.els.map((e) => noteColorOf((e as { backgroundColor?: string }).backgroundColor))),
    [canvas, t],
  )
  const names = NOTE_PALETTE.map((s) => s.name)
  return (
    <fieldset className="dr-note-palette" data-testid="note-palette">
      <legend className="dr-note-palette__legend">Note color{current === 'mixed' ? ' (mixed)' : ''}</legend>
      <div className="dr-note-palette__grid" role="toolbar" aria-label="Note color" onKeyDown={onGroupKey}>
        {NOTE_PALETTE.map((s, i) => (
          <button
            key={s.name}
            type="button"
            className="dr-note-palette__swatch"
            data-testid="note-color"
            data-color={s.name}
            aria-pressed={current === s.name}
            aria-label={`${s.label}${current === s.name ? ' (selected)' : ''}`}
            title={s.label}
            tabIndex={rovingTab(names, current, i)}
            // as the canvas draws it: the light values, through Excalidraw's dark filter in dark mode
            style={{
              background: s.light.fill,
              color: s.light.text,
              filter: theme === 'dark' ? THEME_FILTER : undefined,
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (current === s.name) return
              pickNoteColor(canvas, t, s.name)
            }}
          >
            <span aria-hidden="true">Aa</span>
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function ColorPicker({
  canvas,
  t,
  value,
  highlight = false,
}: {
  canvas: LobbyCanvas
  t: Target
  value: ColorName | 'mixed' | null | undefined
  /** the highlighter's swatches (its shade of each colour) */
  highlight?: boolean
}) {
  const theme = useValue('cux-theme', () => canvas.theme(), [canvas])
  return (
    <fieldset className="cux-style__row" data-testid="style.color">
      <legend className="cux-style__legend">Color{value === 'mixed' ? ' (mixed)' : ''}</legend>
      <div className="cux-style__swatches" role="toolbar" aria-label="Color" onKeyDown={onGroupKey}>
        {COLOR_NAMES.map((n, i) => (
          <button
            key={n}
            type="button"
            className="cux-style__swatch"
            data-testid={`style.color.${n}`}
            aria-pressed={value === n}
            aria-label={COLOR_LABELS[n]}
            title={COLOR_LABELS[n]}
            tabIndex={rovingTab(COLOR_NAMES, value, i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pickColor(canvas, t, n)}
          >
            <span
              className="cux-style__swatch-dot"
              style={{
                background: highlight ? HIGHLIGHT_SHADES[n] : SHADES[n].solid,
                filter: theme === 'dark' ? THEME_FILTER : undefined,
              }}
            />
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function OpacityPicker({
  canvas,
  t,
  value,
}: {
  canvas: LobbyCanvas
  t: Target
  value: number | 'mixed' | undefined
}) {
  const id = useId()
  const step =
    typeof value === 'number'
      ? OPACITY_STEPS.indexOf(opacityStepOf(value) as (typeof OPACITY_STEPS)[number])
      : OPACITY_STEPS.length - 1
  const shown = OPACITY_STEPS[Math.max(0, step)]
  return (
    <div className="cux-style__row cux-style__opacity">
      {/* W5-40 and R16: a visible label (with the value) whatever else the panel shows */}
      <label
        htmlFor={id}
        className="cux-style__legend cux-style__opacity-label"
        data-testid="style-opacity-label"
      >
        <span>Opacity</span>
        <span className="cux-style__value">{value === 'mixed' ? 'Mixed' : `${shown}%`}</span>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={OPACITY_STEPS.length - 1}
        step={1}
        value={Math.max(0, step)}
        data-testid="style.opacity"
        aria-valuetext={`${shown}%`}
        onChange={(e) => {
          const v = OPACITY_STEPS[Number(e.currentTarget.value)] ?? 100
          pickPlain(
            canvas,
            t,
            'opacity',
            { opacity: v },
            ['note', 'text', 'shape', 'arrow', 'line', 'draw', 'image'],
            true,
          )
        }}
      />
    </div>
  )
}

/** W5-40: an arrowhead's icon (a short line with the head at its right end; the start end mirrors it). */
function headIcon(name: ArrowheadName, end: 'start' | 'end'): ComponentType {
  const head: Record<ArrowheadName, ReactNode> = {
    none: null,
    arrow: <path d="M14 7l5 5-5 5" />,
    triangle: <path d="M13 7l7 5-7 5z" fill="currentColor" />,
    bar: <path d="M19 6v12" />,
    dot: <circle cx="17" cy="12" r="3" fill="currentColor" />,
    diamond: <path d="M16 8l4 4-4 4-4-4z" fill="currentColor" />,
  }
  const Icon = () => (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={end === 'start' ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d={name === 'none' || name === 'bar' ? 'M4 12h15' : 'M4 12h12'} />
      {head[name]}
    </svg>
  )
  return Icon
}
const headIcons = (end: 'start' | 'end') =>
  Object.fromEntries(ARROWHEADS.map((a) => [a, headIcon(a, end)])) as Record<ArrowheadName, ComponentType>
const HEAD_ICONS = { start: headIcons('start'), end: headIcons('end') }

function ArrowheadPicker({
  canvas,
  t,
  end,
  value,
}: {
  canvas: LobbyCanvas
  t: Target
  end: 'start' | 'end'
  value: ArrowheadName | 'mixed' | undefined
}) {
  const field = end === 'start' ? 'startArrowhead' : 'endArrowhead'
  return (
    <Segmented
      legend={end === 'start' ? 'Start arrowhead' : 'End arrowhead'}
      testPrefix={`style.arrowhead-${end}`}
      options={ARROWHEADS}
      labels={ARROWHEAD_LABELS}
      icons={HEAD_ICONS[end]}
      value={value}
      onPick={(name) =>
        pickPlain(canvas, t, 'arrowheads', { [field]: arrowheadField(name) } as StyleValues, ['arrow'])
      }
    />
  )
}

/**
 * The style panel host slot (top right). On a canvas of 640 px or less (tldraw's TABLET_SM) it folds: the
 * toolbar's Styles button (./Toolbar.tsx) opens the same panel above the toolbar, as tldraw's phone toolbar
 * does (MobileStylePanel), so here the slot shows nothing.
 */
export function StylePanel({ ctx }: { ctx: CanvasFeatureContext }) {
  const room = useCanvasRoom(ctx.canvas)
  // wave M (M1-3): it steps aside while a popover of the selection bar fits nowhere clear of it
  const yieldToBar = useValue(uxState(ctx.canvas).stylePanelYield)
  // P-021: only once asked for (the selection bar's Styles button; ./style-panel-place.ts)
  const open = useValue(stylePanelOpen)
  if (stylesFold(room) || yieldToBar || !open) return null
  return <PlacedStylePanel ctx={ctx} />
}

/** The selection's box on screen (client px) as a string the panel's placement re-runs on, or null. */
const selectionBoxKey = (canvas: LobbyCanvas): string | null => {
  const b = canvas.selection.length ? canvas.boundsOf(canvas.selection) : null
  if (!b) return null
  canvas.viewport.get()
  const a = canvas.sceneToScreen({ x: b.x, y: b.y })
  const z = canvas.sceneToScreen({ x: b.x + b.width, y: b.y + b.height })
  return [a.x, a.y, z.x - a.x, z.y - a.y].map(Math.round).join(',')
}

/**
 * P-021: the open panel, at the canvas's top right unless the selection is under it there; then at the top left,
 * under the board menu (./style-panel-place.ts `stylePanelSide`). A move of the panel, never of the camera.
 */
function PlacedStylePanel({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const ref = useRef<HTMLDivElement>(null)
  const sel = useValue('cux-style-avoid', () => selectionBoxKey(canvas), [canvas])
  const [shift, setShift] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const slot = el?.parentElement
    const host = canvas.container()
    if (!el || !slot || !host) return
    const place = () => {
      const r = slot.getBoundingClientRect()
      const c = host.getBoundingClientRect()
      const right = { x: r.left, y: r.top, w: r.width, h: r.height }
      const dx = c.left + LEFT_INSET.x - r.left
      const dy = c.top + LEFT_INSET.y - r.top
      const left = { x: r.left + dx, y: r.top + dy, w: r.width, h: r.height }
      const box = sel ? sel.split(',').map(Number) : null
      const selection = box ? { x: box[0] ?? 0, y: box[1] ?? 0, w: box[2] ?? 0, h: box[3] ?? 0 } : null
      const side = stylePanelSide(right, left, selection)
      setShift((prev) => {
        const next = side === 'left' ? { x: Math.round(dx), y: Math.round(dy) } : null
        return prev?.x === next?.x && prev?.y === next?.y ? prev : next
      })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [canvas, sel])
  return (
    <div
      ref={ref}
      className="cux-style-place"
      data-side={shift ? 'left' : 'right'}
      data-testid="style.panel-place"
      style={shift ? { transform: `translate(${shift.x}px, ${shift.y}px)` } : undefined}
    >
      <StylePanelBody ctx={ctx} onClose={() => closeStylePanel(ctx)} />
    </div>
  )
}

/** P-021: the panel's × (the keyboard goes back to the board, which keeps the selection). */
function closeStylePanel(ctx: CanvasFeatureContext) {
  setStylePanelOpen(false)
  ctx.canvas.focus({ preventScroll: true })
}

/** P-021: the open panel's ×. */
function CloseStyles({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="cux-style__close"
      data-testid="style.panel-close"
      aria-label="Hide styles"
      title="Hide styles"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClose}
    >
      <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true" focusable="false">
        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  )
}

/** Whether the style panel has something to style (a selection that is not only frames, or a styled tool). */
export const hasStyleTarget = (canvas: LobbyCanvas) => !canvas.readOnly() && targetOf(canvas) !== null

/**
 * The colour the Styles button shows (tldraw's MobileStylePanel): the selection's shared colour, else the
 * next shape's; null when mixed or none.
 */
export function styleSwatchOf(canvas: LobbyCanvas): string | null {
  const t = targetOf(canvas)
  if (!t) return null
  if (t.next) {
    const next = canvas.styles.next()
    return (has(t, 'note') ? next.noteColor : next.strokeColor) ?? null
  }
  const colors = new Set<string>()
  for (const el of t.els) {
    const k = kindOf(el)
    const c =
      k === 'note'
        ? (el as { backgroundColor?: string }).backgroundColor
        : (el as { strokeColor?: string }).strokeColor
    if (c) colors.add(c)
  }
  return colors.size === 1 ? ([...colors][0] ?? null) : null
}

/** The next connector's kind from the next style (the style panel's Line row while an arrow tool is picked). */
const nextArrowKind = (styles: { readonly arrowKind?: unknown }): ArrowKind | undefined =>
  styles.arrowKind === 'straight' || styles.arrowKind === 'curved' || styles.arrowKind === 'elbow'
    ? styles.arrowKind
    : undefined

/** K2-7: what an opacity-only selection is, in words ("Image", "3 images", "File", "2 files"). */
export function summaryKind(els: readonly CanvasElement[]): string {
  const images = els.every((e) => items.itemKindOf(e) === 'image')
  const word = images ? 'image' : 'file'
  return els.length === 1 ? `${word[0]?.toUpperCase()}${word.slice(1)}` : `${els.length} ${word}s`
}

export function StylePanelBody({ ctx, onClose }: { ctx: CanvasFeatureContext; onClose?: () => void }) {
  const { canvas } = ctx
  const readOnly = useValue('cux-readonly', () => canvas.readOnly(), [canvas])
  const t = useValue('cux-style-target', () => (readOnly ? null : targetOf(canvas)), [canvas, readOnly])
  const styles = useValue(
    'cux-styles',
    () => (t && !t.next ? canvas.styles.of(t.els.map((e) => e.id)) : t ? canvas.styles.next() : {}),
    [canvas, t],
  )
  if (!t) return null
  // K2-7 (UXD-09): images (and file cards) have opacity only: a single-row summary instead of a card around one
  // slider
  if (!t.next && t.els.length > 0 && t.els.every((e) => kindOf(e) === 'image'))
    return (
      <section
        className="cux-style cux-style--summary"
        aria-label="Styles"
        data-testid="style.panel"
        data-summary="image"
      >
        <span className="cux-style__summary-kind">{summaryKind(t.els)}</span>
        <OpacityPicker canvas={canvas} t={t} value={styles.opacity as number | 'mixed' | undefined} />
        {onClose && <CloseStyles onClose={onClose} />}
      </section>
    )
  // the highlighter's next stroke: its colour only (tldraw's highlighter has colour and size; the size here
  // is the highlighter's one width)
  if (t.next && has(t, 'highlight'))
    return (
      <section className="cux-style" aria-label="Styles" data-testid="style.panel">
        {onClose && <CloseStyles onClose={onClose} />}
        <div className="cux-style__section">
          <ColorPicker canvas={canvas} t={t} value={highlightNameOf(styles.strokeColor)} highlight />
        </div>
      </section>
    )
  // the note tool's next note (CR-3A-7): the note palette, the label size and the font
  const noteTool = t.next && has(t, 'note')
  const allNotes = noteTool || (!t.next && t.els.every((e) => kindOf(e) === 'note'))
  // the text tool's next text (CR-3A-7): colour, size, font and alignment (no opacity: a text takes none)
  const textTool = t.next && has(t, 'text')
  const strokeKinds = has(t, 'shape', 'text', 'arrow', 'line', 'draw')
  const color = (() => {
    if (t.next) return colorNameOf(styles.strokeColor)
    const names: (ColorName | null)[] = []
    for (const el of t.els) {
      const k = kindOf(el)
      const stroke = (el as { strokeColor?: string }).strokeColor
      if (k === 'note') names.push(noteColorOf((el as { backgroundColor?: string }).backgroundColor))
      else if (items.itemKindOf(el) === 'highlight') names.push(highlightNameOf(stroke))
      else if (k !== 'image' && k !== 'other' && k !== 'frame') names.push(colorNameOf(stroke))
    }
    return sharedOf(names)
  })()
  const opacity = styles.opacity as number | 'mixed' | undefined
  const fill = has(t, 'shape')
    ? t.next
      ? fillNameOf(styles.backgroundColor, styles.fillStyle)
      : sharedOf(
          t.els
            .filter((e) => kindOf(e) === 'shape')
            .map((e) =>
              fillNameOf(
                (e as { backgroundColor?: string }).backgroundColor,
                (e as { fillStyle?: string }).fillStyle,
              ),
            ),
        )
    : undefined
  const dash = has(t, 'shape', 'arrow', 'line')
    ? styles.strokeStyle === 'mixed' || styles.roughness === 'mixed'
      ? 'mixed'
      : dashNameOf(styles.strokeStyle, styles.roughness)
    : undefined
  const size = (() => {
    const names: (SizeName | null)[] = []
    if (t.next) {
      if (noteTool) names.push(sizeNameOf(styles.fontSize, LABEL_SIZE))
      else if (textTool) names.push(sizeNameOf(styles.fontSize, TEXT_SIZE))
      else names.push(sizeNameOf((styles as { strokeWidth?: number }).strokeWidth, NEXT_STROKE_WIDTH))
    } else
      for (const el of t.els) {
        const k = kindOf(el)
        if (k === 'text') names.push(sizeNameOf(canvas.styles.of([el.id]).fontSize, TEXT_SIZE))
        // P-011: a note's size is its own (its width), not its words'
        else if (k === 'note') names.push(noteSizeNameOf(el))
        else if (k === 'draw')
          names.push(sizeNameOf((el as { strokeWidth?: number }).strokeWidth, FREEDRAW_WIDTH))
        else if (['shape', 'arrow', 'line'].includes(k))
          names.push(sizeNameOf((el as { strokeWidth?: number }).strokeWidth, STROKE_WIDTH))
      }
    return sharedOf(names)
  })()
  const textual = has(t, 'text', 'note', 'shape', 'arrow')
  const font = textual ? (styles.fontFamily === 'mixed' ? 'mixed' : fontNameOf(styles.fontFamily)) : undefined
  // a new note's label is always centred: the note tool offers no alignment
  const align = textual && !noteTool ? (styles.textAlign as AlignName | 'mixed' | undefined) : undefined
  const valign =
    has(t, 'note', 'shape') && !has(t, 'text')
      ? (styles.verticalAlign as VAlignName | 'mixed' | undefined)
      : undefined
  const arrows = has(t, 'arrow')
  const startHead = arrows
    ? styles.startArrowhead === 'mixed'
      ? 'mixed'
      : (arrowheadNameOf(styles.startArrowhead) ?? undefined)
    : undefined
  const endHead = arrows
    ? styles.endArrowhead === 'mixed'
      ? 'mixed'
      : (arrowheadNameOf(styles.endArrowhead) ?? undefined)
    : undefined
  const lineKind: 'straight' | 'curved' | 'elbow' | 'mixed' | undefined = arrows
    ? t.next
      ? // the next connector's kind is its own value (CR-W5-3A-1); `roundness` is the next shape's corners
        (nextArrowKind(styles) ?? 'straight')
      : styles.roundness === 'mixed'
        ? 'mixed'
        : styles.roundness === 'round'
          ? 'curved'
          : 'straight'
    : undefined
  const tool = canvas.tool()

  return (
    <section className="cux-style" aria-label="Styles" data-testid="style.panel">
      {onClose && <CloseStyles onClose={onClose} />}
      <div className="cux-style__section">
        {allNotes ? (
          <NoteColorPicker canvas={canvas} t={t} />
        ) : strokeKinds || has(t, 'note') ? (
          <ColorPicker canvas={canvas} t={t} value={color} />
        ) : null}
        {!textTool && !noteTool && <OpacityPicker canvas={canvas} t={t} value={opacity} />}
      </div>
      {(fill !== undefined || dash !== undefined || size !== undefined) && (
        <div className="cux-style__section">
          {fill !== undefined && (
            <Segmented
              legend="Fill"
              testPrefix="style.fill"
              options={FILLS}
              labels={FILL_LABELS}
              value={fill}
              onPick={(f) => pickFill(canvas, t, f)}
            />
          )}
          {dash !== undefined && (
            <Segmented
              legend="Dash"
              testPrefix="style.dash"
              options={DASHES}
              labels={DASH_LABELS}
              value={dash}
              onPick={(d) => pickPlain(canvas, t, 'dash', dashFields(d), ['shape', 'arrow', 'line'])}
            />
          )}
          {size !== undefined && (
            <Segmented
              legend="Size"
              testPrefix="style.size"
              options={SIZES}
              labels={SIZE_LABELS}
              value={size}
              onPick={(s) => pickSize(canvas, t, s)}
            />
          )}
        </div>
      )}
      {textual && (
        <div className="cux-style__section">
          <Segmented
            legend="Font"
            testPrefix="style.font"
            options={FONTS}
            labels={FONT_LABELS}
            faces={FONT_FACE}
            value={font}
            onPick={(f) => {
              const ids = textTargets(t)
              if (ids.length) canvas.styles.apply({ fontFamily: FONT_FAMILY[f] }, ids)
              else canvas.styles.setNext({ fontFamily: FONT_FAMILY[f] })
            }}
          />
          {!noteTool && (
            <Segmented
              legend="Align"
              testPrefix="style.align"
              options={ALIGNS}
              labels={ALIGN_LABELS}
              value={align}
              onPick={(a) => {
                const ids = textTargets(t)
                if (ids.length) canvas.styles.apply({ textAlign: a }, ids)
                else canvas.styles.setNext({ textAlign: a })
              }}
            />
          )}
          {valign !== undefined || (t.next && has(t, 'shape')) ? (
            <Segmented
              legend="Label align"
              testPrefix="style.vertical-align"
              options={VALIGNS}
              labels={VALIGN_LABELS}
              value={valign}
              onPick={(v) => {
                const ids = [
                  ...t.els.filter((e) => ['note', 'shape'].includes(kindOf(e)) && !isPolygonLine(e)),
                  ...t.holders,
                ].map((e) => e.id)
                if (ids.length) canvas.styles.apply({ verticalAlign: v }, ids)
              }}
            />
          ) : null}
        </div>
      )}
      {t.next && has(t, 'shape') && (
        <div className="cux-style__section">
          <Segmented
            legend="Shape"
            testPrefix="style.geo"
            options={GEO_OPTIONS}
            labels={GEO_LABELS}
            icons={TOOL_ICONS}
            value={tool && (GEO_OPTIONS as readonly string[]).includes(tool) ? tool : undefined}
            onPick={(g) => canvas.setTool(g)}
          />
        </div>
      )}
      {arrows && (
        <div className="cux-style__section">
          <div className="cux-style__heads" data-testid="style.arrowheads">
            <ArrowheadPicker canvas={canvas} t={t} end="start" value={startHead} />
            <ArrowheadPicker canvas={canvas} t={t} end="end" value={endHead} />
          </div>
          <Segmented
            legend="Line"
            testPrefix="style.arrow-kind"
            options={t.next ? (['straight', 'curved', 'elbow'] as const) : (['straight', 'curved'] as const)}
            labels={{ straight: 'Straight', curved: 'Curved', elbow: 'Elbow' }}
            value={lineKind as 'straight' | 'curved' | 'elbow' | 'mixed' | undefined}
            onPick={(k) => {
              if (t.next) {
                canvas.styles.setNext({ arrowKind: k })
                return
              }
              // the arrows' own curve; it is also the next connector's kind, and never the next shape's
              // corners (apply passes its patch on to the next style)
              const corners = canvas.styles.next().roundness
              canvas.styles.apply(
                { roundness: k === 'curved' ? 'round' : 'sharp' },
                t.els.filter((e) => kindOf(e) === 'arrow').map((e) => e.id),
              )
              canvas.styles.setNext({ arrowKind: k, ...(corners ? { roundness: corners } : {}) })
            }}
          />
        </div>
      )}
    </section>
  )
}
