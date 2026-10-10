// Wave M (M1-4, UXD-09 full): the selection toolbar's tier one, the Miro-style quick styles of a selection of one
// kind, at the end of the selection bar's main row (./SelectionStyleItems.tsx draws them):
//  - notes: colour (the note palette, its names as tooltips), size S/M/L/XL, text alignment;
//  - shapes: colour, fill, stroke width, stroke style, opacity;
//  - arrows and lines: colour, stroke width, stroke style, and an arrow's start and end arrowheads. Never a geometry
//    field, an elbow or a roundness switch (the geometry unit rule is untouched: these writes move no point);
//  - text: size, alignment, colour.
// Each control reads the selection's styles (canvas.styles.of, per element where a name depends on two fields) and a
// pick writes through the style panel's own pick functions (./StylePanel.tsx): one undo step, the next style too, and
// text fields through canvas.styles.apply, which lays the words out again and skips a label another session holds
// the lease on. Each pick counts `selectionbar.style:<kind>`. Mixed kinds, images, frames and drawings get no tier
// one (the style panel has them); read-only roles get none. SELECTION_TOOLBAR_TIER1 turns it all off.
import type { USAGE_SELECTION_STYLE_KINDS } from '@draftroom/contracts'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { countUsage } from '../../../lib/usage.ts'
import { NOTE_PALETTE, type NoteColorName } from '../palette.ts'
import {
  kindOf,
  pickColor,
  pickFill,
  pickNoteColor,
  pickPlain,
  pickSize,
  sharedOf,
  type Target,
  targetOf,
  textTargets,
} from './StylePanel.tsx'
import {
  ALIGN_LABELS,
  ALIGNS,
  ARROWHEAD_LABELS,
  ARROWHEADS,
  arrowheadField,
  arrowheadNameOf,
  COLOR_LABELS,
  COLOR_NAMES,
  type ColorName,
  colorNameOf,
  DASH_LABELS,
  DASHES,
  type DashName,
  dashFields,
  dashNameOf,
  FILL_LABELS,
  FILLS,
  type FillName,
  fillNameOf,
  LABEL_SIZE,
  noteColorOf,
  OPACITY_STEPS,
  opacityStepOf,
  SHADES,
  SIZE_LABELS,
  SIZES,
  type SizeName,
  STROKE_WIDTH,
  sizeNameOf,
  TEXT_SIZE,
} from './style-vocabulary.ts'

/**
 * The kill switch (the live pilot's): false hides tier one everywhere, the bar is then today's. A web-only redeploy.
 */
export const SELECTION_TOOLBAR_TIER1 = true

/** What tier one styles: a selection whose every element is of this kind. */
export type TierKind = 'note' | 'shape' | 'arrow' | 'line' | 'text'
/** A tier one control: what a pick in it counts (`selectionbar.style:<kind>`, the foundation's list). */
export type TierStyleKind = Exclude<(typeof USAGE_SELECTION_STYLE_KINDS)[number], 'more-styles'>

export interface TierOption {
  readonly value: string
  readonly label: string
  /** a swatch's colour, as stored (light) */
  readonly color?: string
  /** a note swatch's ink, as stored (light) */
  readonly ink?: string
}

/** One row of a control's options (an arrow's arrowheads have two: start and end). */
export interface TierRow {
  readonly id: string
  readonly legend: string
  readonly options: readonly TierOption[]
  /** the selection's value: one of the options', 'mixed' when they differ, null when it is none of them */
  readonly value: string | 'mixed' | null
}

export interface TierControl {
  readonly id: TierStyleKind
  /** the control's name ('Note color', 'Size', …): its button's label with the value */
  readonly label: string
  readonly rows: readonly TierRow[]
}

/**
 * The tier one kind of what is selected: every styled element (frames and polygons' see-through holders aside) is of
 * one kind tier one has, else null. Pure over the style panel's target.
 */
