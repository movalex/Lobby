// The room's frames by reader (CONTRACTS_REV 12; docs/EXCALIDRAW-CONTRACTS.md §0b, the per-reader downgrade rule).
//
// A client's socket parses each server frame with its own build's strict `ServerMessage` and drops the whole frame
// on one value or field its revision does not know. The web deployed before a bump stays open for days (wave L's
// stale pair (c): the rev-11 web dropped every `changes` frame that carried a frame's `present.mins`, so it missed
// the minutes and everything committed with them, and after a reconnect could miss its catch-up). So every frame a
// session is sent leaves through `Session.send` (element-room.ts), the room's one send point, as one of:
//  - a `MessageFrame`: a server message, given to each session in the form canvas-schema's `frameForReader` gives
//    its revision (the one rule), serialized once per revision for every session it goes to: a broadcast to a room
//    of rev-12 and rev-11 tabs is serialized twice at most, and once when nothing in it is newer than rev 11;
//  - a `FormedFrame`: JSON that is already in its reader's form, from the two builders that cannot afford a parse
//    per frame: the catch-up frames (`catchUpFrame`: `c` ops of the stored rows, which `frameForReader` never
//    changes, so they are the same for every reader) and the presence hub's frames (presence.ts, built per reader
//    form with `presenceForReader`, which is `frameForReader`'s presence rule);
//  - the gzip snapshot (elements, as `c` ops: the same for every reader) and a session's reset welcome, built for
//    that session's revision.
// A socket's revision is what its connect URL names (`rev`, CONNECT_REV_PARAM), else UNANNOUNCED_REV (11), raised
// to PRESENCE_LASER_REV by its first presence message with `t` (Session.noteRev).

import {
  CONTRACTS_REV,
  frameForReader,
  type ServerMessage,
  type StoredElementOf,
} from '@draftroom/canvas-schema/protocol'

/** A server message, sent to each session in its revision's form (frameForReader), serialized once per form. */
export class MessageFrame {
  readonly message: ServerMessage
  private readonly stored: StoredElementOf | undefined
  /** the JSON of `message` itself (every reader whose form is the message) */
  private base: string | null = null
  /** the JSON per reader revision whose form differs from the message */
  private forms: Map<number, string> | null = null

  constructor(message: ServerMessage, stored?: StoredElementOf) {
    this.message = message
    this.stored = stored
  }

  /** The frame's JSON for a reader of contracts revision `reader`. */
  json(reader: number): string {
    const r = Math.min(reader, CONTRACTS_REV)
    if (r === CONTRACTS_REV) return this.baseJson()
    const known = this.forms?.get(r)
    if (known !== undefined) return known
    const form = frameForReader(r, this.message, this.stored)
    const j = form === this.message ? this.baseJson() : JSON.stringify(form)
    this.forms ??= new Map()
    this.forms.set(r, j)
    return j
  }

  private baseJson(): string {
    this.base ??= JSON.stringify(this.message)
    return this.base
  }
}

/** JSON already in the form its reader must get (see the header: catch-up `c` ops, the presence hub's frames). */
export class FormedFrame {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}

/** A frame for `Session.send`: by reader, already formed, the gzip snapshot, or a session's own welcome (pending). */
export type RoomFrame = MessageFrame | FormedFrame | Uint8Array | Promise<string | Uint8Array | null>

/** `message` as a frame for every session it is sent to (each in its revision's form). */
export const frameOf = (message: ServerMessage, stored?: StoredElementOf): MessageFrame =>
  new MessageFrame(message, stored)

/**
 * A catch-up frame (catch-up.ts: a welcome or `changes` whose ops are the stored rows as `c` ops, spliced as JSON):
 * the same for every reader, since `frameForReader` never changes a `c` op (canvas-schema protocol.ts
 * `opForReader`; reader-rule.test.ts pins it). Every other field of such a welcome went through `frameForReader`
 * for its session before the splice.
 */
export const catchUpFrame = (json: string): FormedFrame => new FormedFrame(json)

/** A presence frame the hub built for its recipient's presence form (presence.ts, `presenceForReader`). */
export const presenceFrame = (json: string): FormedFrame => new FormedFrame(json)
