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
import { useId } from 'react'
import type {
  CanvasElement,
  CanvasFeatureContext,
  LobbyCanvas,
  StyleValues,
} from '../../../canvas/api/index.ts'
import { items } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { NOTE_PALETTE, type NoteColorName } from '../palette.ts'
import { selectedRoots } from './commands.ts'
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
  FONT_FAMILY,
  FONT_LABELS,
  FONTS,
  FREEDRAW_WIDTH,
  fillNameOf,
  fontNameOf,
  LABEL_SIZE,
  NEXT_STROKE_WIDTH,
  noteColorOf,
  noteFillOf,
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

/** What the panel styles: an element kind, or the kind the picked tool makes. */
export type StyleKind = 'note' | 'text' | 'shape' | 'arrow' | 'line' | 'draw' | 'frame' | 'image' | 'other'

/**
 * Creation tools whose next shape the panel sets (Lobby tool names). The note tool is not one on this
 * canvas: its notes take Lobby's note defaults, not the next style (CR-3A-7); the text tool's texts take
 * only the next colour (CR-3A-7), so it gets only the colour.
 */
export const STYLED_TOOLS: Readonly<Record<string, StyleKind>> = {
  text: 'text',
  rectangle: 'shape',
  ellipse: 'shape',
  diamond: 'shape',
  arrow: 'arrow',
  line: 'line',
  freedraw: 'draw',
}

