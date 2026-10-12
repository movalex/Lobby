// OWNER: WS5 (wave N, Capture the room). The web side of the capture routes (@draftroom/contracts ai.ts "Capture the
// room"): a photo (taken, chosen, or an image already on the board) or a meeting transcript becomes notes, a native
// diagram, or themes, decisions and actions, previewed before it lands.
//
// Frozen signatures (the wave N foundation):
//   captureAvailable(): boolean                     an editor with AI on for this board, an api that has the routes;
//                                                    photos also need the server's DRAFTROOM_AI_VISION (decided from
//                                                    the AI status and the routes' answers)
//   capturePhoto(boardId, jpeg, mode): Promise<CaptureResponse>             (the web's downsized JPEG, EXIF dropped)
//   captureBoardImage(boardId, elementId, mode): Promise<CaptureResponse>
//   captureTranscript(boardId, text, title?): Promise<CaptureResponse>
//   each rejects with CaptureUnavailableError ('unavailable') when capture is not available (and on an api without
//   the routes: 404)
//
// How it decides (WS5): the AI feature tells this module which board canvas is open (setCaptureCanvas); capture is
// available while that canvas's AiStatus offers the tools that build on the board (../ported/gate.ts canBuildWithAi:
// AI on, may add to the board, an editor, the day's budget left) and no capture route answered the unknown route's
// 404 on this page. A photo route's 404 means the server's vision is off (photos are hidden, transcripts stay); the
// transcript route's means the api has no capture at all (everything is hidden). The board image's own 404s (an
// image that is not there) have words of their own and hide nothing. With no board open, or a status not read yet,
// nothing is available and every capture rejects without a request. Requests are same-origin, with the session
// cookie; the photo is a raw image/jpeg body, the rest JSON through the app's api client (so a 401 signs the page out,
// as any other request's does; the photo's raw body cannot go through it, so since wave N.1 its 401 asks the app's
// client GET /api/me, whose own 401 signs the page out the same way). Nothing about them is stored.
import {
  type CaptureMode,
  type CaptureQuota,
  CaptureResponse,
  captureBoardImagePath,
  capturePhotoPath,
  captureTranscriptPath,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
} from '@draftroom/contracts'
import { ApiError, api, errorFromResponse, isApiError } from '../../../api/client.ts'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { atom } from '../../../lib/signals.ts'
import { canBuildWithAi } from '../ported/gate.ts'
import { aiStatus } from '../ported/runtime.ts'

/** The palette command WS5 registers (contracts usage.ts PALETTE_COMMAND_IDS). */
export const AI_CAPTURE_COMMAND_ID = 'ai.capture'

export class CaptureUnavailableError extends Error {
  readonly code = 'unavailable' as const
  constructor() {
    super('unavailable')
    this.name = 'CaptureUnavailableError'
  }
}

/** What this page has learnt about capture (a signal, so the menus and the dialog follow it). */
export interface CaptureFacts {
  /** the board canvas the AI feature has mounted, or null */
  readonly canvas: LobbyCanvas | null
  /** the api has no capture routes (the transcript route answered 404 NOT_FOUND) */
  readonly missing: boolean
  /** the server's vision is off (a photo route answered 404 NOT_FOUND) */
  readonly visionOff: boolean
  /** the last answer's quota, or null before the first */
  readonly quota: CaptureQuota | null
}

const NONE: CaptureFacts = { canvas: null, missing: false, visionOff: false, quota: null }
export const captureFacts = atom<CaptureFacts>('lobby-capture-facts', NONE)

/** The AI feature's mount: the board capture works on. A new board starts afresh. */
export function setCaptureCanvas(canvas: LobbyCanvas | null): void {
  const f = captureFacts.get()
  if (f.canvas === canvas) return
  captureFacts.set({ ...NONE, canvas })
}

/** The AI feature's unmount: forgets the canvas (only while it is still the one capture works on). */
export function releaseCaptureCanvas(canvas: LobbyCanvas): void {
  if (captureFacts.get().canvas === canvas) captureFacts.set(NONE)
}

const statusOk = (f: CaptureFacts): boolean =>
  !!f.canvas && !f.missing && canBuildWithAi(aiStatus(f.canvas).get(), f.canvas.readOnly())

export function captureAvailable(): boolean {
  return statusOk(captureFacts.get())
}

/** Photos (and board images): capture available and the server's vision not known to be off. */
export function photoCaptureAvailable(): boolean {
  const f = captureFacts.get()
  return statusOk(f) && !f.visionOff
}

/** The quota the last capture answered with (null before the first, and for what has no cap). */
export const captureQuota = (): CaptureQuota | null => captureFacts.get().quota

const UNKNOWN_ROUTE = 'Not found.'
const learn = (patch: Partial<CaptureFacts>) => captureFacts.set({ ...captureFacts.get(), ...patch })

