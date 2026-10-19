// OWNER: WS2 (wave V, V1; docs/WAVE-V-CONTRACTS.md §2). The dock panel "Poll or word cloud": the board's current
// activity for everyone (its question, how many answered, time left), the answer sheet while it is open, the results
// once a manager reveals them (or live, when the facilitator chose so), and for whoever manages it (the api says:
// `canManage`) the controls: close, reveal, a minute more, cancel, hide a word, Results to board, and a named
// activity's answers after the reveal. On a phone the dock opens it as a full-width sheet over the board.
import type { NamedAnswersResponse } from '@draftroom/contracts'
import { useEffect, useId, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { useNow } from '../workshops/workshop-context.ts'
import { AnswerForm } from './AnswerForm.tsx'
import { mayFacilitate, mayParticipate, useActivity } from './hooks.ts'
import { ResultsView } from './Results.tsx'
import { remainingMs } from './store.ts'
import { type PlaceAs, resultsToBoard } from './to-board.ts'
import {
  anonymityText,
  answersText,
  clockText,
  EXTEND_MS,
  kindLabel,
  spokenClock,
  statusText,
} from './words.ts'
import './live-activities.css'

type Ctx = CanvasFeatureContext

export function ActivityIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="4" y="13" width="4" height="7" rx="1" fill="currentColor" opacity="0.6" />
      <rect x="10" y="8" width="4" height="12" rx="1" fill="currentColor" />
      <rect x="16" y="4" width="4" height="16" rx="1" fill="currentColor" opacity="0.8" />
    </svg>
  )
}

const narrowScreen = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 599px)').matches

