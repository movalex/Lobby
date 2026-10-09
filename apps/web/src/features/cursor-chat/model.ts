// Cursor chat (K6-4), the pure part: who may chat, which cursor a message floats at, the bubbles on screen
// and their timing, and the client's own rate limit. Node-tested (model.test.ts); the feature
// (./ported/index.tsx) renders it and sends through the api (@draftroom/contracts cursor-chat.ts).
//
// Nothing is stored anywhere: a message lives in this page's memory for CURSOR_CHAT_SHOW_MS plus the fade.

import {
  CURSOR_CHAT_FADE_MS,
  CURSOR_CHAT_MAX_CHARS,
  CURSOR_CHAT_RATE,
  CURSOR_CHAT_SHOW_MS,
  CursorChatEvent,
} from '@draftroom/contracts'
import { type BoardRole, type BoardStatus, can } from '../../lib/permissions.ts'

export interface Point {
  readonly x: number
  readonly y: number
}

/** People who may comment on an active board may chat (the api decides; this hides the key). */
/**
 * Wave K.1 (follow-up 11): whether this device has a cursor to chat at: some pointer can hover (a mouse, a
 * trackpad, a pen that hovers). A touch screen alone has no cursor, so cursor chat is not offered there at all
 * (no row in the shortcuts dialog, '/' from a keyboard attached to it does nothing): a bubble at a cursor nobody
 * sees would be a broken affordance. Without matchMedia (Node, an old browser): a cursor.
 */
export function hasCursor(): boolean {
  try {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia
    return typeof mm === 'function' ? mm.call(globalThis, '(any-hover: hover)').matches : true
  } catch {
    return true
  }
}

export function mayChat(role: BoardRole, status: BoardStatus): boolean {
  return can(role, 'comment', status)
}

/** The text as the composer keeps it: at most CURSOR_CHAT_MAX_CHARS characters (code points). */
export function clampText(text: string): string {
  const chars = [...text]
  return chars.length > CURSOR_CHAT_MAX_CHARS ? chars.slice(0, CURSOR_CHAT_MAX_CHARS).join('') : text
}

/** What the composer would send (trimmed), or null when there is nothing to send. */
export function messageOf(text: string): string | null {
  const t = clampText(text).trim()
  return t ? t : null
}

/** A board event's data as a message from someone else, or null (malformed, or this person's own). */
export function incoming(data: unknown, myUserId: string): CursorChatEvent | null {
  const parsed = CursorChatEvent.safeParse(data)
  if (!parsed.success) return null
  // this person's own message: shown by the tab that sent it; their other tabs skip it (as reactions do)
  if (parsed.data.userId === myUserId) return null
  return parsed.data
}

export interface PeerLike {
  readonly sid: string
  readonly uid: string
  readonly point: Point | null
  readonly idle: boolean
}

/**
 * The session (tab) whose cursor a message from `userId` floats at: one of theirs with a cursor on the
 * board that this page may show (`visible`: cursors not hidden by a facilitator, not presenting). With
 * the sender's pointer position (`at`) the nearest one (a person with two tabs open), else one that is
 * not idle. Null: none of their cursors is to be shown here.
 */
export function cursorFor(
  peers: readonly PeerLike[],
  userId: string,
  at: Point | undefined,
  visible: (sid: string) => boolean,
): string | null {
  let best: { sid: string; score: number } | null = null
  for (const p of peers) {
    if (p.uid !== userId || !p.point || !visible(p.sid)) continue
    const score = at ? Math.hypot(p.point.x - at.x, p.point.y - at.y) : p.idle ? 1 : 0
    if (!best || score < best.score) best = { sid: p.sid, score }
  }
  return best?.sid ?? null
}

/**
 * Where someone else's message is placed on this page (K6-4; wave K integration, the K6 review): at their cursor
 * (`cursorFor`) when this page shows one; at the point they sent it from when this page has no cursor of theirs
 * at all; null (not shown, not read out) when this page has their cursor but hides it (a facilitator hid the
 * cursors, or this page presents): a message there must not give away where they are.
 */
export function anchorFor(
  peers: readonly PeerLike[],
  userId: string,
  at: Point | undefined,
  visible: (sid: string) => boolean,
): { sid: string | null; at: Point | null } | null {
  const sid = cursorFor(peers, userId, at, visible)
  if (sid) return { sid, at: at ?? null }
  if (peers.some((p) => p.uid === userId && !visible(p.sid))) return null
  return { sid: null, at: at ?? null }
}

