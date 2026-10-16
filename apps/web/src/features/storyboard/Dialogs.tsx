// OWNER: WS2 (wave T, storyboards). The two dialogs, in the board's popover layer (above the toolbar and the style
// panel; not modal, so the AI notice and busy pill stay reachable; keys, pointers and the wheel inside stay out of the
// canvas; Escape closes):
//  - New storyboard: a title, the aspect (16:9, 9:16, 1:1, 4:5, 2.39:1), how many panels and the layout;
//  - Script to boards: paste a script or open a .txt, .fountain, .md or .csv file; the parser (./script/parse.ts, no
//    AI) shows what it found as an editable list (camera, action, dialogue/VO, duration; remove a row), with the
//    format it detected (or the one chosen) and the running time; "Break down with AI" (./ai.ts) when it is offered;
//    Create makes the storyboard in one step (one Ctrl+Z takes it away).
import { MAX_ITEMS } from '@draftroom/canvas-schema/limits'
import {
  formatDuration,
  formatRunningTime,
  parseDuration,
  SB_ASPECTS,
  SB_DEFAULT_DUR_MS,
  type StoryboardAspect,
} from '@draftroom/canvas-schema/planning'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { type CanvasFeatureContext, items } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { inPopoverLayer, usePopoverLayer } from '../ai/board-popover.tsx'
import { ensureAiStatus } from '../ai/ported/actions.ts'
import { aiBlocked, aiOffered, breakDownWithAi } from './ai.ts'
import { LAYOUTS, shotLabel } from './model.ts'
import { createStoryboard, type NewPanel } from './ops.ts'
import {
  type Beat,
  detectFormat,
  parseScript,
  SCRIPT_FORMAT_LABELS,
  SCRIPT_FORMATS,
  SCRIPT_MAX_BEATS,
  type ScriptFormat,
} from './script/parse.ts'
import { type ScriptDraft, sbState } from './state.ts'

/** The most elements one panel makes (frame, picture and its hint, three captions, three boxes and their labels). */
const ELEMENTS_PER_PANEL = 11
const SCRIPT_FILE_MAX_BYTES = 512 * 1024
const NEW_MAX_PANELS = 60

export function StoryboardDialogLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const s = sbState(ctx.canvas)
  const dialog = useValue('storyboard.dialog', () => s.dialog.get(), [ctx.canvas])
  if (!dialog) return null
  if (dialog.kind === 'new') return <NewDialog ctx={ctx} />
  return <ScriptDialog key={dialog.draft.ai?.run ?? 'parse'} ctx={ctx} draft={dialog.draft} />
}

/** The panel's frame: in the popover layer, centred, keys and pointers kept from the canvas. */
function Shell({
  ctx,
  title,
  testId,
  wide,
  children,
  footer,
}: {
  ctx: CanvasFeatureContext
  title: string
  testId: string
  wide?: boolean
  children: ReactNode
  footer: ReactNode
}) {
  const { canvas } = ctx
  const host = usePopoverLayer(canvas)
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const close = () => {
    sbState(canvas).dialog.set(null)
    canvas.focus({ preventScroll: true })
  }
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
    el.addEventListener('paste', stop)
    el.addEventListener('copy', stop)
    el.addEventListener('cut', stop)
    return () => {
      el.removeEventListener('keydown', key)
      el.removeEventListener('keyup', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('mousedown', stop)
      el.removeEventListener('wheel', stop)
      el.removeEventListener('paste', stop)
      el.removeEventListener('copy', stop)
      el.removeEventListener('cut', stop)
    }
  })
  // the first field takes the keyboard
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('textarea, input, select')?.focus({ preventScroll: true })
  }, [host])
  return inPopoverLayer(
    canvas,
    host,
    <div className="dr-sb-dialog-wrap">
      <div
        ref={ref}
        className={`dr-sb-dialog${wide ? ' dr-sb-dialog--wide' : ''}`}
        role="dialog"
        aria-labelledby={titleId}
        data-testid={testId}
      >
        <header className="dr-sb-dialog__head">
          <h2 id={titleId} className="dr-sb-dialog__title">
            {title}
          </h2>
          <button type="button" className="dr-iconbtn" aria-label="Close" onClick={close}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="dr-sb-dialog__body">{children}</div>
        <footer className="dr-sb-dialog__foot">{footer}</footer>
      </div>
    </div>,
  )
}

