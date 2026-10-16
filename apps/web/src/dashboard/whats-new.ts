// "What's new" (wave K, K4-5; wave L's card, wave M, M3-3; wave P; wave Q; wave R): a dismissible card on the dashboard for people who have
// been here before and says what changed since. A first visit gets the Welcome card instead (Welcome.tsx), never this
// changelog (wave P, P-002). Each item is shown only to people it is true for; it may have a "Try it" that goes to
// the thing: a wave L item's lands on a board they can edit with a `?try=<hint>` (features/command-palette/try-hints.ts:
// the board shows a coach mark on the thing, once, and takes the parameter out of the address bar), or, for someone with
// no board to try it on, on the Start row. Wave P's items describe things found in the board itself and have no
// button: a button that does nothing visible is worse than none. The card is remembered as dismissed per person
// (prefs.ts) until a new version of it is published here (`WHATS_NEW_VERSION` resets everybody's "dismissed").
// Pure data and rules; WhatsNew.tsx draws it.

import type { TryHint } from '../features/command-palette/try-hints.ts'
import { type BoardRole, type BoardStatus, can } from '../lib/permissions.ts'

/** Bump it when the card says something new: everybody sees it once more. */
export const WHATS_NEW_VERSION = '2026-10-wave-r'
export const WHATS_NEW_MIN_ITEMS = 3
export const WHATS_NEW_MAX_ITEMS = 6

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

// Wave R's four (bring the team over) first, then two of wave Q's (the Elements panel) for people who never saw that card.
export const WHATS_NEW_ITEMS: readonly WhatsNewItem[] = [
  {
    id: 'miro-import',
    title: 'Import from Miro (beta)',
    body: 'Bring Miro boards over: Import, then Import from Miro, rebuilds each as a new private board, with a report of what changed.',
    tryIt: null,
    for: 'creators',
  },
  {
    id: 'chat-notifications',
    title: 'Slack and Teams notifications',
    body: 'Mentions, replies and access requests can reach a Slack or Teams channel: see Chat notifications in the bell.',
    tryIt: null,
    for: 'everyone',
  },
  {
    id: 'design-previews',
    title: 'Photoshop, Illustrator and TIFF previews',
    body: 'Upload a .psd, .ai or .tif file and its card on the board shows a preview; the original stays one click away.',
    tryIt: null,
    for: 'everyone',
  },
  {
    id: 'board-backups',
    title: 'Board backups',
    body: 'Download a board as a .lobby backup from its menu, and restore one as a new board from Import on the dashboard.',
    tryIt: null,
    for: 'creators',
  },
  {
    id: 'elements-icons',
    title: 'Icons in the Elements panel',
    body: 'Search thousands of Lucide and Tabler icons and add one in any of Lobby’s colours, in three sizes.',
    tryIt: null,
    for: 'everyone',
  },
  {
    id: 'elements-library',
    title: 'A library for your team',
    body: 'Save a selection to your workspace’s library or your own, then place it on any board in the workspace.',
    tryIt: null,
    for: 'everyone',
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
 * The "Try it" buttons that cannot be pressed now. While the board list has not arrived: the top-bar item's and every
 * board hint's. Once it has: the board hints of a person for whom `planHintTry` finds nowhere to go (no board to open and
 * no Start row: a client, or someone who asked to be spared the templates), so no button does nothing (N1, wave M follow-up
 * 3); the card says why (`NO_PLACE_TO_TRY`).
 */
export function unavailableTries(input: {
  listReady: boolean
  boards: readonly { readonly id: string; readonly role: BoardRole; readonly status: BoardStatus }[]
  startRow: boolean
  items: readonly WhatsNewItem[]
}): TryKey[] {
  const hints = input.items.flatMap((i) => (i.tryIt && typeof i.tryIt === 'object' ? [tryKey(i.tryIt)] : []))
  if (!input.listReady) return ['board', ...hints]
  const none = planHintTry({
    listReady: true,
    boards: input.boards,
    hint: 'ask',
    startRow: input.startRow,
    boardAddress: (id) => id,
  })
  return none.kind === 'none' ? hints : []
}

/** Why a board-hint "Try it" is disabled once the list has arrived: there is no board to try it on and no Start row. */
export const NO_PLACE_TO_TRY =
  'You have no board to try this on yet. Open a board you were invited to, or make one.'

/** Which card the dashboard greets this person with. */
export type Intro = 'welcome' | 'whats-new'

/**
 * Which card shows, if any (P-002, P-009). It is decided by what this browser remembers for this person (prefs.ts
 * `readWhatsNewSeen`): nothing at all means a first visit, which gets the short Welcome (what Lobby is, three one-click
 * starts, the keys), never a changelog about a product they have not seen; a remembered earlier release means they
 * have been here, so they get "What's new" once for this release; the current release remembered means neither.
 * Only on the landing view, and never for a name-only guest (they see only the boards of their link).
 */
export function introCard(input: {
  /** The release this person last saw or dismissed here, or null when this browser has no record of them. */
  seen: string | null
  version?: string
  items: readonly WhatsNewItem[]
  guest: boolean
  landing: boolean
}): Intro | null {
  if (!input.landing || input.guest) return null
  if (input.seen === null) return 'welcome'
  if (input.seen === (input.version ?? WHATS_NEW_VERSION)) return null
  return input.items.length > 0 ? 'whats-new' : null
}
