// Wave N (WS5, N5-2 to N5-5): a capture from the dialog to the board (./run.ts), with the requests, the shared preview,
// the placement, the reveal and the usage counter mocked: the preview comes first and Apply writes one undo step with
// the provenance; Discard writes nothing; Try again asks again; a failure stays in the dialog; the photo reaches the
// board only when "Also add the photo" is ticked; and the usage events are the contract's names.
import type { CaptureResponse } from '@draftroom/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../api/client.ts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { fakeFlowCanvas } from '../../flow/test-canvas.ts'

const capturePhoto = vi.fn()
const captureBoardImage = vi.fn()
const captureTranscript = vi.fn()
vi.mock('./client.ts', async (importActual) => ({
  ...(await importActual<typeof import('./client.ts')>()),
  capturePhoto: (...a: unknown[]) => capturePhoto(...a),
  captureBoardImage: (...a: unknown[]) => captureBoardImage(...a),
  captureTranscript: (...a: unknown[]) => captureTranscript(...a),
}))
const downsizePhoto = vi.fn()
vi.mock('./downsize.ts', async (importActual) => ({
  ...(await importActual<typeof import('./downsize.ts')>()),
  downsizePhoto: (...a: unknown[]) => downsizePhoto(...a),
}))
const showAiPreview = vi.fn()
const aiResultToast = vi.fn()
vi.mock('../ported/public.ts', async (importActual) => ({
  ...(await importActual<typeof import('../ported/public.ts')>()),
  showAiPreview: (...a: unknown[]) => showAiPreview(...a),
  aiResultToast: (...a: unknown[]) => aiResultToast(...a),
}))
const pageSpotNear = vi.fn()
vi.mock('../ported/apply.ts', async (importActual) => ({
  ...(await importActual<typeof import('../ported/apply.ts')>()),
  pageSpotNear: (...a: unknown[]) => pageSpotNear(...a),
}))
const revealResult = vi.fn()
vi.mock('../reveal.ts', () => ({ revealResult: (...a: unknown[]) => revealResult(...a) }))
const countUsage = vi.fn()
vi.mock('../../../lib/usage.ts', () => ({ countUsage: (e: string) => countUsage(e) }))

const { captureDialog, captureJob, openCaptureDialog, runCapture, VISION_OFF_MESSAGE } = await import('./run.ts')
const { CaptureUnavailableError } = await import('./client.ts')

const RUN = 'air_0123456789ABCDEFGHIJ'
const answer = (result: CaptureResponse['result']): CaptureResponse => ({
  runId: RUN,
  result,
  quota: { photosLeftToday: 7, transcriptsLeftToday: 9 },
})
const NOTES = answer({
  kind: 'notes',
  notes: [
    { text: 'Keep the demo', color: 'yellow', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    { text: 'Slow builds', color: 'orange', box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 } },
  ],
  groups: [],
})
const MEETING = answer({
  kind: 'transcript',
  themes: [{ name: 'Schedule', notes: ['Shoot on the 14th'] }],
  decisions: ['One location'],
  actions: [{ text: 'Book the studio', owner: 'Ana' }],
})
const PHOTO = { blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), width: 2048, height: 1536 }

function setup() {
  const f = fakeFlowCanvas()
  const insert = vi.fn(async () => ['img'])
  ;(f.canvas as unknown as { files: unknown }).files = { insert }
  const notices: { text: string; testId?: string }[] = []
  const ctx = {
    canvas: f.canvas,
    board: { id: 'b-board00001' },
    me: { user: { id: 'usr_alice000001' } },
    notify: (n: { text: string; testId?: string }) => notices.push(n),
  } as unknown as CanvasFeatureContext
  return { f, ctx, notices, insert }
}
const photoSrc = (o: { addPhoto?: boolean } = {}) => ({
  kind: 'photo' as const,
  file: new Blob([new Uint8Array(20)]),
  name: 'wall.heic',
  mode: 'notes' as const,
  addPhoto: o.addPhoto ?? false,
  frames: true,
})

beforeEach(() => {
  for (const m of [
    capturePhoto,
    captureBoardImage,
    captureTranscript,
    downsizePhoto,
    showAiPreview,
    aiResultToast,
    pageSpotNear,
    revealResult,
    countUsage,
  ])
    m.mockReset()
  pageSpotNear.mockReturnValue({ x: 1000, y: 500 })
  downsizePhoto.mockResolvedValue(PHOTO)
  revealResult.mockResolvedValue(true)
})

