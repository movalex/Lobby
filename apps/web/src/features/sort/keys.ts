// L8-1: the deterministic ways to sort notes into labelled groups. Pure: plain descriptions of the notes in,
// ordered groups out. ./model.ts reads the canvas into these descriptions; ./plan.ts lays the groups out.
//
// The keys:
//  - colour: the note palette's order (canvas-ux/palette.ts), a column per colour in use, named by the palette
//    (Butter, Marigold, …); a fill outside the palette is "Other colours", last;
//  - author: whoever made the note (`lobbyServer.createdBy`); a column per person by name, a note nobody is
//    credited with (an anonymous reveal, a template's) under "Anonymous", last;
//  - tag: the note's first tag in the board's tag order, then "Untagged", last;
//  - votes: the last revealed vote's counts, most votes first, ties sharing a column, then "0 votes". With no
//    revealed vote there is nothing to sort by: `groupNotes` answers null and the option is disabled.
//
// Within a group the notes keep the order they were given in (the caller passes reading order).

import { NOTE_PALETTE, type NoteColorName } from '../canvas-ux/palette.ts'

export const SORT_KEYS = ['colour', 'author', 'tag', 'votes'] as const
export type SortKey = (typeof SORT_KEYS)[number]

export const SORT_KEY_LABELS: Readonly<Record<SortKey, string>> = {
  colour: 'Colour',
  author: 'Author',
  tag: 'Tag',
  votes: 'Votes',
}

/** The words of the column for notes nobody is credited with. */
export const ANONYMOUS = 'Anonymous'
export const UNTAGGED = 'Untagged'
export const OTHER_COLOURS = 'Other colours'
export const NO_VOTES = '0 votes'

/** What a sort needs to know about one note. */
export interface SortNote {
  readonly id: string
  /** the note's `backgroundColor` */
  readonly fill: string | null
  /** whoever the server credits with making it (`lobbyServer.createdBy`), or null */
  readonly author: { readonly uid: string; readonly name: string } | null
  /** the note's tags as people see them, in the board's order (features/tags displayTags) */
  readonly tags: readonly { readonly key: string; readonly name: string }[]
}

export interface SortContext {
  /** uid → the name the roster or the members list gives them now (the stamped name is the fallback) */
  readonly names: ReadonlyMap<string, string>
  /** the board's tag keys in the order people see them (features/tags boardTagRows) */
  readonly tagOrder: readonly string[]
  /** note id → votes in the last revealed vote; null: no vote has been revealed */
  readonly votes: ReadonlyMap<string, number> | null
}

export interface SortGroup {
  /** stable within a key ('colour:yellow', 'author:usr_1', 'tag:launch', 'votes:3') */
  readonly key: string
  /** the column heading */
  readonly label: string
  readonly ids: readonly string[]
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** A note's palette colour name, or null for a fill outside the note palette. */
export function noteColourName(fill: string | null | undefined): NoteColorName | null {
  if (typeof fill !== 'string') return null
  const f = fill.toLowerCase()
  return NOTE_PALETTE.find((s) => s.light.fill.toLowerCase() === f)?.name ?? null
}

const colourLabel = (name: NoteColorName) => NOTE_PALETTE.find((s) => s.name === name)?.label ?? name

interface Bucket {
  key: string
  label: string
  /** where the column sorts: an ascending number, then the label */
  rank: number
  ids: string[]
}

function bucketsOf(): {
  add(key: string, label: string, rank: number, id: string): void
  list(): SortGroup[]
} {
  const map = new Map<string, Bucket>()
  return {
    add(key, label, rank, id) {
      let b = map.get(key)
      if (!b) {
        b = { key, label, rank, ids: [] }
        map.set(key, b)
      }
      b.ids.push(id)
    },
    list: () =>
      [...map.values()]
        .sort((a, b) => a.rank - b.rank || collator.compare(a.label, b.label) || (a.key < b.key ? -1 : 1))
        .map(({ key, label, ids }) => ({ key, label, ids })),
  }
}

/** Sorted last, whatever the labels say. */
const LAST = 1_000_000

/**
 * `notes` as ordered groups for `key`, or null when the key cannot be used (votes, with no revealed vote).
 * Empty groups are left out. Deterministic: the same notes and context always give the same groups.
 */
export function groupNotes(
  key: SortKey,
  notes: readonly SortNote[],
  context: SortContext,
): SortGroup[] | null {
  const b = bucketsOf()
  switch (key) {
    case 'colour': {
      for (const n of notes) {
        const name = noteColourName(n.fill)
        if (name === null) b.add('colour:other', OTHER_COLOURS, LAST, n.id)
        else
          b.add(
            `colour:${name}`,
            colourLabel(name),
            NOTE_PALETTE.findIndex((s) => s.name === name),
            n.id,
          )
      }
      return b.list()
    }
    case 'author': {
      for (const n of notes) {
        if (!n.author) {
          b.add('author:none', ANONYMOUS, LAST, n.id)
          continue
        }
        const name = (context.names.get(n.author.uid) ?? n.author.name).trim() || 'Unknown'
        b.add(`author:${n.author.uid}`, name, 0, n.id)
      }
      return b.list()
    }
    case 'tag': {
      const rank = new Map(context.tagOrder.map((k, i) => [k, i]))
      for (const n of notes) {
        // the first tag in the board's order; a tag the board does not list sorts after the listed ones
        let first: { key: string; name: string } | null = null
        let firstRank = Number.POSITIVE_INFINITY
        for (const t of n.tags) {
          const r = rank.get(t.key) ?? context.tagOrder.length
          if (
            first === null ||
            r < firstRank ||
            (r === firstRank && collator.compare(t.name, first.name) < 0)
          ) {
            first = t
            firstRank = r
          }
        }
        if (first === null) b.add('tag:none', UNTAGGED, LAST, n.id)
        else b.add(`tag:${first.key}`, first.name, firstRank, n.id)
      }
      return b.list()
    }
    case 'votes': {
      if (context.votes === null) return null
      for (const n of notes) {
        const count = context.votes.get(n.id) ?? 0
        if (count <= 0) b.add('votes:0', NO_VOTES, LAST, n.id)
        else b.add(`votes:${count}`, `${count} ${count === 1 ? 'vote' : 'votes'}`, -count, n.id)
      }
      return b.list()
    }
  }
}

/** Why `key` cannot be used right now, in words for the person, or null when it can. */
export function sortKeyProblem(key: SortKey, context: Pick<SortContext, 'votes'>): string | null {
  if (key === 'votes' && context.votes === null) return 'Reveal a vote first'
  return null
}
