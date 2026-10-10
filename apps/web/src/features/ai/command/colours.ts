// OWNER: W3 (wave M, M3-4). The colour words of the plain-language grammar (./grammar.ts), and the labels its replies
// use. Pure.
//
// The words people see are the picker's: the sticky-note picker names its 13 swatches (Butter, Marigold, Apricot,
// Blush, Coral, Lilac, Plum, Iris, Sky, Fern, Pistachio, Stone, Paper: ../../canvas-ux/palette.ts NOTE_PALETTE), the
// style panel names a shape's, a text's and a connector's stroke colours (Black, Red, Light red…: ../../canvas-ux/
// ported/style-vocabulary.ts COLOR_LABELS). The words the grammar accepts are generated from the first, plus the hue
// families people say instead ("yellow" is Butter and Marigold, "pink" is Blush and Coral), plus the older names it
// always took ("light red", "lime", "gray"). Wave L accepted only the older names, so "make the yellow notes blue" found
// no yellow note on a board of default (Butter) notes and "make all pink notes yellow" answered "No light red notes".
//
// Two vocabularies, because Lobby stores one set of 13 names for both and they do not mean the same thing: a note's
// `black` is Butter (the default note, tldraw's default colour name), a stroke's `black` is ink. So a word names
// colours twice, `note` for what a note's fill can be called and `stroke` for everything else (shape, text,
// connector): "yellow" is Butter and Marigold on a note and the yellow stroke on a shape; "black" is only ink; "butter"
// is only a note. The first name of each list is what the word means as a destination ("make them yellow" is Butter,
// "make the connectors yellow" the yellow stroke, "make them black" does nothing to a note).
import type { AiColorName } from '@draftroom/contracts'
import { NOTE_PALETTE } from '../../canvas-ux/palette.ts'
import { COLOR_LABELS } from '../../canvas-ux/ported/style-vocabulary.ts'

/** Which picker names a colour: a note's, or the style panel's (everything else the grammar can colour). */
export type ColourSpace = 'note' | 'stroke'

export interface ColourWord {
  /** the word as it is looked up (lower case, one space between words) */
  readonly word: string
  /** the names it covers on a note, the preferred destination first */
  readonly note: readonly AiColorName[]
  /** the names it covers on a shape, a text or a connector, the preferred destination first */
  readonly stroke: readonly AiColorName[]
}

const NOTE_LABEL: ReadonlyMap<AiColorName, string> = new Map(NOTE_PALETTE.map((s) => [s.name, s.label]))
/** A name's place in its picker (the order a list of labels is told in). */
const NOTE_ORDER: ReadonlyMap<AiColorName, number> = new Map(NOTE_PALETTE.map((s, i) => [s.name, i]))
const STROKE_ORDER: ReadonlyMap<AiColorName, number> = new Map(
  (Object.keys(COLOR_LABELS) as AiColorName[]).map((n, i) => [n, i]),
)

/** The label the picker of `space` shows for a colour name ('black' is Butter on a note and Black on a shape). */
export function colourLabel(name: AiColorName, space: ColourSpace): string {
  return (space === 'note' ? NOTE_LABEL.get(name) : COLOR_LABELS[name]) ?? COLOR_LABELS[name]
}

/** Every label a reply may name a colour by: both pickers'. */
export const PICKER_LABELS: readonly string[] = [
  ...new Set([...NOTE_PALETTE.map((s) => s.label), ...Object.values(COLOR_LABELS)]),
]

/** Hue families and the older names: both lists are covered by the word, in the order a destination takes them. */
const SAME = (...names: AiColorName[]) => ({ note: names, stroke: names })
const FAMILIES: readonly (readonly [string, Pick<ColourWord, 'note' | 'stroke'>])[] = [
  ['yellow', { note: ['black', 'yellow'], stroke: ['yellow'] }],
  ['orange', SAME('orange')],
  ['pink', { note: ['light-red', 'red'], stroke: ['light-red'] }],
  ['red', SAME('red')],
  ['light red', SAME('light-red')],
  ['light-red', SAME('light-red')],
  ['purple', SAME('violet', 'light-violet')],
  ['violet', SAME('violet', 'light-violet')],
  ['light violet', SAME('light-violet')],
  ['light-violet', SAME('light-violet')],
  ['light purple', SAME('light-violet')],
  ['lavender', SAME('light-violet')],
  ['blue', SAME('blue', 'light-blue')],
  ['light blue', SAME('light-blue')],
  ['light-blue', SAME('light-blue')],
  ['sky blue', SAME('light-blue')],
  ['green', SAME('green', 'light-green')],
  ['light green', SAME('light-green')],
  ['light-green', SAME('light-green')],
  ['lime', SAME('light-green')],
  ['grey', SAME('grey')],
  ['gray', SAME('grey')],
  ['white', SAME('white')],
  // ink: a note has no black (its `black` is Butter)
  ['black', { note: [], stroke: ['black'] }],
]

const table = new Map<string, ColourWord>()
// the swatch labels first (a note's own words), the families after them (they never replace a swatch's word)
for (const s of NOTE_PALETTE) {
  const word = s.label.toLowerCase()
  table.set(word, { word, note: [s.name], stroke: [] })
}
for (const [word, lists] of FAMILIES) table.set(word, { word, ...lists })

/** Every colour word, longest first (a regular expression must try "light blue" before "blue"). */
export const COLOUR_WORDS: readonly ColourWord[] = [...table.values()].sort(
  (a, b) => b.word.length - a.word.length || a.word.localeCompare(b.word),
)

const BY_WORD: ReadonlyMap<string, ColourWord> = new Map(COLOUR_WORDS.map((w) => [w.word, w]))

/** The colour a typed word names, or null. */
export const colourWord = (word: string): ColourWord | null => BY_WORD.get(word.trim()) ?? null

/** The names `w` covers for an item in `space`. */
export const namesIn = (w: ColourWord, space: ColourSpace): readonly AiColorName[] =>
  space === 'note' ? w.note : w.stroke

/** Whether `name`, on an item of `space`, is one `w` covers. */
export const covers = (w: ColourWord, name: AiColorName | null, space: ColourSpace): boolean =>
  name !== null && namesIn(w, space).includes(name)

/** The destination `w` means for an item in `space` (null: it does not come in that colour, a note in ink). */
export const destinationIn = (w: ColourWord, space: ColourSpace): AiColorName | null =>
  namesIn(w, space)[0] ?? null

const order = (name: AiColorName, space: ColourSpace) =>
  (space === 'note' ? NOTE_ORDER : STROKE_ORDER).get(name) ?? 99

/** Labels in picker order, once each: [name, space] pairs from a note's or a shape's side. */
export function labelsOf(pairs: readonly (readonly [AiColorName, ColourSpace])[]): string[] {
  const seen = new Set<string>()
  const out: { label: string; at: number; space: number }[] = []
  for (const [name, space] of pairs) {
    const label = colourLabel(name, space)
    if (seen.has(label)) continue
    seen.add(label)
    out.push({ label, at: order(name, space), space: space === 'note' ? 0 : 1 })
  }
  return out.sort((a, b) => a.space - b.space || a.at - b.at).map((x) => x.label)
}

/** "A", "A or B", "A, B or C" (a reply that says what was not found) or with "and" (what was found). */
export function listWords(labels: readonly string[], joiner: 'or' | 'and'): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} ${joiner} ${labels[labels.length - 1]}`
}

/** The word as a sentence would write it when it names no picker colour ('Black' for a note). */
export const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