describe('a photo', () => {
  it('is made smaller, sent, previewed, and on Apply written as one undo step with the provenance', async () => {
    const { f, ctx, insert } = setup()
    capturePhoto.mockResolvedValue(NOTES)
    showAiPreview.mockResolvedValue('apply')
    openCaptureDialog(ctx)
    const ids = await runCapture(ctx, photoSrc())
    expect(capturePhoto).toHaveBeenCalledWith('b-board00001', PHOTO.blob, 'notes', expect.anything())
    const preview = showAiPreview.mock.calls[0]?.[1] as { title: string; summary: string; runId: string }
    expect(preview).toMatchObject({ title: 'Notes from the photo', summary: 'Adds 2 notes', runId: RUN })
    expect(ids).toHaveLength(2)
    const notes = f.live().filter((e) => e.type === 'stickynote')
    expect(notes).toHaveLength(2)
    for (const n of notes) expect((n.customData as { lobby: { ai: unknown } }).lobby.ai).toEqual({ by: 'usr_alice000001', run: RUN })
    expect(f.steps()).toBe(1)
    expect(pageSpotNear).toHaveBeenCalledWith(f.canvas, expect.anything(), [])
    expect(revealResult).toHaveBeenCalledWith(f.canvas, ids)
    expect(aiResultToast).toHaveBeenCalledWith(ctx, 'Made by AI: 2 notes from your photo.', ids)
    expect(countUsage.mock.calls.map((c) => c[0])).toEqual(['ai.capture.photo', 'ai.capture.apply'])
    // the dialog closed once there was an answer, and nothing of the photo went to the board
    expect(captureDialog(f.canvas).get()).toBeNull()
    expect(insert).not.toHaveBeenCalled()
  })

  it('"Also add the photo to the board": the downsized JPEG through the normal upload path, after the notes', async () => {
    const { ctx, insert } = setup()
    capturePhoto.mockResolvedValue(NOTES)
    showAiPreview.mockResolvedValue('apply')
    await runCapture(ctx, photoSrc({ addPhoto: true }))
    expect(insert).toHaveBeenCalledTimes(1)
    const [files] = insert.mock.calls[0] as unknown as [File[]]
    expect(files.map((x) => [x.name, x.type])).toEqual([['wall.jpg', 'image/jpeg']])
  })

  it('Discard writes nothing; Try again asks again (a new capture)', async () => {
    const { f, ctx, notices } = setup()
    capturePhoto.mockResolvedValue(NOTES)
    showAiPreview.mockResolvedValueOnce('retry').mockResolvedValueOnce('discard')
    expect(await runCapture(ctx, photoSrc())).toBeNull()
    expect(capturePhoto).toHaveBeenCalledTimes(2)
    expect(f.live()).toEqual([])
    expect(notices.map((n) => n.testId)).toContain('capture-again')
    expect(countUsage.mock.calls.map((c) => c[0])).toEqual(['ai.capture.photo', 'ai.capture.photo'])
  })

  it('a refusal stays in the dialog with the api’s words; vision off says so; nothing is written', async () => {
    const { f, ctx } = setup()
    openCaptureDialog(ctx)
    capturePhoto.mockRejectedValueOnce(
      new ApiError('rate-limited', 429, 'AI_CAPTURE_DAILY_CAP', 'You’ve used your 10 photo captures for today.'),
    )
    expect(await runCapture(ctx, photoSrc())).toBeNull()
    expect(captureJob(f.canvas).get()).toMatchObject({
      stage: 'error',
      message: 'You’ve used your 10 photo captures for today.',
    })
    capturePhoto.mockRejectedValueOnce(new CaptureUnavailableError())
    expect(await runCapture(ctx, photoSrc())).toBeNull()
    expect(captureJob(f.canvas).get()?.message).toBe(VISION_OFF_MESSAGE)
    expect(captureDialog(f.canvas).get()).not.toBeNull()
    expect(f.live()).toEqual([])
    expect(showAiPreview).not.toHaveBeenCalled()
  })

  it('no notes found: told so, nothing previewed or written', async () => {
    const { f, ctx, notices } = setup()
    capturePhoto.mockResolvedValue(answer({ kind: 'notes', notes: [], groups: [] }))
    expect(await runCapture(ctx, photoSrc())).toBeNull()
    expect(notices.map((n) => n.testId)).toEqual(['capture-nothing'])
    expect(showAiPreview).not.toHaveBeenCalled()
    expect(f.live()).toEqual([])
  })
})

describe('a board image and a transcript', () => {
  it('a board image goes by its id and lands beside it', async () => {
    const { ctx } = setup()
    captureBoardImage.mockResolvedValue(NOTES)
    showAiPreview.mockResolvedValue('apply')
    await runCapture(ctx, { kind: 'board-image', elementId: 'img-1', mode: 'notes', frames: false })
    expect(captureBoardImage).toHaveBeenCalledWith('b-board00001', 'img-1', 'notes', expect.anything())
    expect(pageSpotNear.mock.calls[0]?.[2]).toEqual(['img-1'])
    expect(downsizePhoto).not.toHaveBeenCalled()
    expect(countUsage.mock.calls.map((c) => c[0])).toEqual(['ai.capture.boardimage', 'ai.capture.apply'])
  })

  it('a transcript becomes the meeting frame in one undo step', async () => {
    const { f, ctx } = setup()
    captureTranscript.mockResolvedValue(MEETING)
    showAiPreview.mockResolvedValue('apply')
    await runCapture(ctx, { kind: 'transcript', text: 'Ana: hi', title: 'Sync' })
    expect(captureTranscript).toHaveBeenCalledWith('b-board00001', 'Ana: hi', 'Sync', expect.anything())
    const frame = f.live().find((e) => e.type === 'frame')
    expect(frame?.name).toBe('Meeting — Sync')
    expect(f.live().filter((e) => e.type === 'stickynote')).toHaveLength(3)
    expect(f.steps()).toBe(1)
    expect(countUsage.mock.calls.map((c) => c[0])).toEqual(['ai.capture.transcript', 'ai.capture.apply'])
    // the transcript's own words are nowhere on the board but in the notes the model made
    expect(JSON.stringify(f.live())).not.toContain('Ana: hi')
  })
})