type Kind = 'photo' | 'board-image' | 'transcript'

/** A refusal: the unknown route's 404 (or vision off) makes this page stop offering what is not there. */
function refused(kind: Kind, err: ApiError): Error {
  if (err.status === 404 && err.code === 'NOT_FOUND' && err.message === UNKNOWN_ROUTE) {
    if (kind === 'transcript') learn({ missing: true })
    else learn({ visionOff: true })
    return new CaptureUnavailableError()
  }
  return err
}

/** A JSON capture (the board image, the transcript) through the app's api client (see the header). */
async function sendJson(
  kind: Exclude<Kind, 'photo'>,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CaptureResponse> {
  let answer: CaptureResponse
  try {
    answer = await api.request('POST', path, { body, schema: CaptureResponse, ...(signal ? { signal } : {}) })
  } catch (e) {
    throw isApiError(e) ? refused(kind, e) : e
  }
  learn({ quota: answer.quota })
  return answer
}

/**
 * A photo route's 401 (wave N.1): the photo cannot go through the app's api client, so its refusal would only be the
 * dialog's words while the page stayed signed in. The app's client asks who is signed in (GET /api/me): when the
 * session has ended its own 401 signs the page out, as every other request's does; when it has not, nothing happens.
 */
function onPhotoRefused(err: ApiError): ApiError {
  if (err.kind === 'unauthorized') void api.me().catch(() => {})
  return err
}

/** The photo: a raw image/jpeg body, which the app's api client cannot send (it sends JSON). */
async function send(
  kind: 'photo',
  path: string,
  init: { body: BodyInit; contentType: string; signal?: AbortSignal },
): Promise<CaptureResponse> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': init.contentType,
        accept: 'application/json',
        [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV),
      },
      body: init.body,
      // same-origin only: the session cookie is never offered to another origin
      credentials: 'same-origin',
      cache: 'no-store',
      signal: init.signal,
    })
  } catch (e) {
    if (init.signal?.aborted) throw e
    throw new ApiError('network', 0, 'NETWORK', 'Can’t reach Lobby. Check your connection and try again.')
  }
  if (!res.ok) throw refused(kind, onPhotoRefused(await errorFromResponse(res)))
  const parsed = CaptureResponse.safeParse(await res.json().catch(() => undefined))
  if (!parsed.success)
    throw new ApiError(
      'bad-response',
      res.status,
      'BAD_RESPONSE',
      'Lobby sent an unexpected answer. Try again.',
    )
  learn({ quota: parsed.data.quota })
  return parsed.data
}

export async function capturePhoto(
  boardId: string,
  jpeg: Blob,
  mode: CaptureMode,
  opts: { signal?: AbortSignal } = {},
): Promise<CaptureResponse> {
  if (!photoCaptureAvailable()) throw new CaptureUnavailableError()
  const path = capturePhotoPath(boardId, mode)
  const signal = opts.signal ? { signal: opts.signal } : {}
  try {
    return await send('photo', path, { body: jpeg, contentType: 'image/jpeg', ...signal })
  } catch (e) {
    // The api refuses a photo before it reads the body (the day's cap, access, vision off), and a proxy on the way
    // can drop such an answer while the upload is still going: the browser then sees only a network error. Asked
    // again without the photo, the api gives the same refusal before reading anything (and an empty body is never
    // sent on to OpenAI or counted), so the person sees why; with no refusal, the network error stands.
    if (!isApiError(e) || e.kind !== 'network' || opts.signal?.aborted) throw e
    const why = await refusalWithoutPhoto(path, opts.signal)
    throw why ?? e
  }
}

/** The refusal the photo route gives a request with no photo (401, 403, 404, 429), or null for anything else. */
async function refusalWithoutPhoto(path: string, signal?: AbortSignal): Promise<Error | null> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'image/jpeg',
        accept: 'application/json',
        [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV),
      },
      body: new Blob([], { type: 'image/jpeg' }),
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    })
  } catch {
    return null
  }
  if (![401, 403, 404, 429].includes(res.status)) return null
  return refused('photo', onPhotoRefused(await errorFromResponse(res)))
}

export async function captureBoardImage(
  boardId: string,
  elementId: string,
  mode: CaptureMode,
  opts: { signal?: AbortSignal } = {},
): Promise<CaptureResponse> {
  if (!photoCaptureAvailable()) throw new CaptureUnavailableError()
  return sendJson('board-image', captureBoardImagePath(boardId), { elementId, mode }, opts.signal)
}

export async function captureTranscript(
  boardId: string,
  text: string,
  title?: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CaptureResponse> {
  if (!captureAvailable()) throw new CaptureUnavailableError()
  const t = title?.trim()
  return sendJson(
    'transcript',
    captureTranscriptPath(boardId),
    { text, ...(t ? { title: t } : {}) },
    opts.signal,
  )
}