export function kindOf(el: CanvasElement): StyleKind {
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

/** RETRO-20 / R16: shown for a selection (not frames only) or a creation tool. Pure. */
export function showStylePanel(kinds: readonly StyleKind[], toolId: string | null): boolean {
  if (kinds.length) return !kinds.every((k) => k === 'frame')
  return toolId !== null && toolId in STYLED_TOOLS
}

interface Target {
  readonly els: readonly CanvasElement[]
  readonly kinds: ReadonlySet<StyleKind>
  /** no selection: the picked tool's next shape */
  readonly next: boolean
}

function targetOf(canvas: LobbyCanvas): Target | null {
  const els = selectedRoots(canvas).filter((e) => kindOf(e) !== 'frame')
  const selectedKinds = selectedRoots(canvas).map(kindOf)
  const tool = canvas.tool()
  if (!showStylePanel(selectedKinds, tool)) return null
  if (els.length) return { els, kinds: new Set(els.map(kindOf)), next: false }
  const k = tool ? STYLED_TOOLS[tool] : undefined
  return k ? { els: [], kinds: new Set([k]), next: true } : null
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
function pickColor(canvas: LobbyCanvas, t: Target, name: ColorName) {
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
      put(w, el.id, { strokeColor: c.solid })
    }
  }
  write(canvas, 'color', w)
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

function pickNoteColor(canvas: LobbyCanvas, t: Target, name: NoteColorName) {
  const w: Writes = new Map()
  for (const el of t.els) if (kindOf(el) === 'note') put(w, el.id, { backgroundColor: noteFillOf(name) })
  write(canvas, 'note color', w)
}

function pickFill(canvas: LobbyCanvas, t: Target, fill: FillName) {
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

function pickPlain(
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

/** Text fields go through `styles.apply` (it lays the words out again); other fields join its step. */
function pickSize(canvas: LobbyCanvas, t: Target, size: SizeName) {
  const texts = t.els.filter((e) => kindOf(e) === 'text').map((e) => e.id)
  const notes = t.els.filter((e) => kindOf(e) === 'note').map((e) => e.id)
  let stepped = false
  if (texts.length) {
    canvas.styles.apply({ fontSize: TEXT_SIZE[size] }, texts)
    stepped = true
  }
  if (notes.length) {
    if (stepped) {
      // one undo step for the whole pick
      applyJoined(canvas, { fontSize: LABEL_SIZE[size] }, notes)
    } else canvas.styles.apply({ fontSize: LABEL_SIZE[size] }, notes)
    stepped = true
  }
  const w: Writes = new Map()
  for (const el of t.els) {
    const k = kindOf(el)
    if (k === 'draw') put(w, el.id, { strokeWidth: FREEDRAW_WIDTH[size] })
    else if (['shape', 'arrow', 'line'].includes(k)) put(w, el.id, { strokeWidth: STROKE_WIDTH[size] })
  }
  write(canvas, 'size', w, stepped)
  if (t.next) canvas.styles.setNext({ strokeWidth: NEXT_STROKE_WIDTH[size] })
}

/** `styles.apply` folded into the previous step (a second kind of the same pick). */
function applyJoined(canvas: LobbyCanvas, patch: StyleValues, ids: readonly string[]) {
  canvas.transact('style', () => canvas.styles.apply(patch, ids), { joinPrevious: true })
}

function textTargets(t: Target) {
  return t.els.filter((e) => ['text', 'note', 'shape', 'arrow'].includes(kindOf(e))).map((e) => e.id)
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

function Segmented<T extends string>(props: {
  legend: string
  testPrefix: string
  options: readonly T[]
  labels: Readonly<Record<T, string>>
  /** 'mixed': the selection differs (the legend says so); null: none of the options (nothing pressed) */
  value: T | 'mixed' | null | undefined
  onPick(v: T): void
}) {
  return (
    <fieldset className="cux-style__row" data-testid={`${props.testPrefix}`}>
      <legend className="cux-style__legend">
        {props.legend}
        {props.value === 'mixed' ? ' (mixed)' : ''}
      </legend>
      <div className="cux-style__options">
        {props.options.map((o) => (
          <button
            key={o}
            type="button"
            className="cux-style__opt"
            data-testid={`${props.testPrefix}.${o}`}
            aria-pressed={props.value === o}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(o)}
          >
            {props.labels[o]}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function NoteColorPicker({ canvas, t }: { canvas: LobbyCanvas; t: Target }) {
  const theme = useValue('cux-theme', () => canvas.theme(), [canvas])
  const current = useValue(
    'cux-note-color',
    () => sharedOf(t.els.map((e) => noteColorOf((e as { backgroundColor?: string }).backgroundColor))),
    [t],
  )
  return (
    <fieldset className="dr-note-palette" data-testid="note-palette">
      <legend className="dr-note-palette__legend">Note color{current === 'mixed' ? ' (mixed)' : ''}</legend>
      <div className="dr-note-palette__grid">
        {NOTE_PALETTE.map((s) => (
          <button
            key={s.name}
            type="button"
            className="dr-note-palette__swatch"
            data-testid="note-color"
            data-color={s.name}
            aria-pressed={current === s.name}
            aria-label={`${s.label}${current === s.name ? ' (selected)' : ''}`}
            title={s.label}
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
}: {
  canvas: LobbyCanvas
  t: Target
  value: ColorName | 'mixed' | null | undefined
}) {
  const theme = useValue('cux-theme', () => canvas.theme(), [canvas])
  return (
    <fieldset className="cux-style__row" data-testid="style.color">
      <legend className="cux-style__legend">Color{value === 'mixed' ? ' (mixed)' : ''}</legend>
      <div className="cux-style__swatches">
        {COLOR_NAMES.map((n) => (
          <button
            key={n}
            type="button"
            className="cux-style__swatch"
            data-testid={`style.color.${n}`}
            aria-pressed={value === n}
            aria-label={COLOR_LABELS[n]}
            title={COLOR_LABELS[n]}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pickColor(canvas, t, n)}
          >
            <span
              className="cux-style__swatch-dot"
              style={{ background: SHADES[n].solid, filter: theme === 'dark' ? THEME_FILTER : undefined }}
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
  alone,
}: {
  canvas: LobbyCanvas
  t: Target
  value: number | 'mixed' | undefined
  alone: boolean
}) {
  const id = useId()
  const step =
    typeof value === 'number'
      ? OPACITY_STEPS.indexOf(opacityStepOf(value) as (typeof OPACITY_STEPS)[number])
      : OPACITY_STEPS.length - 1
  return (
    <div className="cux-style__row cux-style__opacity">
      <label
        htmlFor={id}
        className={alone ? 'cux-style__legend' : 'dr-sr-only'}
        data-testid={alone ? 'style-opacity-label' : undefined}
      >
        Opacity
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={OPACITY_STEPS.length - 1}
        step={1}
        value={Math.max(0, step)}
        data-testid="style.opacity"
        aria-valuetext={`${OPACITY_STEPS[Math.max(0, step)]}%`}
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

function ArrowheadSelect({
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
  const id = useId()
  const field = end === 'start' ? 'startArrowhead' : 'endArrowhead'
  return (
    <div className="cux-style__head">
      <label htmlFor={id} className="cux-style__sublegend">
        {end === 'start' ? 'Start' : 'End'}
      </label>
      <select
        id={id}
        data-testid={`style.arrowhead-${end}`}
        value={value === undefined || value === 'mixed' ? '' : value}
        onChange={(e) => {
          const name = e.currentTarget.value as ArrowheadName
          pickPlain(canvas, t, 'arrowheads', { [field]: arrowheadField(name) } as StyleValues, ['arrow'])
        }}
      >
        {value === 'mixed' && <option value="">Mixed</option>}
        {ARROWHEADS.map((a) => (
          <option key={a} value={a}>
            {ARROWHEAD_LABELS[a]}
          </option>
        ))}
      </select>
    </div>
  )
}

export function StylePanel({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const readOnly = useValue('cux-readonly', () => canvas.readOnly(), [canvas])
  const t = useValue('cux-style-target', () => (readOnly ? null : targetOf(canvas)), [canvas, readOnly])
  const styles = useValue(
    'cux-styles',
    () => (t && !t.next ? canvas.styles.of(t.els.map((e) => e.id)) : t ? canvas.styles.next() : {}),
    [canvas, t],
  )
  if (!t) return null
  const allNotes = !t.next ? t.els.every((e) => kindOf(e) === 'note') : false
  // the text tool's next text takes only a colour (CR-3A-7)
  const textTool = t.next && has(t, 'text')
  const strokeKinds = has(t, 'shape', 'text', 'arrow', 'line', 'draw')
  const color = (() => {
    if (t.next) return colorNameOf(styles.strokeColor)
    const names: (ColorName | null)[] = []
    for (const el of t.els) {
      const k = kindOf(el)
      if (k === 'note') names.push(noteColorOf((el as { backgroundColor?: string }).backgroundColor))
      else if (k !== 'image' && k !== 'other' && k !== 'frame')
        names.push(colorNameOf((el as { strokeColor?: string }).strokeColor))
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
      if (textTool) return undefined
      names.push(sizeNameOf((styles as { strokeWidth?: number }).strokeWidth, NEXT_STROKE_WIDTH))
    } else
      for (const el of t.els) {
        const k = kindOf(el)
        if (k === 'text') names.push(sizeNameOf(canvas.styles.of([el.id]).fontSize, TEXT_SIZE))
        else if (k === 'note') names.push(sizeNameOf(canvas.styles.of([el.id]).fontSize, LABEL_SIZE))
        else if (k === 'draw')
          names.push(sizeNameOf((el as { strokeWidth?: number }).strokeWidth, FREEDRAW_WIDTH))
        else if (['shape', 'arrow', 'line'].includes(k))
          names.push(sizeNameOf((el as { strokeWidth?: number }).strokeWidth, STROKE_WIDTH))
      }
    return sharedOf(names)
  })()
  const textual = !textTool && has(t, 'text', 'note', 'shape', 'arrow')
  const font = textual ? (styles.fontFamily === 'mixed' ? 'mixed' : fontNameOf(styles.fontFamily)) : undefined
  const align = textual ? (styles.textAlign as AlignName | 'mixed' | undefined) : undefined
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
      ? styles.elbowed === true
        ? 'elbow'
        : styles.roundness === 'round'
          ? 'curved'
          : 'straight'
      : styles.roundness === 'mixed'
        ? 'mixed'
        : styles.roundness === 'round'
          ? 'curved'
          : 'straight'
    : undefined
  const onlyOpacity = !t.next && [...t.kinds].every((k) => k === 'image' || k === 'other')
  const tool = canvas.tool()

  return (
    <section className="cux-style" aria-label="Styles" data-testid="style.panel">
      <div className="cux-style__section">
        {allNotes ? (
          <NoteColorPicker canvas={canvas} t={t} />
        ) : strokeKinds || has(t, 'note') ? (
          <ColorPicker canvas={canvas} t={t} value={color} />
        ) : null}
        {!textTool && <OpacityPicker canvas={canvas} t={t} value={opacity} alone={onlyOpacity} />}
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
            value={font}
            onPick={(f) => {
              const ids = textTargets(t)
              if (ids.length) canvas.styles.apply({ fontFamily: FONT_FAMILY[f] }, ids)
              else canvas.styles.setNext({ fontFamily: FONT_FAMILY[f] })
            }}
          />
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
          {valign !== undefined || (t.next && has(t, 'note', 'shape')) ? (
            <Segmented
              legend="Label align"
              testPrefix="style.vertical-align"
              options={VALIGNS}
              labels={VALIGN_LABELS}
              value={valign}
              onPick={(v) => {
                const ids = t.els.filter((e) => ['note', 'shape'].includes(kindOf(e))).map((e) => e.id)
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
            options={['rectangle', 'ellipse', 'diamond'] as const}
            labels={{ rectangle: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond' }}
            value={tool === 'rectangle' || tool === 'ellipse' || tool === 'diamond' ? tool : undefined}
            onPick={(g) => canvas.setTool(g)}
          />
        </div>
      )}
      {arrows && (
        <div className="cux-style__section">
          <fieldset className="cux-style__row" data-testid="style.arrowheads">
            <legend className="cux-style__legend">Arrows</legend>
            <div className="cux-style__heads">
              <ArrowheadSelect canvas={canvas} t={t} end="start" value={startHead} />
              <ArrowheadSelect canvas={canvas} t={t} end="end" value={endHead} />
            </div>
          </fieldset>
          <Segmented
            legend="Line"
            testPrefix="style.arrow-kind"
            options={t.next ? (['straight', 'curved', 'elbow'] as const) : (['straight', 'curved'] as const)}
            labels={{ straight: 'Straight', curved: 'Curved', elbow: 'Elbow' }}
            value={lineKind as 'straight' | 'curved' | 'elbow' | 'mixed' | undefined}
            onPick={(k) => {
              if (t.next) {
                canvas.styles.setNext({
                  elbowed: k === 'elbow',
                  roundness: k === 'curved' ? 'round' : 'sharp',
                })
                return
              }
              canvas.styles.apply(
                { roundness: k === 'curved' ? 'round' : 'sharp' },
                t.els.filter((e) => kindOf(e) === 'arrow').map((e) => e.id),
              )
            }}
          />
        </div>
      )}
    </section>
  )
}
