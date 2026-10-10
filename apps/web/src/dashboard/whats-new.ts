// "What's new" (wave K, K4-5; wave L's card, wave M, M3-3): a dismissible card on the dashboard that says what changed and
// where it went. Wave K moved controls (Internal only now sits behind the workspace tile, the board's top bar is calmer, a
// phone starts with the Hand tool); wave L brought the command palette, Ask this board, Diagram from words, Time travel
// and the live meeting's run of show, spotlight and vote results, and the card still described wave K to the returning
// colleague (FTU-4). Three to five items, each with a "Try it" that goes to the thing; the card is remembered as
// dismissed per person (prefs.ts) until a new version of it is published here. Pure data and rules; WhatsNew.tsx draws it.
//
// Every item is shown only to people it is true for, and its "Try it" goes to something that is there: wave L's items
// land on a board they can edit with a `?try=<hint>` (features/command-palette/try-hints.ts: the board shows a coach mark
// on the thing, once, and takes the parameter out of the address bar), or, for someone with no board to try it on, on the
// Start row. The wave K items stay in this file's history; `WHATS_NEW_VERSION` resets everybody's "dismissed".

import type { TryHint } from '../features/command-palette/try-hints.ts'
import { type BoardRole, type BoardStatus, can } from '../lib/permissions.ts'

/** Bump it when the card says something new: everybody sees it once more. */
export const WHATS_NEW_VERSION = '2026-10-wave-l'
export const WHATS_NEW_MIN_ITEMS = 3
export const WHATS_NEW_MAX_ITEMS = 5

/** "Try it" on a wave L item: a board they can edit, with a coach mark on the thing (see the header). */
export interface BoardHintTry {
  readonly kind: 'board-hint'
  readonly hint: TryHint
}

/** Where "Try it" goes. The dashboard decides how (it owns the dialogs and the routes). */
export type TryAction = 'start-row' | 'templates' | 'board' | 'workspace-menu' | BoardHintTry

/** A "Try it" as one string (the button's `data-action`, the card's `pending` and `unavailable`). */
export type TryKey = string
export const tryKey = (a: TryAction): TryKey => (typeof a === 'string' ? a : `board-hint:${a.hint}`)

const hintTry = (hint: TryHint): BoardHintTry => ({ kind: 'board-hint', hint })

/**
 * Who an item is true for: everybody; people who can make boards here; people who get the template row (a
 * creator who has not asked to be spared templates); people who have the Internal only control behind the
 * workspace tile (owners and admins, and anyone while it is on).
 */
export type Audience = 'everyone' | 'creators' | 'start-row' | 'internal-only'

/** What the dashboard knows about the person, in the terms of the audiences above. */
export interface WhatsNewWho {
  canCreate: boolean
  /** The template row is offered to them (start-row-model.ts: startRowOffered), whether or not it is showing now. */
  startRow: boolean
  /** The workspace menu has an Internal only control for them (internal-only-model.ts: internalOnlyShown). */
  internalOnly: boolean
}

export interface WhatsNewItem {
  id: string
  title: string
  body: string
  /** "Try it": null when there is nothing on the dashboard to try (a phone feature). */
  tryIt: TryAction | null
  for: Audience
}

export const WHATS_NEW_ITEMS: readonly WhatsNewItem[] = [
  {
    id: 'palette',
    title: 'Ctrl+K: do it in words',
    body: 'Search or do… in a board’s top bar (Ctrl+K) finds anything, and “make the yellow notes blue” just works.',
    tryIt: hintTry('palette'),
    for: 'everyone',
  },
  {
    id: 'ask',
    title: 'Ask this board / Wrap up',
    body: 'Ask a question and get an answer with sources, or Wrap up a session into decisions and actions.',
    tryIt: hintTry('ask'),
    for: 'everyone',
  },
  {
    id: 'diagram',
    title: 'Diagram from words and Mermaid paste',
    body: 'Describe a process and get a flowchart, or paste a Mermaid diagram onto the board.',
    tryIt: hintTry('diagram'),
    for: 'creators',
  },
  {
    id: 'time-travel',
    title: 'Time travel: bring back just what you need',
    body: 'Scrub an earlier version of a board in History and restore only the pieces you want.',
    tryIt: hintTry('time-travel'),
    for: 'everyone',
  },
  {
    id: 'run-of-show',
    title: 'Run of show, spotlight and vote results',
    body: 'Plan minutes per frame, spotlight a note for everyone, and put ranked vote results on the board.',
    tryIt: hintTry('run-of-show'),
    for: 'creators',
  },
]

