/**
 * N1-1 (wave N): the messages between the page's snapshot decoder (./snapshot-decoder.ts) and its module worker
 * (./snapshot.worker.ts), and the error the socket (./socket.ts) reconnects on. NODE-SAFE: imported by the socket too.
 */
import type { SnapshotFrame } from '@draftroom/canvas-schema/protocol'

/** The decoded elements come back in slices of at most this many (each a short structured clone on the page). */
export const DECODE_SLICE = 500

export interface DecodeRequest {
  readonly id: number
  /** the frame's gzip bytes (transferred) */
  readonly bytes: ArrayBuffer
}

export type DecodeResponse =
  | { readonly type: 'ready' }
  | {
      readonly id: number
      readonly type: 'head'
      /** the frame, its `elements` empty (they follow in `part` messages) */
      readonly frame: SnapshotFrame
      readonly total: number
    }
  | { readonly id: number; readonly type: 'part'; readonly elements: SnapshotFrame['elements'] }
  | { readonly id: number; readonly type: 'done' }
  /** the decode refused the frame: `String(err)` of what `decodeSnapshotFrame` threw */
  | { readonly id: number; readonly type: 'error'; readonly message: string }

/** A frame the worker took and then lost (it died): the socket reconnects so the snapshot comes again. */
export class SnapshotDecodeLost extends Error {
  constructor() {
    super('the snapshot worker stopped with a frame in it')
    this.name = 'SnapshotDecodeLost'
  }
}

/** What the socket needs of a snapshot decoder (./snapshot-decoder.ts). */
export interface SnapshotDecode {
  decode(bytes: Uint8Array): Promise<SnapshotFrame>
  /**
   * A reset welcome came (its binary frame follows): starts the decoder's worker now when the frame will decode
   * there, judged by `bytes` (the welcome's `snapshot.bytes`, the frame's gzip length). A frame too small for the
   * worker starts nothing (a small board's open never loads the worker's script). No argument: start it.
   */
  warm(bytes?: number): void
}
