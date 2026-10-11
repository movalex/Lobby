// OWNER: WS5 (wave N, N5-2, N5-4, N5-5). "Capture the room": the dialog (a screen-layer overlay of the AI feature, in
// the popover layer above the board's chrome) for a photo or a meeting transcript.
//
// - Photo: "Take photo" (the phone's camera: accept image/*, capture environment), "Choose file", and Notes, Diagram
//   or Auto; "Put each group in a frame" (notes) and "Also add the photo to the board" (off: nothing of the photo is
//   kept unless it is ticked). Opened from an image's context menu it reads that image (no file to pick).
// - Meeting transcript: paste the text, or open a .txt, .vtt, .srt or .md file (parsed here: ./transcript.ts), an
//   optional title, and a length meter; past 60,000 characters "Only the first 60,000 characters will be used."
// - The notices (N5-5): on a person's first photo or transcript capture the dialog shows what is sent where, with a
//   Continue (no checkbox); the same words are always in its footer, with the per-day count the last answer gave
//   ("7 photo captures left today").
// - While a capture runs the dialog says what it is doing, with Cancel; a failure stays in the dialog. Once there is an
//   answer the dialog closes and the shared AI preview shows it (./run.ts).
// Keys, pointers and the wheel inside it stay out of the canvas; Escape closes it.
import { CAPTURE_TITLE_MAX_CHARS, CAPTURE_TRANSCRIPT_MAX_CHARS, type CaptureMode } from '@draftroom/contracts'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { topCentreAnchor } from '../board-chrome.ts'
import { inPopoverLayer, useBoardPlacement, usePopoverLayer } from '../board-popover.tsx'
import '../ai.css'
import '../ported/wave-m.css'
import '../ported/capture.css'
import {
  CAPTURE_PHOTO_NOTICE,
  CAPTURE_TRANSCRIPT_NOTICE,
  lengthMeter,
  photosLeftLine,
  transcriptsLeftLine,
} from '../copy.ts'
import { SparkIcon, Spinner } from '../icons.tsx'
import { captureFacts } from './client.ts'
import {
  type CaptureSource,
  cancelCapture,
  captureDialog,
  captureJob,
  captureNoticeSeen,
  closeCaptureDialog,
  markCaptureNoticeSeen,
  runCapture,
  VISION_OFF_MESSAGE,
} from './run.ts'
import {
  formatOf,
  parseTranscript,
  TRANSCRIPT_ACCEPT,
  TRANSCRIPT_FILE_MAX_BYTES,
  transcriptLimit,
} from './transcript.ts'

/** The photo file inputs' accept lists: the camera's, and any image the browser can open. */
export const CAMERA_ACCEPT = 'image/*'
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/*'

const MODES: readonly { mode: CaptureMode; label: string }[] = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'notes', label: 'Notes' },
  { mode: 'diagram', label: 'Diagram' },
]

const STAGES = {
  preparing: 'Making the photo smaller…',
  reading: {
    photo: 'Reading the photo…',
    'board-image': 'Reading the image…',
    transcript: 'Reading the meeting…',
  },
} as const

/** The overlay: the dialog while it is open (editors only: a read-only canvas never shows it). */
export function CaptureDialogOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const open = useValue('lobby-capture-open', () => captureDialog(canvas).get(), [canvas])
  if (!open || canvas.readOnly()) return null
  return <CaptureDialog key={open.id} ctx={ctx} />
}

type Pending = { readonly kind: 'photo' | 'transcript'; readonly src: CaptureSource }