export function tierKindOf(t: Target | null): TierKind | null {
  if (!t || t.next || !t.els.length) return null
  const kinds = new Set(t.els.map(kindOf))
  if (kinds.size !== 1) return null
  const k = [...kinds][0]
  return k === 'note' || k === 'shape' || k === 'arrow' || k === 'line' || k === 'text' ? k : null
}

const prop = (el: unknown, key: string) => (el as Record<string, unknown>)[key]
const shared = <T extends string>(values: readonly (T | null)[]): string | 'mixed' | null =>
  sharedOf(values) ?? null

const COLOR_OPTIONS: readonly TierOption[] = COLOR_NAMES.map((n) => ({
  value: n,
  label: COLOR_LABELS[n],
  color: SHADES[n].solid,
}))
const NOTE_OPTIONS: readonly TierOption[] = NOTE_PALETTE.map((s) => ({
  value: s.name,
  label: s.label,
  color: s.light.fill,
  ink: s.light.text,
}))
const sizeOptions = SIZES.map((s) => ({ value: s, label: SIZE_LABELS[s] }))
const plain = <T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>) =>
  values.map((v) => ({ value: v, label: labels[v] }))

/** The controls of tier one for a selection of `kind` (reactive: call it inside a signal's selector). */
export function tierControls(canvas: LobbyCanvas, t: Target, kind: TierKind): TierControl[] {
  const els = t.els
  const ids = els.map((e) => e.id)
  const styles = canvas.styles.of(ids)
  const align = (): TierControl => ({
    id: 'text-align',
    label: 'Align',
    rows: [
      {
        id: 'text-align',
        legend: 'Align',
        options: plain(ALIGNS, ALIGN_LABELS),
        value:
          styles.textAlign === undefined
            ? null
            : styles.textAlign === 'mixed'
              ? 'mixed'
              : (ALIGNS as readonly string[]).includes(styles.textAlign)
                ? styles.textAlign
                : null,
      },
    ],
  })
  const fontSize = (scale: Readonly<Record<SizeName, number>>): TierControl => ({
    id: 'font-size',
    label: 'Size',
    rows: [
      {
        id: 'font-size',
        legend: 'Size',
        options: sizeOptions,
        value: shared(els.map((e) => sizeNameOf(canvas.styles.of([e.id]).fontSize, scale))),
      },
    ],
  })
  const colour = (id: 'stroke-colour' | 'text-colour'): TierControl => ({
    id,
    label: id === 'text-colour' ? 'Text color' : 'Color',
    rows: [
      {
        id,
        legend: id === 'text-colour' ? 'Text color' : 'Color',
        options: COLOR_OPTIONS,
        value: shared(els.map((e) => colorNameOf(prop(e, 'strokeColor')))),
      },
    ],
  })
  const strokeWidth = (): TierControl => ({
    id: 'stroke-width',
    label: 'Stroke width',
    rows: [
      {
        id: 'stroke-width',
        legend: 'Stroke width',
        options: sizeOptions,
        value: shared(els.map((e) => sizeNameOf(prop(e, 'strokeWidth'), STROKE_WIDTH))),
      },
    ],
  })
  const strokeStyle = (): TierControl => ({
    id: 'stroke-style',
    label: 'Stroke style',
    rows: [
      {
        id: 'stroke-style',
        legend: 'Stroke style',
        options: plain(DASHES, DASH_LABELS),
        value: shared(els.map((e) => dashNameOf(prop(e, 'strokeStyle'), prop(e, 'roughness')))),
      },
    ],
  })
  switch (kind) {
    case 'note':
      return [
        {
          id: 'note-colour',
          label: 'Note color',
          rows: [
            {
              id: 'note-colour',
              legend: 'Note color',
              options: NOTE_OPTIONS,
              value: shared(els.map((e) => noteColorOf(prop(e, 'backgroundColor')))),
            },
          ],
        },
        fontSize(LABEL_SIZE),
        align(),
      ]
    case 'text':
      return [fontSize(TEXT_SIZE), align(), colour('text-colour')]
    case 'shape':
      return [
        colour('stroke-colour'),
        {
          id: 'fill',
          label: 'Fill',
          rows: [
            {
              id: 'fill',
              legend: 'Fill',
              options: plain(FILLS, FILL_LABELS),
              value: shared(els.map((e) => fillNameOf(prop(e, 'backgroundColor'), prop(e, 'fillStyle')))),
            },
          ],
        },
        strokeWidth(),
        strokeStyle(),
        {
          id: 'opacity',
          label: 'Opacity',
          rows: [
            {
              id: 'opacity',
              legend: 'Opacity',
              options: OPACITY_STEPS.map((v) => ({ value: String(v), label: `${v}%` })),
              value: shared(
                els.map((e) => {
                  const step = opacityStepOf(prop(e, 'opacity'))
                  return step === null ? null : String(step)
                }),
              ),
            },
          ],
        },
      ]
    case 'arrow':
    case 'line': {
      const out = [colour('stroke-colour'), strokeWidth(), strokeStyle()]
      if (kind === 'arrow') {
        const heads = (end: 'start' | 'end'): TierRow => ({
          id: end,
          legend: end === 'start' ? 'Start arrowhead' : 'End arrowhead',
          options: plain(ARROWHEADS, ARROWHEAD_LABELS),
          value: shared(
            els.map((e) => arrowheadNameOf(prop(e, end === 'start' ? 'startArrowhead' : 'endArrowhead'))),
          ),
        })
        out.push({ id: 'arrowheads', label: 'Arrowheads', rows: [heads('start'), heads('end')] })
      }
      return out
    }
  }
}

