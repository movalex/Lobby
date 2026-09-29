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
  /** when the push arrived (receive → ack metric) */
  readonly receivedAt: number
  /** a server write instead of client ops: the lease-expiry re-fit of one container (§2.9.4 rule 6) */
  readonly relayout?: string
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
