// Wave N (WS5, N5-2): the capture client (./client.ts): available only to an editor with AI on for the open board
// (never before the status is read, never to a viewer, a guest or a board with AI off), the mode as the photo
// route's query, the photo as a raw image/jpeg body, the unknown route's 404 hiding photos (vision off) or everything
// (no capture on the api), and the board image's own 404 hiding nothing.
import type { AiStatus, CaptureResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setUnauthorizedHandler } from '../../../api/client.ts'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { aiStatus } from '../ported/runtime.ts'
import {
  CaptureUnavailableError,
  captureAvailable,
  captureBoardImage,
  captureFacts,
  capturePhoto,
  captureQuota,
  captureTranscript,
  photoCaptureAvailable,
  releaseCaptureCanvas,
  setCaptureCanvas,
} from './client.ts'

const ON: AiStatus = {
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: true,
  budget: null,
  settings: null,
}
const ANSWER: CaptureResponse = {
  runId: 'air_0123456789abcdefghij',
  result: { kind: 'notes', notes: [], groups: [] },
  quota: { photosLeftToday: 7, transcriptsLeftToday: 9 },
}

let readOnly = false
const canvas = { readOnly: () => readOnly } as unknown as LobbyCanvas
interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  credentials: string
}
let sent: Sent[] = []
let answer: () => Response = () => new Response(JSON.stringify(ANSWER), { status: 200 })
const g = globalThis as { fetch?: unknown }
let fetchBefore: unknown
beforeEach(() => {
  readOnly = false
  sent = []
  answer = () => new Response(JSON.stringify(ANSWER), { status: 200 })
  fetchBefore = g.fetch
  g.fetch = async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body,
      credentials: String(init.credentials),
    })
    return answer()
  }
  setCaptureCanvas(canvas)
  aiStatus(canvas).set(ON)
})
afterEach(() => {
  g.fetch = fetchBefore
  releaseCaptureCanvas(canvas)
})

const notFound =
  (message = 'Not found.') =>
  () =>
    new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message } }), { status: 404 })

describe('availability', () => {
  it('an editor with AI on for the open board; nothing before the status, for a viewer, with AI off or no board', async () => {
    expect(captureAvailable()).toBe(true)
    expect(photoCaptureAvailable()).toBe(true)
    aiStatus(canvas).set(null)
    expect(captureAvailable()).toBe(false)
    aiStatus(canvas).set({ ...ON, enabled: false, reason: 'board-off', canInsert: false })
    expect(captureAvailable()).toBe(false)
    aiStatus(canvas).set({ ...ON, enabled: false, reason: 'guest', canInsert: false, canSummarize: false })
    expect(captureAvailable()).toBe(false)
    aiStatus(canvas).set({ ...ON, canInsert: false })
    expect(captureAvailable()).toBe(false)
    aiStatus(canvas).set(ON)
    readOnly = true
    expect(captureAvailable()).toBe(false)
    readOnly = false
    releaseCaptureCanvas(canvas)
    expect(captureAvailable()).toBe(false)
    // not available: every capture rejects without a request
    await expect(captureTranscript('b-board00001', 'We decided.')).rejects.toBeInstanceOf(
      CaptureUnavailableError,
    )
    await expect(capturePhoto('b-board00001', new Blob([]), 'auto')).rejects.toBeInstanceOf(
      CaptureUnavailableError,
    )
    expect(sent).toEqual([])
  })
})

