// "What's new" (wave K, K4-5): a dismissible card on the dashboard that says what changed and where it went.
// Wave K moves controls (Internal only now sits behind the workspace tile, the board's top bar is calmer, a
// phone starts with the Hand tool), and pilot users had no way to learn that. Three to five items, each with a
// "Try it" that goes to the thing; the card is remembered as dismissed per person (prefs.ts) until a new
// version of it is published here. Pure data and rules; WhatsNew.tsx draws it.
//
// The words describe what wave K ships. Items 3 and 5 are other workstreams' (the board's top bar: K2, phones:
// K5); edit them here if what lands differs.
//
// Every item is shown only to people it is true for, and its "Try it" goes to something that is there: the row
// only to those who get the row, the workspace menu only to those who have an Internal only control in it
// (a plain member of a one-workspace account has no such menu). `whatsNewFor` takes those facts.

/** Bump it when the card says something new: everybody sees it once more. */
export const WHATS_NEW_VERSION = '2026-10-wave-k'
export const WHATS_NEW_MIN_ITEMS = 3
export const WHATS_NEW_MAX_ITEMS = 5

/** Where "Try it" goes. The dashboard decides how (it owns the dialogs and the routes). */
export type TryAction = 'start-row' | 'templates' | 'board' | 'workspace-menu'

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
    id: 'start-row',
    title: 'Start something in one click',
    body: 'Pick a template from the new row above your boards and a board opens with it on.',
    tryIt: 'start-row',
    for: 'start-row',
  },
  {
    id: 'agency-templates',
    title: 'Six new templates for agency work',
    body: 'Creative brief, client feedback round, shot list, launch timeline, 2x2 prioritisation and Kanban columns.',
    tryIt: 'templates',
    for: 'creators',
  },
  {
    id: 'calmer-top-bar',
    title: 'A calmer board top bar',
    body: 'Saved and Live share one dot, and Feedback is one click away on every board.',
    tryIt: 'board',
    for: 'creators',
  },
  {
    id: 'workspace-menu',
    title: 'Internal only moved',
    body: 'It is in the workspace menu now: click your workspace at the top left. A shield shows while it is on.',
    tryIt: 'workspace-menu',
    for: 'internal-only',
  },
  {
    id: 'phones',
    title: 'Phones start with the Hand tool',
    body: 'On a phone one finger moves around the board, so a swipe never moves a colleague’s note. To work with notes, tap Select (the arrow).',
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
