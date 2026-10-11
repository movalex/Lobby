// OWNER: WS5 (wave N, N5-2 to N5-5). Capture the room on the board page: what the dialog (./CaptureDialog.tsx) asks
// for, from the request to the result on the board.
//
// 1. The request (./client.ts): a photo is made ready first (./downsize.ts: at most 2048 px, a JPEG with no EXIF or
//    GPS), a board image goes by its element id, a transcript as its text. The dialog shows the stage and a Cancel.
// 2. The result is planned where this tab is looking (../ported/apply.ts pageSpotNear: on the page, never inside a
//    frame, beside the board image it came from): notes in the photo's layout (./notes.ts), a native diagram
//    (./diagram.ts, W4's writer), or a meeting frame (./meeting.ts).
// 3. It is shown first (the shared AI preview, with its words and counts); Apply writes it in ONE undo step with the
//    `ai` provenance, brings it into this tab's view (../reveal.ts) and says AI made it (with the one-step Undo);
//    Try again is a new capture; Discard writes nothing.
// 4. Only then, and only when the person ticked "Also add the photo to the board", the photo takes the normal
//    upload path (canvas.files.insert): the downsized JPEG, beside the result. Otherwise nothing of the photo is kept.
// Usage events (names only): ai.capture.photo / .boardimage / .transcript when a request goes, ai.capture.apply.

import type { CaptureMode, CaptureResponse } from '@draftroom/contracts'
import { isApiError } from '../../../api/client.ts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { countUsage } from '../../../lib/usage.ts'
import { freshId } from '../../flow/runtime.ts'
import { CAPTURE_NOTHING, meetingFrameName, plural } from '../copy.ts'
import { applyDiagram, planDiagram } from '../diagram/apply.ts'
import { madeByAiText, previewOf } from '../diagram/DiagramPrompt.tsx'
import { layoutText, newId, pageSpotNear } from '../ported/apply.ts'
import { type AiPreviewPlan, aiResultToast, showAiPreview } from '../ported/public.ts'
import { perCanvas, setAiCtx } from '../ported/runtime.ts'
import { revealResult } from '../reveal.ts'
import { CaptureUnavailableError, captureBoardImage, capturePhoto, captureTranscript } from './client.ts'
import { measureCaptureDiagram } from './diagram.ts'
import { type DownsizedPhoto, downsizePhoto, PhotoUnreadableError } from './downsize.ts'
import { applyMeeting, meetingSize, planMeeting } from './meeting.ts'
import { applyCaptureNotes, measureCaptureNotes, planCaptureNotes } from './notes.ts'

export type CaptureSource =
  | {
      readonly kind: 'photo'
      readonly file: Blob
      readonly name: string
      readonly mode: CaptureMode
      readonly addPhoto: boolean
      readonly frames: boolean
    }
  | {
      readonly kind: 'board-image'
      readonly elementId: string
      readonly mode: CaptureMode
      readonly frames: boolean
    }
  | { readonly kind: 'transcript'; readonly text: string; readonly title?: string }

/** What the open dialog shows: its tab, and the board image it was opened on (the image menu's entries). */
export interface CaptureDialogState {
  readonly id: number
  readonly tab: 'photo' | 'transcript'
  readonly boardImage?: { readonly elementId: string; readonly mode: CaptureMode }
}
export const captureDialog = perCanvas<Atom<CaptureDialogState | null>>(() =>
  atom<CaptureDialogState | null>('lobby-capture-dialog', null),
)
let seq = 0
export function openCaptureDialog(
  ctx: CanvasFeatureContext,
  opts: { tab?: 'photo' | 'transcript'; boardImage?: { elementId: string; mode: CaptureMode } } = {},
): void {
  setAiCtx(ctx)
  captureDialog(ctx.canvas).set({
    id: ++seq,
    tab: opts.boardImage ? 'photo' : (opts.tab ?? 'photo'),
    ...(opts.boardImage ? { boardImage: opts.boardImage } : {}),
  })
}
export const closeCaptureDialog = (canvas: LobbyCanvas) => captureDialog(canvas).set(null)

/** A capture under way, or its failure (the dialog shows it); null when none. Never stored. */
export interface CaptureJob {
  readonly stage: 'preparing' | 'reading' | 'error'
  readonly kind: CaptureSource['kind']
  readonly message?: string
  readonly abort: AbortController
}
export const captureJob = perCanvas<Atom<CaptureJob | null>>(() =>
  atom<CaptureJob | null>('lobby-capture-job', null),
)

export const VISION_OFF_MESSAGE =
  'Photo capture is turned off for Lobby right now. You can still capture a meeting transcript.'
