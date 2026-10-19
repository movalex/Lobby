// OWNER: WS2 (wave V, V1). The results in the panel: a poll's options with their counts and shares, a scale's values
// with the average and median, a word cloud's top words. Aggregates only (the api sends nothing else). A list a
// screen reader reads row by row; the bars are decoration (aria-hidden). While an activity runs the counts are the
// api's tally window's (every few seconds), and the panel says so.
import type { ActivityResults, LiveActivity } from '@draftroom/contracts'
import type { CSSProperties } from 'react'
import { oneDecimal, shareText } from './board-plan.ts'
import { answersText } from './words.ts'

/** The most words the panel lists (the rest are counted). */
export const PANEL_WORDS_MAX = 30

const barStyle = (count: number, max: number): CSSProperties => ({
  width: `${max > 0 ? Math.max(count > 0 ? 3 : 0, Math.round((count / max) * 100)) : 0}%`,
})

export function ResultsView({
  activity,
  results,
  live,
  hide,
}: {
  activity: LiveActivity
  results: ActivityResults
  /** the counts of a running activity (they move every few seconds) */
  live: boolean
  /** a manager's "Hide" for a word (word clouds, before the reveal); absent: no moderation */
  hide?: (word: string) => void
}) {
  const caption = live ? 'Live: the counts update every few seconds.' : null
  return (
    <section className="dr-la-results" aria-label="Results" data-testid="la-results" data-kind={results.kind}>
      <p className="dr-la-results__head">
        <strong data-testid="la-results-answered">{answersText(results.answered)}</strong>
        {caption && <span className="dr-muted"> · {caption}</span>}
      </p>
      {activity.kind === 'poll' && results.kind === 'poll' && (
        <PollRows options={activity.config.options} counts={results.counts} answered={results.answered} />
      )}
      {activity.kind === 'scale' && results.kind === 'scale' && (
        <ScaleRows min={activity.config.min} max={activity.config.max} results={results} />
      )}
      {results.kind === 'words' && <WordRows results={results} hide={hide} />}
    </section>
  )
}

function PollRows({
  options,
  counts,
  answered,
}: {
  options: readonly string[]
  counts: readonly number[]
  answered: number
}) {
  const max = Math.max(0, ...counts)
  return (
    <ol className="dr-la-bars" data-testid="la-poll-results">
      {options.map((o, i) => {
        const c = counts[i] ?? 0
        return (
          <li key={i} className="dr-la-bar" data-top={(c > 0 && c === max) || undefined} data-count={c}>
            <span className="dr-la-bar__label">{o}</span>
            <span className="dr-la-bar__count">
              {c} <span className="dr-muted">· {shareText(c, answered)}</span>
            </span>
            <span className="dr-la-bar__track" aria-hidden="true">
              <span className="dr-la-bar__fill" style={barStyle(c, max)} />
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function ScaleRows({
  min,
  max,
  results,
}: {
  min: number
  max: number
  results: Extract<ActivityResults, { kind: 'scale' }>
}) {
  const top = Math.max(0, ...results.counts)
  return (
    <>
      <p className="dr-la-summary" data-testid="la-scale-summary">
        {results.mean === null || results.median === null
          ? 'No answers yet.'
          : `Average ${oneDecimal(results.mean)} · median ${oneDecimal(results.median)}`}
      </p>
      <ol className="dr-la-bars" data-testid="la-scale-results">
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((v, i) => {
          const c = results.counts[i] ?? 0
          return (
            <li key={v} className="dr-la-bar" data-top={(c > 0 && c === top) || undefined} data-count={c}>
              <span className="dr-la-bar__label">{v}</span>
              <span className="dr-la-bar__count">{c}</span>
              <span className="dr-la-bar__track" aria-hidden="true">
                <span className="dr-la-bar__fill" style={barStyle(c, top)} />
              </span>
            </li>
          )
        })}
      </ol>
    </>
  )
}

function WordRows({
  results,
  hide,
}: {
  results: Extract<ActivityResults, { kind: 'words' }>
  hide?: (word: string) => void
}) {
  if (results.words.length === 0)
    return (
      <p className="dr-muted" data-testid="la-words-empty">
        No words yet.
      </p>
    )
  const shown = results.words.slice(0, PANEL_WORDS_MAX)
  const more = results.distinct - shown.length
  const max = shown[0]?.count ?? 1
  return (
    <>
      <ol className="dr-la-words-list" data-testid="la-words-results">
        {shown.map((w) => (
          <li key={w.text} className="dr-la-wordrow" data-count={w.count}>
            <span className="dr-la-wordrow__text" style={{ fontSize: `${0.9 + 0.5 * (w.count / max)}em` }}>
              {w.text}
            </span>
            <span className="dr-la-wordrow__count">{w.count}</span>
            {hide && (
              <button
                type="button"
                className="dr-linkbtn dr-la-wordrow__hide"
                data-testid="la-hide-word"
                aria-label={`Hide the word ${w.text}`}
                onClick={() => hide(w.text)}
              >
                Hide
              </button>
            )}
          </li>
        ))}
      </ol>
      {more > 0 && (
        <p className="dr-muted">
          and {more} more word{more === 1 ? '' : 's'}
        </p>
      )}
    </>
  )
}