describe('the requests', () => {
  it('Auto, Notes and Diagram are the photo route’s mode; the photo goes as a raw image/jpeg body, same origin', async () => {
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
    for (const mode of ['auto', 'notes', 'diagram'] as const) await capturePhoto('b-board00001', jpeg, mode)
    expect(sent.map((s) => s.url)).toEqual([
      '/api/boards/b-board00001/ai/capture/photo?mode=auto',
      '/api/boards/b-board00001/ai/capture/photo?mode=notes',
      '/api/boards/b-board00001/ai/capture/photo?mode=diagram',
    ])
    for (const s of sent) {
      expect(s.method).toBe('POST')
      expect(s.headers['content-type']).toBe('image/jpeg')
      expect(s.body).toBe(jpeg)
      expect(s.credentials).toBe('same-origin')
    }
    expect(captureQuota()).toEqual({ photosLeftToday: 7, transcriptsLeftToday: 9 })
  })

  it('a board image goes by its element id, a transcript as its text (the title only when there is one)', async () => {
    await captureBoardImage('b-board00001', 'img-1', 'diagram')
    await captureTranscript('b-board00001', 'Ana: hi', '  ')
    await captureTranscript('b-board00001', 'Ana: hi', 'Sync')
    expect(sent.map((s) => [s.url, s.headers['content-type'], s.body])).toEqual([
      [
        '/api/boards/b-board00001/ai/capture/board-image',
        'application/json',
        '{"elementId":"img-1","mode":"diagram"}',
      ],
      ['/api/boards/b-board00001/ai/capture/transcript', 'application/json', '{"text":"Ana: hi"}'],
      [
        '/api/boards/b-board00001/ai/capture/transcript',
        'application/json',
        '{"text":"Ana: hi","title":"Sync"}',
      ],
    ])
  })

  it('the photo route’s unknown-route 404 hides photos (vision off) and keeps transcripts', async () => {
    answer = notFound()
    await expect(capturePhoto('b-board00001', new Blob([]), 'notes')).rejects.toBeInstanceOf(
      CaptureUnavailableError,
    )
    expect(captureFacts.get().visionOff).toBe(true)
    expect(photoCaptureAvailable()).toBe(false)
    expect(captureAvailable()).toBe(true)
    // and the next photo is not even asked for
    const n = sent.length
    await expect(captureBoardImage('b-board00001', 'img-1', 'notes')).rejects.toBeInstanceOf(
      CaptureUnavailableError,
    )
    expect(sent).toHaveLength(n)
  })

  it('the transcript route’s unknown-route 404 hides capture altogether (an api without the routes)', async () => {
    answer = notFound()
    await expect(captureTranscript('b-board00001', 'x')).rejects.toBeInstanceOf(CaptureUnavailableError)
    expect(captureAvailable()).toBe(false)
    expect(photoCaptureAvailable()).toBe(false)
    // a new board starts afresh
    const other = { readOnly: () => false } as unknown as LobbyCanvas
    setCaptureCanvas(other)
    aiStatus(other).set(ON)
    expect(captureAvailable()).toBe(true)
    releaseCaptureCanvas(other)
  })

  it('the board image’s own 404 (an image that is not there) and other refusals hide nothing', async () => {
    answer = notFound('That image isn’t on this board, or Lobby can’t read it.')
    await expect(captureBoardImage('b-board00001', 'img-1', 'notes')).rejects.toMatchObject({
      status: 404,
      message: 'That image isn’t on this board, or Lobby can’t read it.',
    })
    answer = () =>
      new Response(
        JSON.stringify({
          error: { code: 'AI_CAPTURE_DAILY_CAP', message: 'You’ve used your 10 photo captures for today.' },
        }),
        {
          status: 429,
        },
      )
    await expect(capturePhoto('b-board00001', new Blob([]), 'notes')).rejects.toMatchObject({
      status: 429,
      code: 'AI_CAPTURE_DAILY_CAP',
    })
    expect(photoCaptureAvailable()).toBe(true)
  })

  it('a 401 on the board image or the transcript signs the page out, as any request of the app does', async () => {
    let signedOut = 0
    setUnauthorizedHandler(() => {
      signedOut++
    })
    try {
      answer = () =>
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Sign in again.' } }), {
          status: 401,
        })
      await expect(captureTranscript('b-board00001', 'x')).rejects.toMatchObject({ status: 401 })
      await expect(captureBoardImage('b-board00001', 'img-1', 'notes')).rejects.toMatchObject({ status: 401 })
      expect(signedOut).toBe(2)
      // the photo's raw body cannot go through the app's client: its 401 is the dialog's error
      await expect(capturePhoto('b-board00001', new Blob([]), 'notes')).rejects.toMatchObject({ status: 401 })
      expect(captureAvailable()).toBe(true)
    } finally {
      setUnauthorizedHandler(null)
    }
  })

  it('a board this person cannot open any more (its own 404 words) hides nothing', async () => {
    answer = notFound('This board isn’t there, or you can’t open it.')
    await expect(captureBoardImage('b-board00001', 'img-1', 'notes')).rejects.toMatchObject({ status: 404 })
    await expect(capturePhoto('b-board00001', new Blob([]), 'notes')).rejects.toMatchObject({ status: 404 })
    await expect(captureTranscript('b-board00001', 'x')).rejects.toMatchObject({ status: 404 })
    expect(photoCaptureAvailable()).toBe(true)
    expect(captureAvailable()).toBe(true)
  })

  it('a photo upload lost on the way asks again without the photo, and shows the refusal the api gives then', async () => {
    const capped = () =>
      new Response(
        JSON.stringify({
          error: { code: 'AI_CAPTURE_DAILY_CAP', message: 'You’ve used your 10 photo captures for today.' },
        }),
        { status: 429 },
      )
    const answers: (() => Response)[] = []
    answer = () => {
      const next = answers.shift()
      if (!next) throw new TypeError('Failed to fetch')
      return next()
    }
    // the upload fails as a network error; the second request has no photo and gets the refusal
    answers.push(() => {
      throw new TypeError('Failed to fetch')
    }, capped)
    await expect(
      capturePhoto('b-board00001', new Blob([new Uint8Array(4096)]), 'notes'),
    ).rejects.toMatchObject({
      status: 429,
      code: 'AI_CAPTURE_DAILY_CAP',
      message: 'You’ve used your 10 photo captures for today.',
    })
    expect(sent.map((s) => [s.url, s.headers['content-type'], (s.body as Blob).size])).toEqual([
      ['/api/boards/b-board00001/ai/capture/photo?mode=notes', 'image/jpeg', 4096],
      ['/api/boards/b-board00001/ai/capture/photo?mode=notes', 'image/jpeg', 0],
    ])
    // nothing to refuse (the api says the empty body is not a photo): the network error stands
    sent = []
    answers.push(
      () => {
        throw new TypeError('Failed to fetch')
      },
      () =>
        new Response(JSON.stringify({ error: { code: 'AI_CAPTURE_BAD_IMAGE', message: 'Not a photo.' } }), {
          status: 415,
        }),
    )
    await expect(
      capturePhoto('b-board00001', new Blob([new Uint8Array(4096)]), 'notes'),
    ).rejects.toMatchObject({
      kind: 'network',
    })
    expect(sent).toHaveLength(2)
    // vision turned off meanwhile: the unknown route's 404 hides photos, as on the first request
    answers.push(() => {
      throw new TypeError('Failed to fetch')
    }, notFound())
    await expect(capturePhoto('b-board00001', new Blob([]), 'notes')).rejects.toBeInstanceOf(
      CaptureUnavailableError,
    )
    expect(photoCaptureAvailable()).toBe(false)
  })

  it('a cancelled photo is not asked again', async () => {
    const abort = new AbortController()
    answer = () => {
      abort.abort()
      throw new DOMException('aborted', 'AbortError')
    }
    await expect(
      capturePhoto('b-board00001', new Blob([]), 'notes', { signal: abort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent).toHaveLength(1)
  })

  it('an answer that is not the contract’s is refused', async () => {
    answer = () => new Response(JSON.stringify({ runId: 'x', result: {} }), { status: 200 })
    await expect(captureTranscript('b-board00001', 'x')).rejects.toMatchObject({ kind: 'bad-response' })
  })
})