export const CAPTURE_MISSING_MESSAGE = 'Capture the room isn’t available on this board right now.'
export const PHOTO_UNREADABLE_MESSAGE = 'Lobby couldn’t read this photo. Try a JPEG or PNG.'

const NOTICE_KEY = 'ai-capture'
/** Most captures one dialog makes (Try again counts). */
const MAX_TRIES = 5

/** The request (step 1 of the header); the photo made ready is returned with the answer. */
async function request(
  ctx: CanvasFeatureContext,
  src: CaptureSource,
  signal: AbortSignal,
  stage: (s: CaptureJob['stage']) => void,
): Promise<{ response: CaptureResponse; photo: DownsizedPhoto | null }> {
  const board = ctx.board.id
  if (src.kind === 'photo') {
    stage('preparing')
    const photo = await downsizePhoto(src.file)
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    stage('reading')
    countUsage('ai.capture.photo')
    return { response: await capturePhoto(board, photo.blob, src.mode, { signal }), photo }
  }
  stage('reading')
  if (src.kind === 'board-image') {
    countUsage('ai.capture.boardimage')
    return { response: await captureBoardImage(board, src.elementId, src.mode, { signal }), photo: null }
  }
  countUsage('ai.capture.transcript')
  return { response: await captureTranscript(board, src.text, src.title, { signal }), photo: null }
}

interface Planned {
  readonly preview: AiPreviewPlan
  apply(): string[]
  readonly bounds: { x: number; y: number; w: number; h: number }
  readonly toast: string
}

/** The result planned on the board (step 2), or null when it holds nothing to add (the person is told). */
export function planCapture(
  ctx: CanvasFeatureContext,
  response: CaptureResponse,
  src: CaptureSource,
  now: Date = new Date(),
): Planned | null {
  const { canvas } = ctx
  const by = ctx.me.user.id
  const runId = response.runId
  const near = src.kind === 'board-image' ? [src.elementId] : []
  const r = response.result
  const nothing = (text: string) => {
    ctx.notify({ key: NOTICE_KEY, text, testId: 'capture-nothing', timeoutMs: 9000 })
    return null
  }
  if (r.kind === 'notes') {
    if (!r.notes.length) return nothing(CAPTURE_NOTHING.notes)
    const frames = src.kind !== 'transcript' && src.frames
    const size = measureCaptureNotes(r, { frames }).size
    const origin = pageSpotNear(canvas, size, near)
    const plan = planCaptureNotes(r, { origin, by, runId, newId, frames })
    return {
      preview: plan.preview,
      apply: () => applyCaptureNotes(canvas, plan),
      bounds: plan.bounds,
      toast: `Made by AI: ${plural(plan.noteIds.length, 'note')} from your photo.`,
    }
  }
  if (r.kind === 'diagram') {
    const measured = measureCaptureDiagram(r, (t, s) => canvas.text.measure(t, s))
    if (!measured) return nothing(CAPTURE_NOTHING.diagram)
    const origin = pageSpotNear(canvas, { w: measured.layout.width, h: measured.layout.height }, near)
    const plan = planDiagram(measured, {
      origin,
      frameId: null,
      provenance: { by, run: runId },
      newId: freshId,
    })
    return {
      preview: { ...previewOf(plan, runId), title: 'Diagram from the photo' },
      apply: () => applyDiagram(canvas, plan, 'ai: capture diagram'),
      bounds: plan.bounds,
      toast: madeByAiText(plan),
    }
  }
  if (!r.themes.length && !r.decisions.length && !r.actions.length) return nothing(CAPTURE_NOTHING.transcript)
  const name = meetingFrameName(src.kind === 'transcript' ? src.title : undefined, now)
  const layout = (t: string, size: number, w: number) => layoutText(canvas, t, size, w)
  const size = meetingSize(r, layout, name)
  const origin = pageSpotNear(canvas, size, near)
  const plan = planMeeting(r, { origin, name, by, runId, newId, layout })
  return {
    preview: plan.preview,
    apply: () => applyMeeting(canvas, plan),
    bounds: plan.bounds,
    toast: `Made by AI: the meeting’s ${plural(r.themes.length, 'theme')}, ${plural(r.decisions.length, 'decision')} and ${plural(r.actions.length, 'action')}.`,
  }
}

/** What went wrong, in the person's words (the api's own messages are user-safe). */
export function captureErrorText(e: unknown, kind: CaptureSource['kind']): string {
  if (e instanceof CaptureUnavailableError)
    return kind === 'transcript' ? CAPTURE_MISSING_MESSAGE : VISION_OFF_MESSAGE
  if (e instanceof PhotoUnreadableError) return PHOTO_UNREADABLE_MESSAGE
  if (isApiError(e)) return e.message
  return 'The capture failed. Try again.'
}

