// OWNER: W3 (wave M, M3-3). The "Try it" hints of the What's new card: `?try=<hint>` on a board's address. The card's
// "Try it" opens the person's most recently opened board with one of these; the board page's command-palette feature
// reads it once (./index.tsx), shows a coach mark on the thing, and takes the parameter out of the address bar, so a
// reload or a copied link never repeats it. The hints are the contract's whats-new ids (@draftroom/contracts
// USAGE_WHATS_NEW_IDS: the same names count `whatsnew.try:<id>`), and anything else in the parameter is ignored.
//
// Pure and without React or the canvas: the dashboard's card builds the address from here (its first bundle stays small).
import { USAGE_WHATS_NEW_IDS } from '@draftroom/contracts'
import { boardPath } from '../../lib/routing.ts'

export const TRY_PARAM = 'try'
export const TRY_HINTS = USAGE_WHATS_NEW_IDS
export type TryHint = (typeof TRY_HINTS)[number]

export const isTryHint = (v: unknown): v is TryHint =>
  typeof v === 'string' && (TRY_HINTS as readonly string[]).includes(v)

/** The hint in a query string ('?try=ask'), or null: no hint, or one that is not on the list (ignored). */
export function tryHintOf(search: string): TryHint | null {
  try {
    const v = new URLSearchParams(search).get(TRY_PARAM)
    return isTryHint(v) ? v : null
  } catch {
    return null
  }
}

/** A board's address with the hint (only a listed one is ever put on an address). */
export function boardTryPath(boardId: string, hint: TryHint): string {
  return `${boardPath(boardId)}?${TRY_PARAM}=${hint}`
}

/** `href` without the hint (path, the other parameters and the hash stay); the same string when it had none. */
export function withoutTryParam(href: string): string {
  try {
    const url = new URL(href, 'http://lobby.invalid')
    if (!url.searchParams.has(TRY_PARAM)) return href
    url.searchParams.delete(TRY_PARAM)
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return href
  }
}

/**
 * What the coach says for each hint, and where it points. `entry`: the palette opens with that line marked (the line
 * is the thing: Ask this board, Diagram from words and Time travel are found there); `anchors`: the elements the bubble
 * points at, the first one on the page (the palette button on a desktop, the phone sheet's button on a phone).
 */
export interface TryCoachCopy {
  readonly text: string
  readonly entry?: string
  readonly anchors: readonly string[]
  /** a dock panel the coach opens first (the run of show is in Frames) */
  readonly panel?: string
}

export const TRY_COACH: Readonly<Record<TryHint, TryCoachCopy>> = {
  palette: {
    text: 'Search or do… finds every command, frame and template, and does things in words. Try “make the yellow notes blue”.',
    anchors: ['topbar-palette', 'phone-sheet-open'],
  },
  ask: {
    text: 'Ask this board: type a question in your own words and get an answer with sources.',
    entry: 'cmd:ai.ask',
    anchors: ['topbar-palette', 'phone-sheet-open'],
  },
  diagram: {
    text: 'Diagram from words: describe a process and get a flowchart. Pasting a Mermaid diagram works too.',
    entry: 'cmd:flow.diagram',
    anchors: ['topbar-palette', 'phone-sheet-open'],
  },
  'time-travel': {
    text: 'Time travel: open History, pick an earlier version and bring back just what you need.',
    entry: 'panel:history',
    anchors: ['topbar-palette', 'phone-sheet-open'],
  },
  'run-of-show': {
    text: 'Plan minutes for each frame here, then Present runs your run of show. Facilitate has the spotlight and vote results.',
    anchors: ['facilitate-button', 'present-button', 'topbar-palette', 'phone-sheet-open'],
    panel: 'frames',
  },
}

/** What the bubble says when the thing is not there for this person (AI off, a viewer): the palette is still the way in. */
export const TRY_COACH_FALLBACK =
  'Press Ctrl/Cmd+K, or Search or do… in the top bar, to find everything Lobby can do.'
