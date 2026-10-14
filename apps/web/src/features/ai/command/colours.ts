// OWNER: W3 (wave M, M3-4). The colour words of the plain-language grammar (./grammar.ts). Pure. Its replies say a
// colour in the word the person typed (P-012), so there are no labels here.
//
// The words the grammar accepts: the sticky-note picker's 13 plain names (yellow, gold, orange, pink, red, lavender,
// purple, blue, light blue, green, light green, grey, white: NOTE_PALETTE's `plain`, what the picker's tooltips show),
// the 13 older internal names (Butter, Marigold, Apricot, Blush, Coral, Lilac, Plum, Iris, Sky, Fern, Pistachio, Stone,
// Paper: ../../canvas-ux/palette.ts NOTE_PALETTE; they stay words so whoever learned them can still type them), plus the
// hue families people say ("yellow" is Butter and Marigold, "pink" is Blush and Coral), plus the older names it always
// took ("light red", "lime", "gray"). Wave L accepted only the older names, so "make the yellow notes blue" found no
// yellow note on a board of default (Butter) notes and "make all pink notes yellow" answered "No light red notes".
//
// Two vocabularies, because Lobby stores one set of 13 names for both and they do not mean the same thing: a note's
// `black` is Butter (the default note, tldraw's default colour name), a stroke's `black` is ink. So a word names
// colours twice, `note` for what a note's fill can be called and `stroke` for everything else (shape, text,
// connector): "yellow" is Butter and Marigold on a note and the yellow stroke on a shape; "black" is only ink; "butter"
// is only a note. The first name of each list is what the word means as a destination ("make them yellow" is Butter,
// "make the connectors yellow" the yellow stroke, "make them black" does nothing to a note).
import type { AiColorName } from '@draftroom/contracts'
import { NOTE_PALETTE } from '../../canvas-ux/palette.ts'

/** Which colours an item takes: a note's, or a stroke's (everything else the grammar can colour). */
export type ColourSpace = 'note' | 'stroke'

export interface ColourWord {
  /** the word as it is looked up (lower case, one space between words) */
  readonly word: string
  /** the names it covers on a note, the preferred destination first */
  readonly note: readonly AiColorName[]
  /** the names it covers on a shape, a text or a connector, the preferred destination first */
  readonly stroke: readonly AiColorName[]
}

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
// the swatch names first (a note's own words: the plain one the picker shows, and the older internal one), the
// families after them (a family's word, "yellow" or "pink", replaces a swatch's own and covers its whole hue)
for (const s of NOTE_PALETTE)
  for (const name of [s.label, s.plain]) {
    const word = name.toLowerCase()
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

/** "A", "A or B", "A, B or C" (or with "and": what a reply lists). */
export function listWords(labels: readonly string[], joiner: 'or' | 'and'): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} ${joiner} ${labels[labels.length - 1]}`
}

/** A word as a sentence would start with it. */
export const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
