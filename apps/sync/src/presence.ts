// Presence bound to the verified ticket (docs/SECURITY-REVIEW-2026-09-27.md, authz-004 / SYNC-01).
//
// @tldraw/sync-core 5.4.2 never authorizes presence: TLSyncRoom's presence lane overwrites only `id`
// and `typeName`, it runs for read-only sessions too, and instancePresenceValidator accepts any
// `user:*` id, name, color and finite timestamp. Every tab keeps only the newest presence per userId,
// so one forged with someone else's id and a far-future timestamp took over their cursor, name,
// "follow" and "Bring everyone to me" on every other screen.
//
// Every frame a socket sends therefore passes through InboundFrames before room.handleSocketMessage:
// - Chunked frames ("<frames still to come>_<slice>", ClientWebSocketAdapter's framing for large
//   messages) are reassembled here, so the room only ever receives whole messages and a presence
//   cannot hide across chunks.
// - A push that carries presence is parsed and bound, put and patch ops alike (a patch may `put` or
//   `append` to any field): `userId` must be the ticket's, or the session is closed INVALID_RECORD;
//   `userName` and `color` become the ticket's; `lastActivityTimestamp` is clamped to server time;
//   `chatMessage` is capped.
// - Everything else (document pushes, pings, connects) goes through verbatim and is NOT parsed. JSON
//   can write a letter only literally or as a \u escape, so a text that contains neither `presence`
//   nor `\u` cannot have a "presence" key. Such a text costs one regex scan, never a parse.
//
// The stored presence can only drift through these ops: a session's first presence op must be a put
// (sync-core ignores a patch with nothing to patch), and every later patch is bound the same way.
import { createUserId } from '@tldraw/tlschema'

/** Longest cursor-chat message kept. tldraw has no limit of its own; its bubble shows one line. */
export const MAX_CHAT_MESSAGE_LENGTH = 500

/** Who a session's presence says it is: always the ticket's user, never what the client sends. */
export interface PresenceIdentity {
  /** `user:<ticket uid>`: tldraw's createUserId, which is also what the web client sends. */
  userId: string
  userName: string
  color: string
}

// Same palette, hash and hex check as the web client's colorForUser/safeColor
// (apps/web/src/lib/identity.ts), so a ticket color the web would not show is replaced the same way.
const USER_COLORS = ['#c2410c', '#1d4ed8', '#047857', '#7c3aed', '#be123c', '#0e7490', '#a16207', '#4d7c0f']
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

function colorForUser(userId: string): string {
  let h = 2166136261
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return USER_COLORS[(h >>> 0) % USER_COLORS.length] ?? '#1d4ed8'
}

export function presenceIdentity(ticket: { uid: string; name: string; color: string }): PresenceIdentity {
  return {
    userId: createUserId(ticket.uid),
    userName: ticket.name,
    color: HEX_COLOR_RE.test(ticket.color) ? ticket.color : colorForUser(ticket.uid),
  }
}

// Wire op names (sync-core diff.ts RecordOpType / ValueOpType, which are @internal there).
const PUT = 'put'
const PATCH = 'patch'
const APPEND = 'append'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isOp = (v: unknown, type: string): v is unknown[] => Array.isArray(v) && v[0] === type

export type BindResult = { ok: true; changed: boolean } | { ok: false }
const REFUSED: BindResult = { ok: false }

/**
 * Binds one push's `presence` op to `who`, in place. `ok: false` means it claims another user (or is
 * not a presence op at all). `changed` says whether anything had to be rewritten.
 */
export function bindPresenceOp(op: unknown, who: PresenceIdentity, now: number): BindResult {
  if (!Array.isArray(op) || !isObj(op[1])) return REFUSED
  if (op[0] === PUT) return bindPut(op[1], who, now)
  if (op[0] === PATCH) return bindPatch(op[1], who, now)
  return REFUSED
}

function bindPut(record: Obj, who: PresenceIdentity, now: number): BindResult {
  if (Object.hasOwn(record, 'userId') && record.userId !== who.userId) return REFUSED
  let changed = false
  const set = (key: string, value: unknown) => {
    if (record[key] === value) return
    record[key] = value
    changed = true
  }
  set('userId', who.userId)
  set('userName', who.userName)
  set('color', who.color)
  const at = record.lastActivityTimestamp
  if (typeof at === 'number' && at > now) set('lastActivityTimestamp', now)
  const chat = record.chatMessage
  if (typeof chat === 'string' && chat.length > MAX_CHAT_MESSAGE_LENGTH)
    set('chatMessage', chat.slice(0, MAX_CHAT_MESSAGE_LENGTH))
  return { ok: true, changed }
}

