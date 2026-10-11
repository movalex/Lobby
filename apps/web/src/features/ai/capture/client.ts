// OWNER: WS5 (wave N, Capture the room; a stub landed by the wave N foundation). The web side of the capture routes
// (@draftroom/contracts ai.ts "Capture the room"): a photo (taken, chosen, or an image already on the board) or a
// meeting transcript becomes notes, a native diagram, or themes, decisions and actions, previewed before it lands.
//
// Frozen signatures:
//   captureAvailable(): boolean                     an editor with AI on for this board, an api that has the routes;
//                                                    photos also need the server's DRAFTROOM_AI_VISION (WS5 decides
//                                                    from the AI status and the routes' answers)
//   capturePhoto(boardId, jpeg, mode): Promise<CaptureResponse>             (the web's downsized JPEG, EXIF dropped)
//   captureBoardImage(boardId, elementId, mode): Promise<CaptureResponse>
//   captureTranscript(boardId, text, title?): Promise<CaptureResponse>
//   each rejects with CaptureUnavailableError ('unavailable') when capture is not available (and on an api without
//   the routes: 404)
//
// The stub: never available, and every capture rejects 'unavailable' without a request. So the "Capture the room…"
// entry, its palette command 'ai.capture' and the image context menu entries stay hidden until WS5 implements them.
import type { CaptureMode, CaptureResponse } from '@draftroom/contracts'

/** The palette command WS5 registers (contracts usage.ts PALETTE_COMMAND_IDS; pending until then). */
export const AI_CAPTURE_COMMAND_ID = 'ai.capture'

export class CaptureUnavailableError extends Error {
  readonly code = 'unavailable' as const
  constructor() {
    super('unavailable')
    this.name = 'CaptureUnavailableError'
  }
}

export function captureAvailable(): boolean {
  return false
}

export async function capturePhoto(
  _boardId: string,
  _jpeg: Blob,
  _mode: CaptureMode,
  _opts: { signal?: AbortSignal } = {},
): Promise<CaptureResponse> {
  throw new CaptureUnavailableError()
}

export async function captureBoardImage(
  _boardId: string,
  _elementId: string,
  _mode: CaptureMode,
  _opts: { signal?: AbortSignal } = {},
): Promise<CaptureResponse> {
  throw new CaptureUnavailableError()
}

export async function captureTranscript(
  _boardId: string,
  _text: string,
  _title?: string,
  _opts: { signal?: AbortSignal } = {},
): Promise<CaptureResponse> {
  throw new CaptureUnavailableError()
}
