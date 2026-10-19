// OWNER: WS2 (wave V, V1; docs/WAVE-V-CONTRACTS.md §2.1, §2.2). Start a poll, a scale or a word cloud (facilitators:
// the api decides). One question, the kind's choices, an optional time limit, Anonymous (on by default; what it means
// is said next to it, and that a rare word can still tell who wrote it) and whether everyone sees the counts while it
// runs. Checked here with the contracts' own schema (StartActivityInput) before it is sent; the api checks again.
import { ACTIVITY_LIMITS, type ActivityKind, SCALE_RANGES, StartActivityInput } from '@draftroom/contracts'
import { type FormEvent, useId, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import type { ActivityStore } from './store.ts'
import { ACTIVITY_PANEL_ID, DURATION_CHOICES, kindLabel } from './words.ts'

type Ctx = CanvasFeatureContext

const KINDS: readonly { kind: ActivityKind; hint: string }[] = [
  { kind: 'poll', hint: 'Choose from options' },
  { kind: 'scale', hint: 'Rate on a number line' },
  { kind: 'words', hint: 'A few words each' },
]

const SUBMIT: Readonly<Record<ActivityKind, string>> = {
  poll: 'Start poll',
  scale: 'Start scale',
  words: 'Start word cloud',
}

const PLACEHOLDER: Readonly<Record<ActivityKind, string>> = {
  poll: 'Which day suits the offsite best?',
  scale: 'How confident are you in the plan?',
  words: 'One word for this sprint?',
}

/** The first problem the contracts' schema finds, in its own (user-facing) words. */
export function setupProblem(input: unknown): string | null {
  const p = StartActivityInput.safeParse(input)
  if (p.success) return null
  return p.error.issues[0]?.message ?? 'Check the question and its choices.'
}

/** What the dialog sends for its fields (pure; the dialog and its test build it the same way). */
export function setupInput(f: {
  kind: ActivityKind
  prompt: string
  options: readonly string[]
  maxChoices: number
  range: number
  minLabel: string
  maxLabel: string
  maxWords: number
  durationMs: number | null
  anonymous: boolean
  resultsLive: boolean
}): StartActivityInput {
  const base = {
    prompt: f.prompt,
    anonymous: f.anonymous,
    resultsLive: f.resultsLive,
    durationMs: f.durationMs,
  }
  if (f.kind === 'poll') {
    const options = f.options.map((o) => o.trim()).filter(Boolean)
    return {
      kind: 'poll',
      config: { options, maxChoices: Math.min(f.maxChoices, Math.max(1, options.length)) },
      ...base,
    }
  }
  if (f.kind === 'scale') {
    const [min, max] = SCALE_RANGES[f.range] ?? SCALE_RANGES[0]
    return {
      kind: 'scale',
      config: { min, max, minLabel: f.minLabel.trim() || null, maxLabel: f.maxLabel.trim() || null },
      ...base,
    }
  }
  return { kind: 'words', config: { maxWords: f.maxWords }, ...base }
}

export function SetupDialog({ ctx, store, onClose }: { ctx: Ctx; store: ActivityStore; onClose(): void }) {
  const [kind, setKind] = useState<ActivityKind>('poll')
  const [prompt, setPrompt] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [maxChoices, setMaxChoices] = useState(1)
  const [range, setRange] = useState(0)
  const [minLabel, setMinLabel] = useState('')
  const [maxLabel, setMaxLabel] = useState('')
  const [maxWords, setMaxWords] = useState<number>(ACTIVITY_LIMITS.wordsPerPersonDefault)
  const [duration, setDuration] = useState(0)
  const [anonymous, setAnonymous] = useState(true)
  const [resultsLive, setResultsLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const id = useId()
  const optionRefs = useRef<(HTMLInputElement | null)[]>([])

  const input = setupInput({
    kind,
    prompt,
    options,
    maxChoices,
    range,
    minLabel,
    maxLabel,
    maxWords,
    durationMs: DURATION_CHOICES[duration]?.ms ?? null,
    anonymous,
    resultsLive,
  })
  const filledOptions = options.filter((o) => o.trim()).length

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || sending.current) return
    const problem = setupProblem(input)
    if (problem) {
      setError(problem)
      return
    }
    sending.current = true
    setBusy(true)
    setError(null)
    const r = await store.start(input)
    sending.current = false
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'It could not be started.')
      return
    }
    onClose()
    ctx.openPanel(ACTIVITY_PANEL_ID)
  }

  const addOption = () => {
    if (options.length >= ACTIVITY_LIMITS.pollOptionsMax) return
    setOptions([...options, ''])
    // the new field takes the keyboard once it is drawn
    requestAnimationFrame(() => optionRefs.current[options.length]?.focus())
  }
  const removeOption = (i: number) => {
    if (options.length <= ACTIVITY_LIMITS.pollOptionsMin) return
    const next = options.filter((_, j) => j !== i)
    setOptions(next)
    setMaxChoices((m) => Math.min(m, Math.max(1, next.length)))
    requestAnimationFrame(() => optionRefs.current[Math.min(i, next.length - 1)]?.focus())
  }

  return (
    <Dialog
      title="Start a poll or word cloud"
      description="Everyone on the board answers in a panel. You choose when to show the results, and can put them on the board."
      onClose={onClose}
      testId="la-setup-dialog"
    >
      <form className="dr-form dr-la-form" onSubmit={(e) => void submit(e)} noValidate>
        <fieldset className="dr-la-kinds">
          <legend>Kind</legend>
          {KINDS.map((k) => (
            <label key={k.kind} className="dr-la-kind" data-checked={kind === k.kind || undefined}>
              <input
                type="radio"
                name={`${id}-kind`}
                value={k.kind}
                data-testid={`la-kind-${k.kind}`}
                checked={kind === k.kind}
                onChange={() => {
                  setKind(k.kind)
                  setError(null)
                }}
              />
              <span className="dr-la-kind__name">{kindLabel(k.kind)}</span>
              <span className="dr-la-kind__hint">{k.hint}</span>
            </label>
          ))}
        </fieldset>

        <label htmlFor={`${id}-prompt`}>Question</label>
        <input
          id={`${id}-prompt`}
          className="dr-input dr-input--block"
          data-testid="la-prompt-input"
          maxLength={ACTIVITY_LIMITS.promptMaxChars * 2}
          placeholder={PLACEHOLDER[kind]}
          value={prompt}
          required
          autoComplete="off"
          onChange={(e) => setPrompt(e.target.value)}
        />

        {kind === 'poll' && (
          <fieldset className="dr-la-fieldset" data-testid="la-options">
            <legend>Options</legend>
            <ol className="dr-la-options">
              {options.map((o, i) => (
                <li key={i} className="dr-la-option">
                  <label className="dr-sr-only" htmlFor={`${id}-opt-${i}`}>
                    Option {i + 1}
                  </label>
                  <input
                    id={`${id}-opt-${i}`}
                    ref={(el) => {
                      optionRefs.current[i] = el
                    }}
                    className="dr-input"
                    data-testid={`la-option-${i}`}
                    maxLength={ACTIVITY_LIMITS.optionMaxChars * 2}
                    placeholder={`Option ${i + 1}`}
                    value={o}
                    autoComplete="off"
                    onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
                    onKeyDown={(e) => {
                      // Enter in the last option adds another (a quick way to type a list)
                      if (e.key === 'Enter' && i === options.length - 1 && o.trim()) {
                        e.preventDefault()
                        addOption()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="dr-iconbtn dr-la-option__remove"
                    data-testid={`la-remove-option-${i}`}
                    aria-label={`Remove option ${i + 1}`}
                    title="Remove"
                    disabled={options.length <= ACTIVITY_LIMITS.pollOptionsMin}
                    onClick={() => removeOption(i)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              data-testid="la-add-option"
              disabled={options.length >= ACTIVITY_LIMITS.pollOptionsMax}
              onClick={addOption}
            >
              Add an option
            </button>
            <label className="dr-la-inline" htmlFor={`${id}-choices`}>
              Each person picks
              <select
                id={`${id}-choices`}
                className="dr-input dr-select dr-select--compact"
                data-testid="la-max-choices"
                value={maxChoices}
                onChange={(e) => setMaxChoices(Number(e.target.value))}
              >
                {Array.from({ length: Math.max(1, filledOptions || options.length) }, (_, i) => i + 1).map(
                  (n) => (
                    <option key={n} value={n}>
                      {n === 1 ? 'one option' : `up to ${n}`}
                    </option>
                  ),
                )}
              </select>
            </label>
          </fieldset>
        )}

        {kind === 'scale' && (
          <fieldset className="dr-la-fieldset">
            <legend>Scale</legend>
            <label className="dr-la-inline" htmlFor={`${id}-range`}>
              From
              <select
                id={`${id}-range`}
                className="dr-input dr-select dr-select--compact"
                data-testid="la-scale-range"
                value={range}
                onChange={(e) => setRange(Number(e.target.value))}
              >
                {SCALE_RANGES.map(([a, b], i) => (
                  <option key={`${a}-${b}`} value={i}>
                    {a} to {b}
                  </option>
                ))}
              </select>
            </label>
            <div className="dr-la-labels">
              <label htmlFor={`${id}-min`}>
                Label for {SCALE_RANGES[range]?.[0]} (optional)
                <input
                  id={`${id}-min`}
                  className="dr-input dr-input--block"
                  data-testid="la-min-label"
                  maxLength={ACTIVITY_LIMITS.scaleLabelMaxChars * 2}
                  placeholder="Not at all"
                  value={minLabel}
                  autoComplete="off"
                  onChange={(e) => setMinLabel(e.target.value)}
                />
              </label>
              <label htmlFor={`${id}-max`}>
                Label for {SCALE_RANGES[range]?.[1]} (optional)
                <input
                  id={`${id}-max`}
                  className="dr-input dr-input--block"
                  data-testid="la-max-label"
                  maxLength={ACTIVITY_LIMITS.scaleLabelMaxChars * 2}
                  placeholder="Completely"
                  value={maxLabel}
                  autoComplete="off"
                  onChange={(e) => setMaxLabel(e.target.value)}
                />
              </label>
            </div>
          </fieldset>
        )}

        {kind === 'words' && (
          <label className="dr-la-inline" htmlFor={`${id}-words`}>
            Each person sends
            <select
              id={`${id}-words`}
              className="dr-input dr-select dr-select--compact"
              data-testid="la-max-words"
              value={maxWords}
              onChange={(e) => setMaxWords(Number(e.target.value))}
            >
              {Array.from(
                { length: ACTIVITY_LIMITS.wordsPerPersonMax - ACTIVITY_LIMITS.wordsPerPersonMin + 1 },
                (_, i) => i + ACTIVITY_LIMITS.wordsPerPersonMin,
              ).map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'one word' : `up to ${n} words`}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="dr-la-inline" htmlFor={`${id}-duration`}>
          Time limit
          <select
            id={`${id}-duration`}
            className="dr-input dr-select dr-select--compact"
            data-testid="la-duration"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {DURATION_CHOICES.map((d, i) => (
              <option key={d.label} value={i}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <label className="dr-la-check">
          <input
            type="checkbox"
            data-testid="la-anonymous"
            checked={anonymous}
            aria-describedby={`${id}-anon-hint`}
            onChange={(e) => setAnonymous(e.target.checked)}
          />
          Anonymous
        </label>
        <p id={`${id}-anon-hint`} className="dr-la-hint" data-testid="la-anonymous-hint">
          {anonymous
            ? 'Nobody, you included, ever sees who answered what. Answers are deleted once the results are revealed.'
            : 'Answers show who gave them to you after the reveal. Nobody else sees names.'}
          {kind === 'words' ? ' A rare word can still tell who wrote it.' : ''}
        </p>

        <label className="dr-la-check">
          <input
            type="checkbox"
            data-testid="la-results-live"
            checked={resultsLive}
            aria-describedby={`${id}-live-hint`}
            onChange={(e) => setResultsLive(e.target.checked)}
          />
          {kind === 'words'
            ? 'Show the words to everyone while it runs'
            : 'Show the counts to everyone while it runs'}
        </label>
        <p id={`${id}-live-hint`} className="dr-la-hint">
          {resultsLive
            ? 'Everyone sees the results update every few seconds.'
            : 'Only you see the results until you reveal them.'}
        </p>

        {error && (
          <p className="dr-field-error" role="alert" data-testid="la-setup-error">
            {error}
          </p>
        )}
        <div className="dr-dialog__actions">
          <button type="button" className="dr-btn dr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="dr-btn dr-btn--primary"
            data-testid="la-setup-submit"
            disabled={busy}
          >
            {busy ? 'Starting…' : SUBMIT[kind]}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
