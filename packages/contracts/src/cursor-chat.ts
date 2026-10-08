// Cursor chat (K6-4, wave K): press / on the board, type a short line, Enter, and it floats at your cursor
// for everyone on the board for a few seconds. Browser-safe; used by apps/api (validates the request,
// shapes the event) and apps/web (sends, parses the event).
//
// Never stored: the api relays a message to the board's event stream (like reactions) and keeps nothing but
// in-memory rate windows. Who wrote it comes from the session, never from the request. People who may comment
// on the board may chat (commenter, editor, owner; a name-only guest given comment through their link);
// viewers may not. The text is cleaned of control, bidi and zero-width characters (cleanDisplayText) and is
// at most CURSOR_CHAT_MAX_CHARS characters after that.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { cleanDisplayText } from './outside.ts'

/** POST /api/boards/:bid/cursor-chat (202 { ok: true }). */
export const cursorChatPath = (boardId: string) => `/api/boards/${encodeURIComponent(boardId)}/cursor-chat`

/** The board event (data: CursorChatEvent). A web build that does not know it ignores it. */
export const CURSOR_CHAT_EVENT = 'cursor.chat'

/** The longest message, in characters (code points) after cleaning. */
export const CURSOR_CHAT_MAX_CHARS = 80
/** A raw request longer than this (in UTF-16 units) is refused before cleaning. */
const RAW_MAX = 400

/** How long a message floats at the cursor before it fades (ms), and the fade itself. */
export const CURSOR_CHAT_SHOW_MS = 5_000
export const CURSOR_CHAT_FADE_MS = 600

/** Per person (across boards): at most `max` messages in any `windowMs`. */
export const CURSOR_CHAT_RATE = { max: 5, windowMs: 10_000 } as const
/** Per board, whoever sends them (a big room cannot flood every open stream). */
export const CURSOR_CHATS_PER_BOARD = { max: 60, windowMs: 10_000 } as const
/** The name-only guests of one link together (features/guests/link-caps.ts, like reactions). */
export const GUEST_LINK_CURSOR_CHATS = { max: 20, windowMs: 10_000 } as const

/** The text of a message: cleaned, then 1..CURSOR_CHAT_MAX_CHARS characters. */
export const CursorChatText = z
  .string()
  .max(RAW_MAX)
  .transform(cleanDisplayText)
  .pipe(
    z
      .string()
      .min(1, 'Type a message.')
      .refine((s) => [...s].length <= CURSOR_CHAT_MAX_CHARS, {
        message: `At most ${CURSOR_CHAT_MAX_CHARS} characters.`,
      }),
  )

/** A scene point (board coordinates): where the sender's pointer was, a hint for placing the bubble. */
const Coordinate = z.number().finite().min(-1e7).max(1e7)
export const CursorChatPoint = z.object({ x: Coordinate, y: Coordinate })
export type CursorChatPoint = z.infer<typeof CursorChatPoint>

/** The request. Any other key (a user id, a name) is ignored: authorship comes from the session. */
export const CursorChatInput = z.object({ text: CursorChatText, at: CursorChatPoint.optional() })
export type CursorChatInput = z.infer<typeof CursorChatInput>

const UserIdLike = z.string().regex(/^usr_[0-9A-Za-z]{10,40}$/)

/** The event everyone on the board hears (and the sender's other tabs, which skip their own). */
export const CursorChatEvent = z.object({
  userId: UserIdLike,
  /** the sender's name as their cursor shows it (a name-only guest's carries "(guest)") */
  name: z.string().max(200),
  text: z
    .string()
    .min(1)
    .refine((s) => [...s].length <= CURSOR_CHAT_MAX_CHARS),
  at: CursorChatPoint.optional(),
})
export type CursorChatEvent = z.infer<typeof CursorChatEvent>