export function ActivityPanel({ ctx, close }: { ctx: Ctx; close(): void }) {
  const { store, snap } = useActivity(ctx)
  const facilitator = mayFacilitate(ctx)
  const readOnly = useValue('lobby-la-readonly', () => ctx.canvas.readOnly(), [ctx.canvas])
  const a = snap.activity
  const running = snap.status === 'open'
  const now = useNow(running && !!a?.endsAt, 500)
  const left = running ? remainingMs(a, now, snap.offsetMs) : null
  const [error, setError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const headId = useId()
  // a new activity (or a new status) clears what the last one said
  const key = `${a?.id ?? ''}|${snap.status ?? ''}`
  useEffect(() => {
    void key
    setError(null)
    setConfirmCancel(false)
  }, [key])

  const run = async (p: Promise<{ ok: boolean; error?: string }>) => {
    setError(null)
    const r = await p
    if (!r.ok) setError(r.error ?? 'That did not work. Try again.')
  }

  const place = (as: PlaceAs) => {
    setError(null)
    const out = resultsToBoard(ctx.canvas, { activity: a, results: snap.results }, { as })
    if (!out) {
      setError('There is nothing to put on the board yet.')
      return
    }
    void store.placed()
    ctx.notify({
      key: 'live-activities',
      text:
        out.left > 0
          ? `The results are on the board. ${out.left} less common word${out.left === 1 ? ' was' : 's were'} left off.`
          : 'The results are on the board.',
      testId: 'la-toast',
    })
    // on a phone the sheet covers the board: show what was made
    if (narrowScreen()) close()
  }

  if (!snap.loaded && !a)
    return (
      <div className="dr-wk-panel dr-la-panel" data-testid="la-panel" data-status="loading">
        <p className="dr-muted">Loading…</p>
      </div>
    )

  if (snap.absent)
    return (
      <div className="dr-wk-panel dr-la-panel" data-testid="la-panel" data-status="off">
        <p className="dr-muted">Polls and word clouds are not available on this board right now.</p>
      </div>
    )

  const startButton = (label: string) =>
    facilitator && !readOnly && ctx.board.status === 'active' ? (
      <button
        type="button"
        className="dr-btn dr-btn--primary dr-btn--sm"
        data-testid="la-start"
        onClick={() => store.setSetupOpen(true)}
      >
        {label}
      </button>
    ) : null

  if (!a)
    return (
      <div className="dr-wk-panel dr-la-panel" data-testid="la-panel" data-status="none">
        <div className="dr-wk-empty">
          <p>Ask the room a quick question: a poll, a scale from 1 to 10, or a word cloud.</p>
          {startButton('Start a poll or word cloud') ?? (
            <p className="dr-muted">There is no poll right now. An editor with an account can start one.</p>
          )}
        </div>
      </div>
    )

  const manage = snap.canManage && !readOnly
  const revealed = snap.status === 'revealed'
  const showResults = !!snap.results && (revealed || manage || a.resultsLive)
  const hideWord =
    manage && a.kind === 'words' && !revealed ? (word: string) => void run(store.hide(word, true)) : undefined
  const busy = snap.busy !== null

  return (
    <div
      className="dr-wk-panel dr-la-panel"
      data-testid="la-panel"
      data-status={snap.status ?? ''}
      data-kind={a.kind}
      data-activity-id={a.id}
    >
      <section className="dr-la-current" aria-labelledby={headId}>
        <p className="dr-la-meta">
          <span className="dr-la-badge" data-testid="la-kind">
            {kindLabel(a.kind)}
          </span>
          <span data-testid="la-status">{statusText(snap.status)}</span>
          {left !== null && (
            <span className="dr-la-clock" data-testid="la-time-left">
              <span aria-hidden="true">{clockText(left)} left</span>
              <span className="dr-sr-only">{spokenClock(left)} left</span>
            </span>
          )}
          <span data-testid="la-answered" data-count={snap.answered}>
            {answersText(snap.answered)}
          </span>
        </p>
        <h3 id={headId} className="dr-la-prompt" data-testid="la-prompt">
          {a.prompt}
        </h3>

        {running && mayParticipate(ctx) && (
          <AnswerForm activity={a} mine={snap.myAnswer} store={store} busy={snap.busy === 'answer'} />
        )}
        {running && !mayParticipate(ctx) && (
          <p className="dr-muted">This board is archived: answers are closed.</p>
        )}
        {snap.status === 'closed' && (
          <p className="dr-la-note" data-testid="la-closed-note">
            {manage
              ? 'Answers are closed. Reveal the results when you are ready.'
              : 'Answers are closed. The results show here once they are revealed.'}
          </p>
        )}
        {!running && !revealed && snap.myAnswer && (
          <p className="dr-muted" data-testid="la-my-answer-kept">
            Your answer is in.
          </p>
        )}
        {!running && revealed && !manage && <p className="dr-muted">{anonymityText(a.anonymous)}</p>}

        {showResults && snap.results && (
          <ResultsView activity={a} results={snap.results} live={!revealed} hide={hideWord} />
        )}
        {!showResults && running && !manage && (
          <p className="dr-muted" data-testid="la-results-later">
            The results show here once they are revealed.
          </p>
        )}

        {manage && a.kind === 'words' && snap.hiddenWords.length > 0 && (
          <div className="dr-la-hidden" data-testid="la-hidden-words">
            <p className="dr-la-hidden__title">Hidden words (left out of the results and the board)</p>
            <ul>
              {snap.hiddenWords.map((w) => (
                <li key={w}>
                  <span>{w}</span>{' '}
                  {!revealed && (
                    <button
                      type="button"
                      className="dr-linkbtn"
                      data-testid="la-unhide-word"
                      aria-label={`Show the word ${w} again`}
                      onClick={() => void run(store.hide(w, false))}
                    >
                      Show again
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="dr-field-error" role="alert" data-testid="la-error">
            {error}
          </p>
        )}

        {manage && (running || snap.status === 'closed') && (
          <div className="dr-wk-facil dr-la-controls" data-testid="la-controls">
            {snap.starterLeft && (
              <p className="dr-muted">Its starter can no longer edit this board, so you can run it.</p>
            )}
            <div className="dr-wk-row">
              <button
                type="button"
                className="dr-btn dr-btn--primary dr-btn--sm"
                data-testid="la-reveal"
                disabled={busy}
                onClick={() => void run(store.reveal())}
              >
                Reveal results
              </button>
              {running && (
                <button
                  type="button"
                  className="dr-btn dr-btn--sm"
                  data-testid="la-close"
                  disabled={busy}
                  onClick={() => void run(store.close())}
                >
                  Close answers
                </button>
              )}
              {running && a.endsAt && (
                <button
                  type="button"
                  className="dr-btn dr-btn--sm"
                  data-testid="la-extend"
                  disabled={busy}
                  onClick={() => void run(store.extend(EXTEND_MS))}
                >
                  1 more minute
                </button>
              )}
            </div>
            <div className="dr-wk-row">
              {!confirmCancel ? (
                <button
                  type="button"
                  className="dr-btn dr-btn--sm dr-btn--ghost"
                  data-testid="la-cancel"
                  disabled={busy}
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel without results
                </button>
              ) : (
                <>
                  <span className="dr-la-confirm" role="status">
                    Cancel it? Its answers are discarded.
                  </span>
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm dr-btn--danger"
                    data-testid="la-cancel-confirm"
                    disabled={busy}
                    onClick={() => void run(store.cancel())}
                  >
                    Yes, cancel
                  </button>
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm dr-btn--ghost"
                    onClick={() => setConfirmCancel(false)}
                  >
                    Keep it
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {manage && revealed && snap.results && (
          <div className="dr-wk-after dr-la-after" data-testid="la-after">
            <p className="dr-wk-after__title">Use the results</p>
            <div className="dr-wk-row">
              <button
                type="button"
                className="dr-btn dr-btn--sm dr-btn--primary"
                data-testid="la-to-board"
                onClick={() => place('chart')}
              >
                {a.kind === 'words' ? 'Word cloud to board' : 'Results to board'}
              </button>
              {a.kind === 'words' && (
                <button
                  type="button"
                  className="dr-btn dr-btn--sm"
                  data-testid="la-to-board-notes"
                  onClick={() => place('notes')}
                >
                  As sticky notes
                </button>
              )}
            </div>
            {a.placedAt && (
              <p className="dr-muted" data-testid="la-placed">
                These results are on the board. You can place them again.
              </p>
            )}
            {!a.anonymous && <NamedAnswers store={store} activityId={a.id} options={optionsOf(a)} />}
          </div>
        )}
      </section>

      {(revealed || snap.status === 'cancelled') && startButton('Start another')}
    </div>
  )
}

const optionsOf = (a: { kind: string; config: unknown }): readonly string[] =>
  a.kind === 'poll' ? ((a.config as { options: string[] }).options ?? []) : []

/** A named activity's "who answered what" (managers, after the reveal), read when opened. */
function NamedAnswers({
  store,
  activityId,
  options,
}: {
  store: ReturnType<typeof useActivity>['store']
  activityId: string
  options: readonly string[]
}) {
  const [list, setList] = useState<NamedAnswersResponse['answers'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void activityId
    setList(null)
    setError(null)
  }, [activityId])
  useEffect(() => {
    if (!open || list) return
    let live = true
    void store.namedAnswers().then((r) => {
      if (!live) return
      if ('answers' in r) setList(r.answers)
      else setError(r.error ?? 'The answers could not be loaded.')
    })
    return () => {
      live = false
    }
  }, [open, list, store])
  const text = (ans: NamedAnswersResponse['answers'][number]['answer']) =>
    ans.kind === 'poll'
      ? ans.choices.map((c) => options[c] ?? `Option ${c + 1}`).join(', ')
      : ans.kind === 'scale'
        ? String(ans.value)
        : ans.words.join(', ')
  return (
    <details
      className="dr-la-named"
      data-testid="la-named"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Who answered what</summary>
      {error && <p className="dr-field-error">{error}</p>}
      {!list && !error && open && <p className="dr-muted">Loading…</p>}
      {list && list.length === 0 && <p className="dr-muted">Nobody answered.</p>}
      {list && list.length > 0 && (
        <ul data-testid="la-named-list">
          {list.map((r) => (
            <li key={r.userId}>
              <strong>{r.name}</strong>: {text(r.answer)}
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