function AspectPicker({
  value,
  onChange,
  name,
}: {
  value: StoryboardAspect
  onChange(a: StoryboardAspect): void
  name: string
}) {
  return (
    <fieldset className="dr-sb-aspects">
      <legend className="dr-sb-label">Aspect</legend>
      <div className="dr-sb-aspects__row">
        {SB_ASPECTS.map((a) => {
          const [w, h] = a.split(':').map(Number) as [number, number]
          const s = 22 / Math.max(w, h)
          return (
            <label key={a} className="dr-sb-aspect" data-checked={value === a ? 'true' : undefined}>
              <input
                type="radio"
                name={name}
                value={a}
                checked={value === a}
                onChange={() => onChange(a)}
                data-testid={`sb-aspect-${a.replace(/[:.]/g, '-')}`}
              />
              <span
                className="dr-sb-aspect__box"
                style={{ width: Math.round(w * s), height: Math.round(h * s) }}
                aria-hidden="true"
              />
              <span>{a}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

const fits = (ctx: CanvasFeatureContext, panels: number) =>
  items.contentItems(ctx.canvas.items()).length + panels * ELEMENTS_PER_PANEL <= MAX_ITEMS

function made(ctx: CanvasFeatureContext, result: { headId: string } | null) {
  const s = sbState(ctx.canvas)
  if (!result) {
    ctx.notify({ key: 'storyboard', tone: 'error', text: 'The storyboard could not be made. Try again.' })
    return
  }
  s.dialog.set(null)
  s.strip.set(result.headId)
}

// ---- New storyboard -------------------------------------------------------------------------------------------

function NewDialog({ ctx }: { ctx: CanvasFeatureContext }) {
  const [title, setTitle] = useState('Storyboard')
  const [aspect, setAspect] = useState<StoryboardAspect>('16:9')
  const [count, setCount] = useState('6')
  const [layout, setLayout] = useState('grid-6')
  const name = useId()
  const n = Math.floor(Number(count))
  const valid = Number.isFinite(n) && n >= 1 && n <= NEW_MAX_PANELS
  const create = () => {
    if (!valid) return
    if (!fits(ctx, n)) {
      ctx.notify({
        key: 'storyboard',
        tone: 'error',
        text: 'This board has too many objects for that storyboard.',
      })
      return
    }
    const perRow = LAYOUTS.find((l) => l.id === layout)?.perRow ?? 6
    made(
      ctx,
      createStoryboard(ctx.canvas, {
        title,
        aspect,
        perRow: Math.min(perRow, n),
        panels: Array.from({ length: n }, () => ({})),
        label: 'new storyboard',
      }),
    )
  }
  return (
    <Shell
      ctx={ctx}
      title="New storyboard"
      testId="sb-new-dialog"
      footer={
        <>
          <span />
          <div className="dr-sb-dialog__actions">
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              onClick={() => sbState(ctx.canvas).dialog.set(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-btn--primary"
              data-testid="sb-new-create"
              disabled={!valid}
              onClick={create}
            >
              Create {valid ? `${n} ${n === 1 ? 'panel' : 'panels'}` : 'storyboard'}
            </button>
          </div>
        </>
      }
    >
      <form
        className="dr-sb-form"
        onSubmit={(e) => {
          e.preventDefault()
          create()
        }}
      >
        <label className="dr-sb-label">
          Title
          <input
            className="dr-input dr-input--block"
            data-testid="sb-new-title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <AspectPicker value={aspect} onChange={setAspect} name={name} />
        <div className="dr-sb-form__row">
          <label className="dr-sb-label">
            Panels
            <input
              className="dr-input dr-input--block"
              data-testid="sb-new-count"
              type="number"
              min={1}
              max={NEW_MAX_PANELS}
              value={count}
              aria-invalid={!valid || undefined}
              onChange={(e) => setCount(e.target.value)}
            />
          </label>
          <label className="dr-sb-label">
            Layout
            <select
              className="dr-input dr-input--block dr-select"
              value={layout}
              onChange={(e) => setLayout(e.target.value)}
              data-testid="sb-new-layout"
            >
              {LAYOUTS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" hidden />
      </form>
    </Shell>
  )
}

// ---- Script to boards -----------------------------------------------------------------------------------------

function ScriptDialog({ ctx, draft }: { ctx: CanvasFeatureContext; draft: ScriptDraft }) {
  const { canvas } = ctx
  const [text, setText] = useState(draft.text)
  const [format, setFormat] = useState<ScriptFormat | null>(draft.format)
  const [aspect, setAspect] = useState<StoryboardAspect>(draft.aspect)
  const [title, setTitle] = useState(draft.title)
  const [edited, setEdited] = useState<Beat[] | null>(draft.beats ? [...draft.beats] : null)
  const [ai, setAi] = useState(draft.ai)
  const [fileNote, setFileNote] = useState<string | null>(null)
  const name = useId()
  const textId = useId()
  useEffect(() => {
    void ensureAiStatus(canvas)
  }, [canvas])
  const aiOn = useValue('storyboard.ai-offered', () => aiOffered(canvas), [canvas])
  const parsed = useMemo(() => parseScript(text, format ? { format } : {}), [text, format])
  const detected = useMemo(() => detectFormat(text), [text])
  const beats = edited ?? parsed.beats
  const total = beats.reduce((t, b) => t + (b.durationMs ?? SB_DEFAULT_DUR_MS), 0)
  const current: ScriptDraft = { text, format, aspect, title, beats: edited, ai }
  const reset = () => {
    setEdited(null)
    setAi(null)
  }
  const editBeat = (i: number, patch: Partial<Beat>) =>
    setEdited((beats ?? []).map((b, k) => (k === i ? { ...b, ...patch } : b)))
  const removeBeat = (i: number) => setEdited((beats ?? []).filter((_, k) => k !== i))
  const create = () => {
    if (!beats.length) return
    if (!fits(ctx, beats.length)) {
      ctx.notify({
        key: 'storyboard',
        tone: 'error',
        text: 'This board has too many objects for that storyboard.',
      })
      return
    }
    const panels: NewPanel[] = beats.map((b) => ({
      camera: b.camera,
      action: b.action,
      dialogue: b.dialogue,
      sfx: b.sfx,
      durationMs: b.durationMs,
    }))
    made(
      ctx,
      createStoryboard(canvas, {
        title,
        aspect,
        panels,
        ai,
        label: ai ? 'ai: storyboard' : 'script to boards',
      }),
    )
  }
  const openFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (file.size > SCRIPT_FILE_MAX_BYTES) {
      setFileNote('That file is too large for a script. Paste the part you need instead.')
      return
    }
    try {
      setText(await file.text())
      reset()
      if (!title.trim() || title === 'Storyboard')
        setTitle(file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 120) || 'Storyboard')
      setFileNote(`Opened ${file.name}.`)
    } catch {
      setFileNote('Lobby couldn’t read that file.')
    }
  }
  const blocked = aiBlocked(current)
  return (
    <Shell
      ctx={ctx}
      title="Script to boards"
      testId="sb-script-dialog"
      wide
      footer={
        <>
          <div className="dr-sb-dialog__aside">
            {aiOn && (
              <button
                type="button"
                className="dr-btn dr-btn--sm dr-sb-ai"
                data-testid="sb-ai"
                disabled={blocked !== null}
                title={
                  blocked ??
                  'AI reads the script and suggests the panels: you check them before anything is made'
                }
                onClick={() => void breakDownWithAi(ctx, current)}
              >
                <SparkIcon /> Break down with AI
              </button>
            )}
            {ai && (
              <span className="dr-sb-made-by-ai" data-testid="sb-ai-made">
                Suggested by AI: check the panels before you create them
              </span>
            )}
          </div>
          <div className="dr-sb-dialog__actions">
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              onClick={() => sbState(canvas).dialog.set(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-btn--primary"
              data-testid="sb-script-create"
              disabled={!beats.length}
              onClick={create}
            >
              Create {beats.length} {beats.length === 1 ? 'panel' : 'panels'}
            </button>
          </div>
        </>
      }
    >
      <div className="dr-sb-script">
        <div className="dr-sb-script__source">
          <label className="dr-sb-label" htmlFor={textId}>
            Script
          </label>
          <textarea
            id={textId}
            className="dr-sb-script__text"
            data-testid="sb-script-text"
            spellCheck={false}
            placeholder={
              'Paste an AV script (video and audio columns), a screenplay or a shot list.\n\n1. WIDE - Kitchen at dawn. (3s)\n2. CU - Hands on the mug. VO: Every day starts here.'
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              reset()
            }}
          />
          <div className="dr-sb-script__opts">
            <label className="dr-btn dr-btn--sm dr-btn--ghost dr-sb-file">
              Open a file…
              <input
                type="file"
                accept=".txt,.fountain,.md,.csv,.tsv,text/plain,text/markdown,text/csv"
                data-testid="sb-script-file"
                onChange={(e) => void openFile(e.currentTarget)}
              />
            </label>
            <label className="dr-sb-label dr-sb-label--inline">
              Format
              <select
                className="dr-input dr-select dr-select--compact"
                data-testid="sb-script-format"
                value={format ?? 'auto'}
                onChange={(e) => {
                  setFormat(e.target.value === 'auto' ? null : (e.target.value as ScriptFormat))
                  reset()
                }}
              >
                <option value="auto">Detect ({SCRIPT_FORMAT_LABELS[detected]})</option>
                {SCRIPT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {SCRIPT_FORMAT_LABELS[f]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {fileNote && <p className="dr-sb-note">{fileNote}</p>}
          <label className="dr-sb-label">
            Title
            <input
              className="dr-input dr-input--block"
              data-testid="sb-script-title"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <AspectPicker value={aspect} onChange={setAspect} name={name} />
        </div>
        <div className="dr-sb-script__preview">
          <div className="dr-sb-script__summary" data-testid="sb-script-summary" aria-live="polite">
            <strong>
              {beats.length} {beats.length === 1 ? 'panel' : 'panels'}
            </strong>
            <span>· {formatRunningTime(total)}</span>
            {parsed.truncated && !edited && (
              <span className="dr-sb-note">The first {SCRIPT_MAX_BEATS} only</span>
            )}
          </div>
          {beats.length ? (
            <ol className="dr-sb-beats" data-testid="sb-script-beats">
              {beats.map((b, i) => (
                <BeatRow
                  key={i}
                  i={i}
                  beat={b}
                  onChange={(patch) => editBeat(i, patch)}
                  onRemove={() => removeBeat(i)}
                />
              ))}
            </ol>
          ) : (
            <p className="dr-sb-empty" data-testid="sb-script-empty">
              {text.trim()
                ? 'Nothing here reads as a shot yet. Try another format.'
                : 'The panels show here as you paste.'}
            </p>
          )}
        </div>
      </div>
    </Shell>
  )
}

function BeatRow({
  i,
  beat,
  onChange,
  onRemove,
}: {
  i: number
  beat: Beat
  onChange(patch: Partial<Beat>): void
  onRemove(): void
}) {
  const [dur, setDur] = useState<string | null>(null)
  const ms = beat.durationMs
  return (
    <li className="dr-sb-beat" data-testid="sb-script-beat">
      <div className="dr-sb-beat__head">
        <span className="dr-sb-beat__num">{shotLabel(i + 1)}</span>
        <input
          className="dr-input dr-sb-beat__cam"
          aria-label={`Camera, shot ${i + 1}`}
          placeholder="Camera"
          value={beat.camera}
          data-testid="sb-beat-camera"
          onChange={(e) => onChange({ camera: e.target.value })}
        />
        <input
          className="dr-input dr-sb-beat__dur"
          aria-label={`Duration, shot ${i + 1}`}
          placeholder={formatDuration(SB_DEFAULT_DUR_MS)}
          value={dur ?? (ms === null ? '' : formatDuration(ms))}
          data-testid="sb-beat-duration"
          onChange={(e) => setDur(e.target.value)}
          onBlur={() => {
            if (dur === null) return
            const v = dur.trim() ? parseDuration(dur) : null
            if (!dur.trim() || v !== null) onChange({ durationMs: v })
            setDur(null)
          }}
        />
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm"
          aria-label={`Remove shot ${i + 1}`}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      <textarea
        className="dr-sb-beat__text"
        aria-label={`Action, shot ${i + 1}`}
        placeholder="Action: what we see"
        rows={2}
        value={beat.action + (beat.sfx ? `${beat.action ? '\n' : ''}SFX: ${beat.sfx}` : '')}
        data-testid="sb-beat-action"
        onChange={(e) => onChange({ action: e.target.value, sfx: '' })}
      />
      <textarea
        className="dr-sb-beat__text"
        aria-label={`Dialogue or voice-over, shot ${i + 1}`}
        placeholder="Dialogue / VO"
        rows={2}
        value={beat.dialogue}
        data-testid="sb-beat-dialogue"
        onChange={(e) => onChange({ dialogue: e.target.value })}
      />
    </li>
  )
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true" focusable="false">
      <path d="M8 1.5l1.6 4.2 4.4 1.3-4.4 1.3L8 12.5 6.4 8.3 2 7l4.4-1.3z" fill="currentColor" />
    </svg>
  )
}
