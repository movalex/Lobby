// OWNER: WS2 (wave V, V1). The answer sheet: what everyone who sees an active board fills in while an activity is open
// (viewers and name-only guests too; the api decides). A poll's options (one, or up to N), a scale's numbers, a word
// cloud's few words. Native radios, checkboxes and text fields, so the keyboard and screen readers work as they do
// everywhere; on a phone the panel is a full-width sheet and every choice is a big row. The answer can be changed
// until it closes; the api's answer to it is what "Your answer is in" reports.
import { ActivityAnswer, type LiveActivity, normalizeWord, WordText } from '@draftroom/contracts'
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ActivityStore } from './store.ts'
import { anonymityText, pickText, wordsText } from './words.ts'

type Answer = ActivityAnswer

/** The fields' starting values: the caller's own answer, else empty. */
function initialOf(activity: LiveActivity, mine: Answer | null) {
  return {
    choices: mine?.kind === 'poll' ? mine.choices : [],
    value: mine?.kind === 'scale' ? mine.value : null,
    words:
      activity.kind === 'words'
        ? Array.from({ length: activity.config.maxWords }, (_, i) =>
            mine?.kind === 'words' ? (mine.words[i] ?? '') : '',
          )
        : [],
  }
}

/** The answer the fields make, or the reason they make none yet (pure; tested). */
export function answerOf(
  activity: LiveActivity,
  f: { choices: readonly number[]; value: number | null; words: readonly string[] },
): { answer: Answer } | { problem: string } {
  if (activity.kind === 'poll') {
    if (f.choices.length === 0) return { problem: 'Pick an option first.' }
    const p = ActivityAnswer.safeParse({ kind: 'poll', choices: [...f.choices].sort((a, b) => a - b) })
    return p.success ? { answer: p.data } : { problem: p.error.issues[0]?.message ?? 'Pick an option.' }
  }
  if (activity.kind === 'scale') {
    if (f.value === null) return { problem: 'Pick a number first.' }
    return { answer: { kind: 'scale', value: f.value } }
  }
  const typed = f.words.map((w) => w.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (typed.length === 0) return { problem: 'Type a word first.' }
  for (const w of typed) {
    const p = WordText.safeParse(w)
    if (!p.success) return { problem: p.error.issues[0]?.message ?? 'Check your words.' }
  }
  if (new Set(typed.map(normalizeWord)).size !== typed.length) return { problem: 'Each word once.' }
  return { answer: { kind: 'words', words: typed } }
}

const sameAnswer = (a: Answer | null, b: Answer | null) => JSON.stringify(a) === JSON.stringify(b)

export function AnswerForm({
  activity,
  mine,
  store,
  busy,
}: {
  activity: LiveActivity
  mine: Answer | null
  store: ActivityStore
  busy: boolean
}) {
  const id = useId()
  const start = useMemo(() => initialOf(activity, mine), [activity, mine])
  const [choices, setChoices] = useState<readonly number[]>(start.choices)
  const [value, setValue] = useState<number | null>(start.value)
  const [words, setWords] = useState<readonly string[]>(start.words)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const sending = useRef(false)
  // a new activity starts clean (the caller's own answer to it, if any)
  const key = activity.id
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    setChoices(start.choices)
    setValue(start.value)
    setWords(start.words)
    setError(null)
    setSent(false)
  }, [key, start])

  const made = answerOf(activity, { choices, value, words })
  const changed = !('answer' in made) || !sameAnswer(made.answer, mine)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (sending.current || busy) return
    if (!('answer' in made)) {
      setError(made.problem)
      return
    }
    sending.current = true
    setError(null)
    const r = await store.answer(made.answer)
    sending.current = false
    if (!r.ok) {
      setError(r.error ?? 'Your answer did not go through. Try again.')
      setSent(false)
      return
    }
    setSent(true)
  }

  const legendId = `${id}-legend`
  return (
    <form className="dr-la-answer" data-testid="la-answer-form" onSubmit={(e) => void submit(e)} noValidate>
      {activity.kind === 'poll' && (
        <fieldset className="dr-la-choices" aria-describedby={`${id}-how`}>
          <legend id={legendId} className="dr-la-legend">
            Your answer
          </legend>
          <p id={`${id}-how`} className="dr-la-hint">
            {pickText(activity.config.maxChoices)}
          </p>
          {activity.config.options.map((o, i) => {
            const multi = activity.config.maxChoices > 1
            const checked = choices.includes(i)
            const full = multi && !checked && choices.length >= activity.config.maxChoices
            return (
              <label key={i} className="dr-la-choice" data-checked={checked || undefined}>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={`${id}-choice`}
                  data-testid={`la-choice-${i}`}
                  checked={checked}
                  disabled={full}
                  onChange={(e) => {
                    setSent(false)
                    setError(null)
                    if (!multi) setChoices([i])
                    else setChoices(e.target.checked ? [...choices, i] : choices.filter((c) => c !== i))
                  }}
                />
                <span>{o}</span>
              </label>
            )
          })}
        </fieldset>
      )}

      {activity.kind === 'scale' && (
        <fieldset className="dr-la-scale" aria-describedby={`${id}-ends`}>
          <legend id={legendId} className="dr-la-legend">
            Your answer
          </legend>
          <div className="dr-la-scale__row">
            {Array.from(
              { length: activity.config.max - activity.config.min + 1 },
              (_, i) => activity.config.min + i,
            ).map((v) => (
              <label key={v} className="dr-la-scale__value" data-checked={value === v || undefined}>
                <input
                  type="radio"
                  name={`${id}-scale`}
                  data-testid={`la-scale-${v}`}
                  checked={value === v}
                  aria-label={
                    v === activity.config.min && activity.config.minLabel
                      ? `${v}, ${activity.config.minLabel}`
                      : v === activity.config.max && activity.config.maxLabel
                        ? `${v}, ${activity.config.maxLabel}`
                        : String(v)
                  }
                  onChange={() => {
                    setSent(false)
                    setError(null)
                    setValue(v)
                  }}
                />
                <span aria-hidden="true">{v}</span>
              </label>
            ))}
          </div>
          {(activity.config.minLabel || activity.config.maxLabel) && (
            <p id={`${id}-ends`} className="dr-la-scale__ends">
              <span>
                {activity.config.minLabel ? `${activity.config.min}: ${activity.config.minLabel}` : ''}
              </span>
              <span>
                {activity.config.maxLabel ? `${activity.config.max}: ${activity.config.maxLabel}` : ''}
              </span>
            </p>
          )}
        </fieldset>
      )}

      {activity.kind === 'words' && (
        <fieldset className="dr-la-words" aria-describedby={`${id}-how`}>
          <legend id={legendId} className="dr-la-legend">
            Your words
          </legend>
          <p id={`${id}-how`} className="dr-la-hint">
            {wordsText(activity.config.maxWords)}
          </p>
          {words.map((w, i) => (
            <div key={i} className="dr-la-word">
              <label className="dr-sr-only" htmlFor={`${id}-w${i}`}>
                Word {i + 1}
              </label>
              <input
                id={`${id}-w${i}`}
                className="dr-input dr-input--block"
                data-testid={`la-word-${i}`}
                maxLength={60}
                placeholder={activity.config.maxWords === 1 ? 'Your word' : `Word ${i + 1}`}
                value={w}
                autoComplete="off"
                autoCapitalize="none"
                enterKeyHint="send"
                onChange={(e) => {
                  setSent(false)
                  setError(null)
                  setWords(words.map((x, j) => (j === i ? e.target.value : x)))
                }}
              />
            </div>
          ))}
        </fieldset>
      )}

      <p className="dr-la-hint" data-testid="la-anonymity">
        {anonymityText(activity.anonymous)}
      </p>
      {error && (
        <p className="dr-field-error" role="alert" data-testid="la-answer-error">
          {error}
        </p>
      )}
      <div className="dr-la-row">
        <button
          type="submit"
          className="dr-btn dr-btn--primary dr-la-send"
          data-testid="la-answer-send"
          disabled={busy || (!!mine && !changed)}
        >
          {busy ? 'Sending…' : mine ? 'Change my answer' : 'Send answer'}
        </button>
      </div>
      <p className="dr-la-sent" role="status" data-testid="la-answer-status" data-sent={!!mine || undefined}>
        {mine
          ? sent
            ? 'Your answer is in. You can change it until answers close.'
            : 'You answered. You can change it until answers close.'
          : ''}
      </p>
    </form>
  )
}
