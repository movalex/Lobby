// OWNER: WS5 (wave N, N5-1). What a captured photo really is, from its bytes alone, before anything is sent: a
// JPEG, PNG or WebP by its magic numbers and container structure (the thumbnails' strict header reader, which also
// refuses animated images and anything riding after the image's own end), of the type its Content-Type says, at
// most CAPTURE_PHOTO_MAX_BYTES and CAPTURE_PHOTO_MAX_SIDE px a side. The api never decodes it (decoding untrusted
// images stays in the preview worker); the bytes go to the model in one request body and are dropped.
// Pure: unit-tested in Node.

import {
  CAPTURE_ERROR_CODES,
  CAPTURE_PHOTO_MAX_BYTES,
  CAPTURE_PHOTO_MAX_SIDE,
  CAPTURE_PHOTO_MIME_TYPES,
} from '@draftroom/contracts'
import { ApiError } from '../../errors.ts'
import { ImageHeaderError, readImageHeader } from '../thumbnails/image-header.ts'
import type { ChatImage } from './openai.ts'

export type CaptureMimeType = (typeof CAPTURE_PHOTO_MIME_TYPES)[number]

export const isCaptureMime = (v: string | null | undefined): v is CaptureMimeType =>
  (CAPTURE_PHOTO_MIME_TYPES as readonly string[]).includes(v ?? '')

/** The media type of a Content-Type header, without its parameters, lower case. */
export const mediaTypeOf = (header: string | undefined): string =>
  (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

export const badImage = (message = 'Send the photo as a JPEG, PNG or WebP image.') =>
  new ApiError(415, CAPTURE_ERROR_CODES.badImage, message)

export const imageTooLarge = (message: string) =>
  new ApiError(413, CAPTURE_ERROR_CODES.imageTooLarge, message)

export const TOO_MANY_BYTES = `The photo is larger than ${CAPTURE_PHOTO_MAX_BYTES / (1024 * 1024)} MB. Lobby makes it smaller before it sends it; try again from the board.`

export interface CheckedImage extends ChatImage {
  readonly width: number
  readonly height: number
}

/**
 * The photo as it may be sent, or the refusal: 413 past the byte or side limit, 415 for anything that is not a
 * JPEG, PNG or WebP by its bytes (or not the type `declared` says, when given).
 */
export function checkCaptureImage(bytes: Uint8Array, declared?: string): CheckedImage {
  if (bytes.byteLength > CAPTURE_PHOTO_MAX_BYTES) throw imageTooLarge(TOO_MANY_BYTES)
  if (bytes.byteLength === 0) throw badImage('Send the photo as the request body.')
  let header: ReturnType<typeof readImageHeader>
  try {
    header = readImageHeader(bytes)
  } catch (e) {
    if (e instanceof ImageHeaderError) throw badImage()
    throw e
  }
  if (!isCaptureMime(header.mimeType)) throw badImage()
  if (declared !== undefined && header.mimeType !== declared)
    throw badImage('The photo does not match its Content-Type.')
  const { width, height } = header
  if (width < 1 || height < 1) throw badImage('The photo has no size in its header.')
  if (width > CAPTURE_PHOTO_MAX_SIDE || height > CAPTURE_PHOTO_MAX_SIDE)
    throw imageTooLarge(
      `The photo is larger than ${CAPTURE_PHOTO_MAX_SIDE} × ${CAPTURE_PHOTO_MAX_SIDE} pixels. Lobby makes it smaller before it sends it; try again from the board.`,
    )
  return { mimeType: header.mimeType, bytes, width, height }
}
