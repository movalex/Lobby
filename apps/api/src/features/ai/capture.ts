// OWNER: WS5 (wave N, Capture the room; a stub landed by the wave N foundation). A photo of sticky notes or of a
// diagram, or a meeting transcript, becomes a board (@draftroom/contracts ai.ts "Capture the room"):
//
//   POST /api/boards/:bid/ai/capture/photo?mode=notes|diagram|auto   raw image body → CaptureResponse
//   POST /api/boards/:bid/ai/capture/board-image                     CaptureBoardImageRequest → CaptureResponse
//   POST /api/boards/:bid/ai/capture/transcript                      CaptureTranscriptRequest → CaptureResponse
//
// Registered from registerAi (inside the ai feature's scope, so the photo's raw-body parser and its 4 MiB limit stay
// in that scope; no app.ts change). The guest rows are in place (guests/guard.ts GUEST_REFUSED_ROUTES). Pending
// (../pending-routes.ts): none is registered until WS5 implements them, so they answer 404 NOT_FOUND like any
// unknown route, and the web's captureAvailable() stays false.

import {
  CAPTURE_BOARD_IMAGE_ROUTE,
  CAPTURE_PHOTO_ROUTE,
  CAPTURE_TRANSCRIPT_ROUTE,
} from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { routeUnlessPending } from '../pending-routes.ts'

export function registerCapture(app: FastifyInstance, _ctx: FeatureContext): void {
  const stub = async () => {
    throw notFound()
  }
  routeUnlessPending(app, 'POST', CAPTURE_PHOTO_ROUTE, stub)
  routeUnlessPending(app, 'POST', CAPTURE_BOARD_IMAGE_ROUTE, stub)
  routeUnlessPending(app, 'POST', CAPTURE_TRANSCRIPT_ROUTE, stub)
}
