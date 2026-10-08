// Cursor chat (K6-4, wave K; @draftroom/contracts cursor-chat.ts): a short line that floats at its sender's
// cursor for everyone on the board for a few seconds. Relayed to the board's event stream like reactions
// (./reactions.ts), never stored: nothing here reads or writes a table but the access checks' reads and the
// name the sender's cursor carries. The only state is in-memory sliding windows: per person (across boards)
// and per board; the name-only guests of one link share theirs too (features/guests/link-caps.ts).
//
// Who: `comment` on the board (commenter, editor, owner; a name-only guest whose link gave comment), the
// board active (archived boards are read-only: 403). Viewers get 403; no access, a board of another
// workspace, a revoked grant or a malformed id: 404 (existence is never revealed). The sender is the
// session's person; a user id or name in the body is ignored (the schema drops unknown keys).
//
// Domain access and guests: it creates nothing and hands out no access, so it is in neither
// CREATOR_ROUTES (features/domain-access/guard.ts) nor GUEST_REFUSED_ROUTES (features/guests/guard.ts): a
// name-only guest who may comment may chat, within the link's cap.

import {
  CURSOR_CHAT_EVENT,
  CURSOR_CHAT_RATE,
  CURSOR_CHATS_PER_BOARD,
  type CursorChatEvent,
  CursorChatInput,
} from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError, forbidden, parse } from '../../errors.ts'
import { SlidingWindowLimiter } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { ticketName } from '../guests/label.ts'

export const CURSOR_CHAT_ROUTE = '/api/boards/:bid/cursor-chat'

/** Read when an app is built: tests lower them first (like guests/link-caps.ts guestLinkCapSettings). */
export const cursorChatSettings: { perBoardMax: number } = { perBoardMax: CURSOR_CHATS_PER_BOARD.max }

const TOO_MANY = 'That is a lot of messages. Wait a moment.'

export function registerCursorChat(app: FastifyInstance, ctx: FeatureContext) {
  const { db, now, events } = ctx
  const perPerson = new SlidingWindowLimiter(CURSOR_CHAT_RATE.max, CURSOR_CHAT_RATE.windowMs)
  const perBoard = new SlidingWindowLimiter(cursorChatSettings.perBoardMax, CURSOR_CHATS_PER_BOARD.windowMs)

  app.post(CURSOR_CHAT_ROUTE, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(CursorChatInput, req.body)
    const access = await requireBoardAction(db, bid, user.id, 'comment')
    if (access.board.status !== 'active') throw forbidden('This board is read-only.')
    const boardId = access.board.id
    const t = now().getTime()
    // Per person first (a refused person never uses up the board's share), then per board.
    for (const [limit, key] of [
      [perPerson, user.id],
      [perBoard, boardId],
    ] as const) {
      if (limit.take(key, t)) continue
      const wait = Math.max(1, Math.ceil(limit.retryAfterMs(key, t) / 1000))
      throw new ApiError(429, 'RATE_LIMITED', TOO_MANY, { 'retry-after': String(wait) })
    }
    const data: CursorChatEvent = {
      userId: user.id,
      name: await ticketName(db, user),
      text: input.text,
      ...(input.at ? { at: input.at } : {}),
    }
    events.publish(boardId, { type: CURSOR_CHAT_EVENT, data })
    return reply.code(202).send({ ok: true })
  })
}
