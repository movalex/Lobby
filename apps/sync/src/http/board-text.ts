// GET /internal/boards/:bid/text[?since=<clock>][&maxBytes=<n>] (docs/WAVE4-CONTRACTS.md "search"): the
// searchable text of a board, for the API's search index. Only the API calls it (internal secret,
// checked in the router); the API decides who may search what.
//
// What counts as text follows the in-board search (packages/board-ops extractSearchableText): notes,
// text shapes, geo and arrow labels (rich text as plain text), frame and file-card names, image and
// video alt text plus their asset's file name, and the rich text of any other shape that has one.
// Shapes outside any page (orphans) are left out, like the board search does.
//
// Bounded work on untrusted records: rich text is walked with a node budget (deleted/label.ts), every
// entry is cut at ENTRY_MAX_CHARS, and the whole answer stops at `maxBytes` of text (UTF-8) and
// MAX_ENTRIES entries; `truncated` says so. Frames come first (their names are short and say what an
// area is about), then everything else in id order, so a cut board keeps a stable prefix.
//
// `since`: the document clock the API indexed last time. When the board's clock is still that, the
// answer is `{ unchanged: true }` without extracting anything. For an open room that is one integer
// read; a closed board is opened like the snapshot endpoint does (and evicted again when idle).
// Presence never moves the clock, and nothing here writes to the board.

// The route itself is room-internal/text.ts (the Excalidraw engine's); this module keeps the answer's
// vocabulary, its limits and `cleanText`.
//
// Wave N (WS7, N7-3; @draftroom/contracts sync-internal.ts BoardTextLinks): with `?links=1` a changed answer
// also carries `links`, after every other field: each live element whose `link` is a Lobby-relative board path
// (`/b/<id>[?el=<id>]`), in element id order, at most BOARD_TEXT_LINKS_MAX. Without the parameter the answer is
// byte for byte the wave M one, so an older api (which never asks) reads exactly what it read before, and an older
// sync simply ignores the parameter (the api then keeps the links it indexed). Still read-only.

import type { BoardTextLink } from '@draftroom/contracts'

/** The most text (UTF-8 bytes) one answer carries; the API asks for its own share of 1 MiB. */
export const BOARD_TEXT_MAX_BYTES = 1024 * 1024
export const BOARD_TEXT_DEFAULT_BYTES = 768 * 1024
export const BOARD_TEXT_MAX_ENTRIES = 10_000
/** Per object: a very long text shape is indexed by its first ENTRY_MAX_CHARS characters. */
export const ENTRY_MAX_CHARS = 4_000
export interface BoardTextEntry {
  /** The shape id (`shape:…`). */
  id: string
  /** The tldraw shape type (`note`, `geo`, `dr-file-card`, …). */
  type: string
  /** The page the shape is on (`page:…`). */
  pageId: string
  /** Plain text, whitespace collapsed, control characters removed; never empty. */
  text: string
}

export interface BoardText {
  entries: BoardTextEntry[]
  /** Text was left out (the byte or entry cap was reached). */
  truncated: boolean
  /** UTF-8 bytes of text returned. */
  bytes: number
}

export type BoardTextAnswer =
  | { boardId: string; clock: number; unchanged: true }
  | ({ boardId: string; clock: number; unchanged: false } & BoardText & {
        /** only when asked for (`?links=1`): the board links of its live elements (N7-3) */
        links?: BoardTextLink[]
      })

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** Control characters out, whitespace runs to one space, at most `max` UTF-16 units (no split pair). */
export function cleanText(raw: string, max = ENTRY_MAX_CHARS): string {
  let s = raw.replace(CONTROL_RE, ' ').replace(/\s+/gu, ' ').trim()
  if (s.length > max) {
    let end = max
    const last = s.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end-- // a high surrogate without its pair
    s = s.slice(0, end).trimEnd()
  }
  return s
}