/** Where a bubble sits from the cursor's tip (overlay px): below the cursor's name label, to its right. */
export const BUBBLE_OFFSET = { x: 10, y: 30 } as const

export interface Bubble {
  /** one per person: a new message replaces the last */
  readonly userId: string
  readonly name: string
  readonly text: string
  readonly mine: boolean
  /** the session whose cursor it follows (null: placed at `at`) */
  readonly sid: string | null
  /** the sender's pointer when they sent it (scene) */
  readonly at: Point | null
  /** when it arrived (ms) */
  readonly since: number
  readonly color: string
}

/**
 * Where a bubble is drawn (scene), and whether it names its sender (wave K round 1 refix). At the sender's own
 * live cursor (`cursor`: that session's point on this page) the cursor's name label says who it is. Anywhere
 * else it sits at the point the sender sent (`at`), which they choose and which may be a colleague's cursor:
 * it names them, so it can never pass for someone else's message. This person's own bubble needs no name.
 */
export function placeBubble(
  b: Pick<Bubble, 'sid' | 'at' | 'mine'>,
  cursor: Point | null,
): { point: Point; named: boolean } | null {
  const attached = b.sid !== null && cursor !== null
  const point = attached ? cursor : b.at
  if (!point) return null
  return { point, named: !b.mine && !attached }
}

export type BubblePhase = 'shown' | 'fading' | 'gone'

/** A bubble shows for CURSOR_CHAT_SHOW_MS, then fades for CURSOR_CHAT_FADE_MS, then is gone. */
export function phaseOf(b: Pick<Bubble, 'since'>, nowMs: number): BubblePhase {
  const age = nowMs - b.since
  if (age < CURSOR_CHAT_SHOW_MS) return 'shown'
  if (age < CURSOR_CHAT_SHOW_MS + CURSOR_CHAT_FADE_MS) return 'fading'
  return 'gone'
}

/** At most this many bubbles at once (the oldest make room). */
export const MAX_BUBBLES = 30

/** The list with `bubble` in place of that person's last one, the gone ones dropped, and capped. */
export function addBubble(list: readonly Bubble[], bubble: Bubble, nowMs: number): Bubble[] {
  const live = list.filter((b) => b.userId !== bubble.userId && phaseOf(b, nowMs) !== 'gone')
  live.push(bubble)
  return live.length > MAX_BUBBLES ? live.slice(live.length - MAX_BUBBLES) : live
}

/** When the list next changes on its own (a bubble starts fading or is gone), or null. */
export function nextChangeAt(list: readonly Bubble[], nowMs: number): number | null {
  let next: number | null = null
  for (const b of list) {
    const fadeAt = b.since + CURSOR_CHAT_SHOW_MS
    const goneAt = fadeAt + CURSOR_CHAT_FADE_MS
    const at = nowMs < fadeAt ? fadeAt : nowMs < goneAt ? goneAt : null
    if (at !== null && (next === null || at < next)) next = at
  }
  return next
}

/**
 * The server's per-person limit, applied before sending (CURSOR_CHAT_RATE): a burst of Enters never
 * becomes a burst of 429s. The server still decides.
 */
export class ChatThrottle {
  private sent: number[] = []
  private readonly max: number
  private readonly windowMs: number

  constructor(max: number = CURSOR_CHAT_RATE.max, windowMs: number = CURSOR_CHAT_RATE.windowMs) {
    this.max = max
    this.windowMs = windowMs
  }

  tryTake(nowMs: number): boolean {
    this.sent = this.sent.filter((t) => nowMs - t < this.windowMs)
    if (this.sent.length >= this.max) return false
    this.sent.push(nowMs)
    return true
  }
}

/** What a failed send says (a toast); null: say nothing. */
export function failureText(e: { kind?: string; status?: number; code?: string } | null): string {
  if (e?.status === 429 || e?.code === 'RATE_LIMITED') return 'That is a lot of messages. Wait a moment.'
  if (e?.status === 403) return 'You can’t chat on this board.'
  if (e?.status === 404) return 'Cursor chat isn’t available on this board right now.'
  return 'Your message was not sent. Try again in a moment.'
}