/**
 * What a person sees of the card: every item meant for everyone, plus those for creators when they can make
 * boards here, those for the template row when they get it, and those for the Internal only control when they
 * have it (a client or an outside guest sees only what is true for them).
 */
export function whatsNewFor(who: WhatsNewWho): WhatsNewItem[] {
  return WHATS_NEW_ITEMS.filter(
    (i) =>
      i.for === 'everyone' ||
      (i.for === 'creators' && who.canCreate) ||
      (i.for === 'start-row' && who.startRow) ||
      (i.for === 'internal-only' && who.internalOnly),
  )
}

/** What "Try it" on a board-bound item does. */
export type BoardTry =
  | { kind: 'wait' } // the board list has not arrived yet: the button waits for it
  | { kind: 'open'; boardId: string } // the board they opened last: nothing is made
  | { kind: 'make-tour' } // they have no board at all and may make one: the Lobby tour, once
  | { kind: 'none' }

/**
 * "Try it" on the board's top bar shows a board without leaving anything behind in a live workspace: the
 * board the person opened last. Only someone with no board at all (and the right to make one) gets the Lobby
 * tour made for them. `latestBoardId` is the first of their recent boards, or null for none.
 */
export function planBoardTry(input: {
  listReady: boolean
  latestBoardId: string | null
  canCreate: boolean
}): BoardTry {
  if (!input.listReady) return { kind: 'wait' }
  if (input.latestBoardId !== null) return { kind: 'open', boardId: input.latestBoardId }
  return input.canCreate ? { kind: 'make-tour' } : { kind: 'none' }
}

/** What "Try it" on a wave L item does (M3-3). */
export type HintTry =
  | { kind: 'wait' } // the board list has not arrived yet
  | { kind: 'open'; boardId: string; hint: TryHint; to: string } // `to`: the board's address with the hint
  | { kind: 'start-row' } // no board they can edit: the Start row (a board to try it on is one click there)
  | { kind: 'none' }

/**
 * Where a wave L "Try it" goes: the board the person opened most recently that they can edit, with `?try=<hint>`
 * (`boards`: their boards, the most recently opened first). With none, the dashboard's Start row when they get it. A
 * person who can only view, comment or has no row opens their latest board of any kind (the palette, Ask and Time
 * travel are theirs too; the board's coach says plainly when the thing is not there for them). Nothing is created.
 */
export function planHintTry(input: {
  listReady: boolean
  boards: readonly { readonly id: string; readonly role: BoardRole; readonly status: BoardStatus }[]
  hint: TryHint
  startRow: boolean
  boardAddress: (boardId: string, hint: TryHint) => string
}): HintTry {
  if (!input.listReady) return { kind: 'wait' }
  const open = (boardId: string): HintTry => ({
    kind: 'open',
    boardId,
    hint: input.hint,
    to: input.boardAddress(boardId, input.hint),
  })
  const editable = input.boards.find((b) => can(b.role, 'edit', b.status))
  if (editable) return open(editable.id)
  if (input.startRow) return { kind: 'start-row' }
  const any = input.boards[0]
  return any ? open(any.id) : { kind: 'none' }
}

/**
 * Whether the card shows: on the landing view (Recent), there is something for this person, they are not a
 * name-only guest (a guest sees only the boards of their link), and they have not dismissed this version.
 */
export function showWhatsNew(input: {
  items: readonly WhatsNewItem[]
  guest: boolean
  dismissed: boolean
  landing: boolean
}): boolean {
  return input.landing && !input.guest && !input.dismissed && input.items.length > 0
}