function CaptureDialog({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const userId = ctx.me.user.id
  const state = captureDialog(canvas).get()
  const [tab, setTab] = useState<'photo' | 'transcript'>(state?.tab ?? 'photo')
  const [mode, setMode] = useState<CaptureMode>(state?.boardImage?.mode ?? 'auto')
  const [frames, setFrames] = useState(true)
  const [addPhoto, setAddPhoto] = useState(false)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [fileNote, setFileNote] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const facts = useValue('lobby-capture-facts', () => captureFacts.get(), [])
  const job = useValue('lobby-capture-job', () => captureJob(canvas).get(), [canvas])
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const textId = useId()
  const titleInputId = useId()
  const busy = !!job && job.stage !== 'error'

  const close = () => {
    if (busy) cancelCapture(canvas)
    else captureJob(canvas).set(null)
    closeCaptureDialog(canvas)
    canvas.focus({ preventScroll: true })
  }
  // keys, pointers and the wheel inside the dialog stay out of the canvas (keys arrive natively)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    const key = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    el.addEventListener('keydown', key)
    el.addEventListener('keyup', stop)
    el.addEventListener('pointerdown', stop)
    el.addEventListener('mousedown', stop)
    el.addEventListener('wheel', stop, { passive: true })
    return () => {
      el.removeEventListener('keydown', key)
      el.removeEventListener('keyup', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('mousedown', stop)
      el.removeEventListener('wheel', stop)
    }
  })
  const host = usePopoverLayer(canvas)
  const pos = useBoardPlacement(canvas, ref, () => topCentreAnchor(canvas), { prefer: 'below' })

  /** Starts `src`, after the notice when this person has not seen it yet. */
  const start = (src: CaptureSource) => {
    const kind = src.kind === 'transcript' ? 'transcript' : 'photo'
    captureJob(canvas).set(null)
    if (!captureNoticeSeen(userId, kind)) {
      setPending({ kind, src })
      return
    }
    void runCapture(ctx, src)
  }
  const confirmNotice = () => {
    if (!pending) return
    markCaptureNoticeSeen(userId, pending.kind)
    const src = pending.src
    setPending(null)
    void runCapture(ctx, src)
  }

  // opened on a board image: it starts at once (after the notice the first time)
  const started = useRef(false)
  useEffect(() => {
    const image = state?.boardImage
    if (!image || started.current) return
    started.current = true
    start({ kind: 'board-image', elementId: image.elementId, mode: image.mode, frames })
  })

  const pickPhoto = (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    start({ kind: 'photo', file, name: file.name || 'Photo', mode, addPhoto, frames })
  }
  const openTranscriptFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (file.size > TRANSCRIPT_FILE_MAX_BYTES) {
      setFileNote('That file is too large to be a transcript. Paste the text instead.')
      return
    }
    try {
      const raw = await file.text()
      const parsed = parseTranscript(raw, formatOf(file.name, raw))
      setText(parsed)
      if (!title.trim()) setTitle(file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, CAPTURE_TITLE_MAX_CHARS))
      setFileNote(`Opened ${file.name}: cue numbers and timestamps taken out.`)
    } catch {
      setFileNote('Lobby couldn’t read that file.')
    }
  }
  const limited = transcriptLimit(text, CAPTURE_TRANSCRIPT_MAX_CHARS)
  const sendTranscript = () => {
    if (!limited.text) return
    start({ kind: 'transcript', text: limited.text, ...(title.trim() ? { title: title.trim() } : {}) })
  }

  const boardImage = state?.boardImage
  const photoOff = facts.visionOff
  const notice = tab === 'transcript' ? CAPTURE_TRANSCRIPT_NOTICE : CAPTURE_PHOTO_NOTICE
  const left = tab === 'transcript' ? facts.quota?.transcriptsLeftToday : facts.quota?.photosLeftToday
  const quotaLine =
    typeof left !== 'number' ? null : tab === 'transcript' ? transcriptsLeftLine(left) : photosLeftLine(left)

  let body: ReactNode
  if (pending) {
    // N5-5: the first use's notice, a Continue and no checkbox
    body = (
      <div className="dr-ai-capture__notice" data-testid="capture-notice">
        <p className="dr-ai-capture__notice-text" data-testid="capture-notice-text">
          {pending.kind === 'transcript' ? CAPTURE_TRANSCRIPT_NOTICE : CAPTURE_PHOTO_NOTICE}
        </p>
        <div className="dr-ai-form__row">
          <span className="dr-ai-form__spacer" />
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="capture-notice-cancel"
            onClick={() => setPending(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="capture-notice-continue"
            // biome-ignore lint/a11y/noAutofocus: the notice is the one thing to answer
            autoFocus
            onClick={confirmNotice}
          >
            Continue
          </button>
        </div>
      </div>
    )
  } else if (busy && job) {
    body = (
      <div className="dr-ai-capture__busy" role="status" data-testid="capture-busy">
        <Spinner />
        <span data-testid="capture-stage">
          {job.stage === 'preparing' ? STAGES.preparing : STAGES.reading[job.kind]}
        </span>
        <span className="dr-ai-form__spacer" />
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="capture-cancel"
          onClick={() => cancelCapture(canvas)}
        >
          Cancel
        </button>
      </div>
    )
  } else if (boardImage) {
    body = (
      <div className="dr-ai-form">
        <p className="dr-ai-capture__lead" data-testid="capture-board-image">
          {mode === 'diagram'
            ? 'Turns the selected image into a diagram.'
            : 'Turns the selected image into notes.'}
        </p>
        {job?.stage === 'error' && (
          <div className="dr-ai-form__row">
            <span className="dr-ai-form__spacer" />
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              data-testid="capture-retry"
              onClick={() => start({ kind: 'board-image', elementId: boardImage.elementId, mode, frames })}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    )
  } else if (tab === 'photo') {
    body = photoOff ? (
      <p className="dr-ai-capture__lead" data-testid="capture-photo-off">
        {VISION_OFF_MESSAGE}
      </p>
    ) : (
      <div className="dr-ai-form">
        <div className="dr-ai-capture__picks">
          <label className="dr-btn dr-btn--primary dr-btn--sm dr-ai-capture__pick">
            <input
              type="file"
              accept={CAMERA_ACCEPT}
              capture="environment"
              className="dr-ai-capture__file"
              data-testid="capture-take-photo"
              onChange={(e) => pickPhoto(e.currentTarget)}
            />
            Take photo
          </label>
          <label className="dr-btn dr-btn--sm dr-ai-capture__pick">
            <input
              type="file"
              accept={PHOTO_ACCEPT}
              className="dr-ai-capture__file"
              data-testid="capture-choose-file"
              onChange={(e) => pickPhoto(e.currentTarget)}
            />
            Choose file
          </label>
        </div>
        <fieldset className="dr-ai-seg dr-ai-capture__modes" data-testid="capture-mode">
          <legend className="dr-ai-form__label">Turn it into</legend>
          {MODES.map((m) => (
            <label key={m.mode} className="dr-ai-seg__opt" data-checked={mode === m.mode ? '' : undefined}>
              <input
                type="radio"
                name={`${titleId}-mode`}
                value={m.mode}
                data-testid={`capture-mode-${m.mode}`}
                checked={mode === m.mode}
                onChange={() => setMode(m.mode)}
              />
              <span>{m.label}</span>
            </label>
          ))}
        </fieldset>
        {mode !== 'diagram' && (
          <label className="dr-ai-form__radio">
            <input
              type="checkbox"
              data-testid="capture-frames"
              checked={frames}
              onChange={(e) => setFrames(e.target.checked)}
            />
            Put each group of notes in a frame
          </label>
        )}
        <label className="dr-ai-form__radio">
          <input
            type="checkbox"
            data-testid="capture-add-photo"
            checked={addPhoto}
            onChange={(e) => setAddPhoto(e.target.checked)}
          />
          Also add the photo to the board
        </label>
      </div>
    )
  } else {
    body = (
      <form
        className="dr-ai-form"
        onSubmit={(e) => {
          e.preventDefault()
          sendTranscript()
        }}
      >
        <label htmlFor={textId} className="dr-ai-form__label">
          Paste the transcript, or open a file
        </label>
        <textarea
          id={textId}
          className="dr-ai-form__input dr-ai-capture__text"
          data-testid="capture-transcript-text"
          rows={6}
          value={text}
          placeholder="Ana: Shall we move the shoot to the 14th?"
          onChange={(e) => {
            setText(e.target.value)
            setFileNote(null)
          }}
        />
        <div className="dr-ai-capture__meter-row">
          <label className="dr-btn dr-btn--sm dr-ai-capture__pick">
            <input
              type="file"
              accept={TRANSCRIPT_ACCEPT}
              className="dr-ai-capture__file"
              data-testid="capture-transcript-file"
              onChange={(e) => void openTranscriptFile(e.currentTarget)}
            />
            Open file
          </label>
          <span className="dr-ai-form__spacer" />
          <span
            className="dr-ai-capture__meter"
            data-testid="capture-transcript-meter"
            data-over={limited.truncated ? '' : undefined}
          >
            {lengthMeter(limited.length, CAPTURE_TRANSCRIPT_MAX_CHARS)}
          </span>
        </div>
        {fileNote && (
          <p className="dr-ai-capture__hint" data-testid="capture-transcript-file-note">
            {fileNote}
          </p>
        )}
        {limited.notice && (
          <p className="dr-ai-capture__hint" data-testid="capture-transcript-truncated">
            {limited.notice}
          </p>
        )}
        <label htmlFor={titleInputId} className="dr-ai-form__label">
          Meeting name (optional)
        </label>
        <input
          id={titleInputId}
          className="dr-ai-form__input"
          data-testid="capture-transcript-title"
          maxLength={CAPTURE_TITLE_MAX_CHARS}
          value={title}
          placeholder="Weekly sync"
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="dr-ai-form__row">
          <span className="dr-ai-form__spacer" />
          <button
            type="submit"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="capture-transcript-go"
            disabled={!limited.text}
          >
            Capture the meeting
          </button>
        </div>
      </form>
    )
  }

  return inPopoverLayer(
    canvas,
    host,
    <div
      ref={ref}
      className="dr-ai-pop dr-ai-capture"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="capture-dialog"
      style={
        pos
          ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
          : { left: 0, top: 0, opacity: 0, pointerEvents: 'none' }
      }
    >
      <div className="dr-ai-pop__head">
        <span className="dr-ai-pop__badge" aria-hidden="true">
          <SparkIcon size={14} />
        </span>
        <h2 id={titleId} className="dr-ai-pop__title">
          Capture the room
        </h2>
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm"
          aria-label="Close"
          data-testid="capture-close"
          onClick={close}
        >
          ×
        </button>
      </div>
      {!boardImage && !pending && !busy && (
        <div className="dr-ai-capture__tabs" role="tablist" aria-label="What to capture">
          {(['photo', 'transcript'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className="dr-ai-capture__tab"
              data-testid={`capture-tab-${t}`}
              onClick={() => {
                setTab(t)
                captureJob(canvas).set(null)
              }}
            >
              {t === 'photo' ? 'Photo' : 'Meeting transcript'}
            </button>
          ))}
        </div>
      )}
      {body}
      {job?.stage === 'error' && !pending && (
        <p className="dr-ai-capture__error" role="alert" data-testid="capture-error">
          {job.message}
        </p>
      )}
      <p className="dr-ai-pop__foot" data-testid="capture-footer">
        {notice}
        {quotaLine && (
          <>
            {' '}
            <span className="dr-ai-capture__quota" data-testid="capture-quota">
              {quotaLine}
            </span>
          </>
        )}
      </p>
    </div>,
  )
}