/** The tier one model of the selection now (reactive), or null when tier one has nothing to style. */
export function tierModel(canvas: LobbyCanvas): { kind: TierKind; controls: TierControl[] } | null {
  if (!SELECTION_TOOLBAR_TIER1 || canvas.readOnly()) return null
  const t = targetOf(canvas)
  const kind = tierKindOf(t)
  return t && kind ? { kind, controls: tierControls(canvas, t, kind) } : null
}

/**
 * A pick in a tier one control: one write through the style panel's pick functions (one undo step), counted.
 * Returns false (and writes nothing) when tier one has nothing to style or the value is not the control's.
 */
export function pickTier(canvas: LobbyCanvas, control: TierStyleKind, row: string, value: string): boolean {
  if (!SELECTION_TOOLBAR_TIER1 || canvas.readOnly()) return false
  const t = targetOf(canvas)
  const kind = tierKindOf(t)
  if (!t || !kind) return false
  const known = tierControls(canvas, t, kind)
    .find((c) => c.id === control)
    ?.rows.find((r) => r.id === row)
    ?.options.some((o) => o.value === value)
  if (!known) return false
  switch (control) {
    case 'note-colour':
      pickNoteColor(canvas, t, value as NoteColorName)
      break
    case 'font-size':
    case 'stroke-width':
      // a note's label size, a text's size, a shape's or a connector's stroke width (the panel's Size)
      pickSize(canvas, t, value as SizeName)
      break
    case 'text-align':
      canvas.styles.apply({ textAlign: value }, textTargets(t))
      break
    case 'text-colour':
    case 'stroke-colour':
      pickColor(canvas, t, value as ColorName)
      break
    case 'fill':
      pickFill(canvas, t, value as FillName)
      break
    case 'stroke-style':
      pickPlain(canvas, t, 'dash', dashFields(value as DashName), ['shape', 'arrow', 'line'])
      break
    case 'opacity':
      pickPlain(canvas, t, 'opacity', { opacity: Number(value) }, ['shape'], true)
      break
    case 'arrowheads':
      pickPlain(
        canvas,
        t,
        'arrowheads',
        row === 'start'
          ? { startArrowhead: arrowheadField(value as (typeof ARROWHEADS)[number]) }
          : { endArrowhead: arrowheadField(value as (typeof ARROWHEADS)[number]) },
        ['arrow'],
      )
      break
  }
  countUsage(`selectionbar.style:${control}`)
  return true
}
