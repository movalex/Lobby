// "What's new" (wave K, K4-5): a dismissible card on the dashboard that says what changed and where it went.
// Wave K moves controls (Internal only now sits behind the workspace tile, the board's top bar is calmer, a
// phone starts with the Hand tool), and pilot users had no way to learn that. Three to five items, each with a
// "Try it" that goes to the thing; the card is remembered as dismissed per person (prefs.ts) until a new
// version of it is published here. Pure data and rules; WhatsNew.tsx draws it.
//
// The words describe what wave K ships. Items 3 and 5 are other workstreams' (the board's top bar: K2, phones:
// K5); edit them here if what lands differs.

/** Bump it when the card says something new: everybody sees it once more. */
export const WHATS_NEW_VERSION = '2026-10-wave-k'
export const WHATS_NEW_MIN_ITEMS = 3
export const WHATS_NEW_MAX_ITEMS = 5

/** Where "Try it" goes. The dashboard decides how (it owns the dialogs and the routes). */
export type TryAction = 'start-row' | 'templates' | 'tour' | 'workspace-menu'

export interface WhatsNewItem {
  id: string
  title: string
  body: string
  /** "Try it": null when there is nothing on the dashboard to try (a phone feature). */
  tryIt: TryAction | null
  /** Who the item is for: everybody, people who can make boards, or members of the workspace. */
  for: 'everyone' | 'creators' | 'members'
}

export const WHATS_NEW_ITEMS: readonly WhatsNewItem[] = [
  {
    id: 'start-row',
    title: 'Start something in one click',
    body: 'Pick a template from the new row above your boards and a board opens with it on.',
    tryIt: 'start-row',
    for: 'creators',
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
    tryIt: 'tour',
    for: 'creators',
  },
  {
    id: 'workspace-menu',
    title: 'Internal only moved',
    body: 'It is in the workspace menu now: click your workspace at the top left. A shield shows while it is on.',
    tryIt: 'workspace-menu',
    for: 'members',
  },
  {
    id: 'phones',
    title: 'Phones start with the Hand tool',
    body: 'On a phone one finger moves around the board, so a swipe never moves a colleague’s note. Tap a note to select it.',
    tryIt: null,
    for: 'everyone',
  },
]

/**
 * What a person sees of the card: every item meant for everyone, plus those for creators when they can make
 * boards here and those for members when they belong to the workspace (a client or an outside guest sees only
 * what is true for them).
 */
export function whatsNewFor(who: { canCreate: boolean; inWorkspace: boolean }): WhatsNewItem[] {
  return WHATS_NEW_ITEMS.filter(
    (i) =>
      i.for === 'everyone' ||
      (i.for === 'creators' && who.canCreate) ||
      (i.for === 'members' && who.inWorkspace),
  )
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