function bindPatch(diff: Obj, who: PresenceIdentity, now: number): BindResult {
  // Only a no-op put of the ticket's own id may touch userId; a put of another id, an append
  // ('user:ali' + 'ce'), a delete or a nested patch all claim to be somebody else.
  if (Object.hasOwn(diff, 'userId') && !(isOp(diff.userId, PUT) && diff.userId[1] === who.userId))
    return REFUSED
  let changed = false
  const replace = (key: string, op: unknown[] | null) => {
    if (op) diff[key] = op
    else delete diff[key]
    changed = true
  }
  for (const [key, value] of [
    ['userName', who.userName],
    ['color', who.color],
  ] as const) {
    if (!Object.hasOwn(diff, key)) continue
    const op = diff[key]
    if (!(isOp(op, PUT) && op[1] === value)) replace(key, [PUT, value])
  }
  // Only a put can raise a number (an append or nested patch on one is ignored by sync-core).
  const at = diff.lastActivityTimestamp
  if (isOp(at, PUT) && typeof at[1] === 'number' && at[1] > now) replace('lastActivityTimestamp', [PUT, now])
  const chat = diff.chatMessage
  if (isOp(chat, PUT) && typeof chat[1] === 'string' && chat[1].length > MAX_CHAT_MESSAGE_LENGTH) {
    replace('chatMessage', [PUT, chat[1].slice(0, MAX_CHAT_MESSAGE_LENGTH)])
  } else if (isOp(chat, APPEND) && typeof chat[1] === 'string' && typeof chat[2] === 'number') {
    // sync-core applies an append only at offset === current length: the result is offset + text.
    const room = MAX_CHAT_MESSAGE_LENGTH - chat[2]
    if (chat[1].length > room)
      replace('chatMessage', room > 0 ? [APPEND, chat[1].slice(0, room), chat[2]] : null)
  }
  return { ok: true, changed }
}

export type Inbound =
  /** Hand `text` (a whole message) to room.handleSocketMessage. */
  | { kind: 'deliver'; text: string }
  /** One chunk of a longer message: nothing to hand over yet. */
  | { kind: 'partial' }
  /** A presence that claims another user: close the session with INVALID_RECORD. */
  | { kind: 'forged' }
  /** A broken chunk stream: reset the socket (room.handleSocketError), as sync-core's own assembler does. */
  | { kind: 'malformed' }

const PARTIAL: Inbound = { kind: 'partial' }
const FORGED: Inbound = { kind: 'forged' }
const MALFORMED: Inbound = { kind: 'malformed' }
const CHUNK_RE = /^(\d+)_/
/** Could this JSON text have a "presence" key? One pass (~0.25 ms per MB, a fraction of one JSON.parse). */
const MAYBE_PRESENCE_RE = /presence|\\u/

/** One per socket: frames in, whole bound messages out. Never throws. */
export class InboundFrames {
  private readonly who: PresenceIdentity
  private readonly now: () => number
  private chunks: string[] | null = null
  private expected = 0

  constructor(who: PresenceIdentity, now: () => number = Date.now) {
    this.who = who
    this.now = now
  }

  accept(frame: string): Inbound {
    try {
      return this.assemble(frame)
    } catch {
      // e.g. JSON.stringify of a pathologically deep message: refuse it rather than pass it unbound
      this.chunks = null
      return MALFORMED
    }
  }

  // The rules of sync-core's JsonChunkAssembler, minus the parse.
  private assemble(frame: string): Inbound {
    if (frame.startsWith('{')) {
      if (this.chunks) return this.broken() // a whole message in the middle of a chunked one
      return this.message(frame)
    }
    const head = CHUNK_RE.exec(frame)
    if (!head) return this.broken()
    const remaining = Number(head[1])
    const part = frame.slice(head[0].length)
    if (!this.chunks) {
      this.chunks = [part]
      this.expected = remaining + 1
    } else {
      this.chunks.push(part)
      if (remaining !== this.expected - this.chunks.length) return this.broken()
    }
    if (this.chunks.length < this.expected) return PARTIAL
    const whole = this.chunks.join('')
    this.chunks = null
    return whole.startsWith('{') ? this.message(whole) : MALFORMED
  }

  private broken(): Inbound {
    this.chunks = null
    return MALFORMED
  }

  private message(text: string): Inbound {
    if (!MAYBE_PRESENCE_RE.test(text)) return { kind: 'deliver', text }
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return { kind: 'deliver', text } // invalid JSON: the room rejects the session, as it always has
    }
    // TLSyncRoom reads presence only from a push (`'presence' in message && message.presence`).
    if (!isObj(msg) || msg.type !== 'push' || !msg.presence) return { kind: 'deliver', text }
    const bound = bindPresenceOp(msg.presence, this.who, this.now())
    if (!bound.ok) return FORGED
    // Unchanged: the very text we checked (it parses to the same object in the room).
    return { kind: 'deliver', text: bound.changed ? JSON.stringify(msg) : text }
  }
}
