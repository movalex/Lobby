// Shared types of the ElementRoom (apps/sync/src/room/**, O1).

import type { WireElement } from '@draftroom/canvas-schema/elements'
import type { AckResult, DerivedRow, Op, RejectCode } from '@draftroom/canvas-schema/protocol'
import type { FileRefAnswer } from '../file-refs.ts'

/** Who writes (from the verified ticket, never from a message). */
export interface SessionIdentity {
  readonly sid: string
  readonly uid: string
  readonly name: string
  readonly color: string
  readonly role: 'owner' | 'editor' | 'commenter' | 'viewer'
  readonly guest: boolean
  readonly readonly: boolean
}

/** One op after stage 0: parsed, or already refused (INVALID, TOO_LARGE, UNAVAILABLE, RATE). */
export type PreOp =
  | { readonly op: Op; readonly reject?: undefined; readonly id: string }
  | { readonly op?: undefined; readonly reject: RejectCode; readonly id: string }

/** A push ready for the drain. */
export interface PreparedPush {
  readonly seq: number
  readonly base: number
  readonly ops: readonly PreOp[]
  readonly doc?: { readonly set: Readonly<Record<string, unknown>> }
  /** file-refs answers resolved in stage 0 for this push (bare version id → answer) */
  readonly files: ReadonlyMap<string, FileRefAnswer>
  /**
   * Wave T: the assignee-refs answers stage 0 holds for this push (uid → an account with a role on the board), from
   * the room cache or one lookup; a uid it lacks is unknown (its `card:who` write is UNAVAILABLE). Absent: none.
   */
  readonly assignees?: ReadonlyMap<string, boolean>
  /**
   * Wave T: the uids this push named past the cap of new uids per push (assignee-refs.ts ASSIGNEE_NEW_UIDS_PER_PUSH):
   * each write naming one is INVALID, refused before any lookup
   */
  readonly assigneesRefused?: ReadonlySet<string>
  /** when the push arrived (receive → ack metric) */
  readonly receivedAt: number
  /** a server write instead of client ops: the lease-expiry re-fit of one container (§2.9.4 rule 6) */
  readonly relayout?: string
  /** CONTRACTS_REV 11 (W5-ENG-2): the push's receipt id, recorded with its COMMIT (schema.ts lb_receipts) */
  readonly rid?: string
  /**
   * CONTRACTS_REV 12: the contracts revision of the socket that sent it (element-room.ts `Session.reader`), so
   * what that revision cannot know of a value it writes is kept from the stored value (merge.ts, canvas-schema
   * `lobbyWriteOf`). Absent (the server's own writes): this room's revision.
   */
  readonly writerRev?: number
}

/** What the drain produces for one push. */
export interface PushOutcome {
  /** the push's clock when it wrote anything, else null (the ack then carries the room's clock) */
  readonly clock: number | null
  readonly results: AckResult[]
  readonly derived: DerivedRow[]
  readonly docDenied?: { keys: string[]; code: RejectCode }
  /** elements changed by this push, with their state before it (null: new) and after */
  readonly changed: ReadonlyMap<string, { before: WireElement | null; after: WireElement }>
  /** doc keys written (null = removed) */
  readonly doc: Readonly<Record<string, unknown>>
  /** per op result code counts (metrics) */
  readonly codes: readonly string[]
}