/**
 * Runs a capture from the dialog (see the header). Resolves the ids it wrote, or null (nothing written: cancelled,
 * refused, discarded, or nothing found). The dialog stays open (with the error) when the request fails, and closes
 * once there is an answer to preview.
 */
export async function runCapture(ctx: CanvasFeatureContext, src: CaptureSource): Promise<string[] | null> {
  setAiCtx(ctx)
  const { canvas } = ctx
  const slot = captureJob(canvas)
  if (slot.get() && slot.get()?.stage !== 'error') return null
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const abort = new AbortController()
    const job = (stage: CaptureJob['stage'], message?: string): CaptureJob => ({
      stage,
      kind: src.kind,
      abort,
      ...(message ? { message } : {}),
    })
    slot.set(job(src.kind === 'photo' ? 'preparing' : 'reading'))
    let got: { response: CaptureResponse; photo: DownsizedPhoto | null }
    try {
      got = await request(ctx, src, abort.signal, (s) => {
        if (slot.get()?.abort === abort) slot.set(job(s))
      })
    } catch (e) {
      if (abort.signal.aborted || slot.get()?.abort !== abort) {
        if (slot.get()?.abort === abort) slot.set(null)
        return null
      }
      slot.set(job('error', captureErrorText(e, src.kind)))
      // a retry that failed has no dialog to show it in
      if (tries > 0 || !captureDialog(canvas).get())
        ctx.notify({
          key: NOTICE_KEY,
          text: captureErrorText(e, src.kind),
          tone: 'error',
          testId: 'capture-error',
        })
      return null
    }
    if (slot.get()?.abort !== abort) return null // cancelled while the answer was on its way
    slot.set(null)
    closeCaptureDialog(canvas)
    if (canvas.readOnly()) return null
    const planned = planCapture(ctx, got.response, src)
    if (!planned) return null
    const choice = await showAiPreview(ctx, planned.preview)
    if (choice === 'retry') {
      ctx.notify({ key: NOTICE_KEY, text: 'Asking AI again…', testId: 'capture-again', timeoutMs: 4000 })
      continue
    }
    if (choice !== 'apply' || canvas.readOnly()) return null
    const ids = planned.apply()
    countUsage('ai.capture.apply')
    void revealResult(canvas, ids)
    aiResultToast(ctx, planned.toast, ids)
    if (src.kind === 'photo' && src.addPhoto && got.photo)
      void addPhoto(ctx, src.name, got.photo, planned.bounds)
    return ids
  }
  return null
}

/** Cancels the capture under way (the dialog's Cancel); the dialog stays open. */
export function cancelCapture(canvas: LobbyCanvas): void {
  const job = captureJob(canvas).get()
  if (!job) return
  job.abort.abort()
  captureJob(canvas).set(null)
}

/** "Also add the photo to the board": the downsized JPEG through the normal upload path, right of the result. */
async function addPhoto(
  ctx: CanvasFeatureContext,
  name: string,
  photo: DownsizedPhoto,
  bounds: { x: number; y: number; w: number; h: number },
): Promise<void> {
  const base = name.replace(/\.[a-z0-9]+$/i, '').trim() || 'Photo'
  const file = new File([photo.blob], `${base}.jpg`, { type: 'image/jpeg' })
  const shown = Math.min(480, photo.width)
  try {
    await ctx.canvas.files.insert([file], {
      x: bounds.x + bounds.w + 80 + shown / 2,
      y: bounds.y + bounds.h / 2,
    })
  } catch {
    ctx.notify({
      key: NOTICE_KEY,
      text: 'The photo could not be added to the board. The notes are there.',
      tone: 'error',
      testId: 'capture-photo-failed',
    })
  }
}

// ---- the first-use notice (N5-5) ------------------------------------------------------------------------------

const seen = new Set<string>()
const noticeKey = (userId: string, kind: 'photo' | 'transcript') =>
  `lobby.capture.notice.v1:${userId}:${kind}`

/** Whether this person has seen the notice for photos or transcripts (this device; this page when storage fails). */
export function captureNoticeSeen(userId: string, kind: 'photo' | 'transcript'): boolean {
  const k = noticeKey(userId, kind)
  if (seen.has(k)) return true
  try {
    return globalThis.localStorage?.getItem(k) === '1'
  } catch {
    return false
  }
}

export function markCaptureNoticeSeen(userId: string, kind: 'photo' | 'transcript'): void {
  const k = noticeKey(userId, kind)
  seen.add(k)
  try {
    globalThis.localStorage?.setItem(k, '1')
  } catch {
    // remembered for this page only
  }
}
