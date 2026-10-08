// OWNER: 3f. Dock panel "Voting" on the Excalidraw page (the tldraw board's VotingPanel.tsx): the current
// vote (my dots, facilitator progress and controls), the revealed ranking (top 3, then everything; CSV
// export; badges on the board), and past votes.
import {
  EXPORT_DISABLED_MESSAGE,
  type VoteResult,
  type VoteSessionSummary,
  type WorkshopVoteState,
} from '@draftroom/contracts'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { formatDateTime } from '../../../lib/format.ts'
import { useValue } from '../../../lib/signals.ts'
import { describeClock, formatClock } from '../countdown.ts'
import type { WorkshopStore } from '../store.ts'
import { describeProgress, describeVoted, resultsCsv, topResults, votedOf } from '../voting.ts'
import { useIsFacilitator, useNow, useWorkshop } from '../workshop-context.ts'
import { zoomToBounds } from './camera.ts'
import { elementIdOf, labelOfRef, typeNameOfRef } from './elements.ts'
import { useExportAllowed } from './export-gate.ts'
import { selectionText } from './voting-canvas.ts'

type Ctx = CanvasFeatureContext

const get = (canvas: LobbyCanvas) => (id: string) => canvas.get(id)

function describeRef(canvas: LobbyCanvas, ref: string) {
  return { type: typeNameOfRef(ref, get(canvas)), label: labelOfRef(ref, get(canvas)) }
}

/** Selects the object and brings it into view, at 100% at most (tldraw's select + zoomToBounds targetZoom 1). */
function zoomTo(canvas: LobbyCanvas, ref: string) {
  const id = elementIdOf(ref)
  const el = id ? canvas.get(id) : undefined
  if (!id || !el || (el as { isDeleted?: boolean }).isDeleted) return
  canvas.select([id])
  const b = canvas.bounds(id)
  if (b) zoomToBounds(canvas, b, { maxZoom: 1 })
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Keeps characters every OS accepts in a file name (no control characters, no path separators). */
const safeFileName = (s: string) =>
  [...s]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'vote'

function scopeText(v: WorkshopVoteState, canvas: LobbyCanvas): string {
  const parts = [`${v.session.votesPerPerson} vote${v.session.votesPerPerson === 1 ? '' : 's'} each`]
  if (v.session.onePerObject) parts.push('one per object')
  if (v.session.shapeTypes?.length === 1 && v.session.shapeTypes[0] === 'note')
    parts.push('sticky notes only')
  if (v.session.scope === 'frame' && v.session.frameId)
    parts.push(`in frame “${labelOfRef(v.session.frameId, get(canvas))}”`)
  if (v.session.scope === 'selection') parts.push(selectionText(v.session.selection ?? [], canvas))
  return parts.join(' · ')
}

export function VotingPanel({ ctx }: { ctx: Ctx; close(): void }) {
  const { store, snap } = useWorkshop(ctx)
  const facilitator = useIsFacilitator(ctx)
  const vote = snap.vote
  const [past, setPast] = useState<VoteSessionSummary[] | null>(null)
  const [viewing, setViewing] = useState<{ session: VoteSessionSummary; results: VoteResult[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadPast = useCallback(() => {
    store.listVotes().then(setPast, () => setPast([]))
  }, [store])
  const status = vote?.session.status
  const sid = vote?.session.id
  // Refetch the history whenever the current vote changes (a new one, or one that just ended).
  useEffect(() => {
    void sid
    void status
    loadPast()
  }, [loadPast, sid, status])

  const run = async (p: Promise<{ ok: boolean; error?: string }>) => {
    setError(null)
    const r = await p
    if (!r.ok) setError(r.error ?? 'That did not work.')
  }

  return (
    <div className="dr-wk-panel" data-testid="voting-panel">
      {!vote && (
        <div className="dr-wk-empty">
          <p>No votes on this board yet.</p>
          {facilitator ? (
            <button
              type="button"
              className="dr-btn dr-btn--primary dr-btn--sm"
              data-testid="vote-start-panel"
              onClick={() => store.setSetupOpen(true)}
            >
              Start a vote…
            </button>
          ) : (
            <p className="dr-muted">An editor or owner can start one.</p>
          )}
        </div>
      )}
      {vote && <CurrentVote ctx={ctx} store={store} vote={vote} facilitator={facilitator} run={run} />}
      {error && (
        <p className="dr-field-error" role="alert" data-testid="vote-error">
          {error}
        </p>
      )}
      {viewing && (
        <section className="dr-wk-section" aria-label={`Results: ${viewing.session.title}`}>
          <div className="dr-wk-section__head">
            <h3>{viewing.session.title}</h3>
            <button type="button" className="dr-linkbtn" onClick={() => setViewing(null)}>
              Close
            </button>
          </div>
          <Results
            ctx={ctx}
            title={viewing.session.title}
            results={viewing.results}
            totalVotes={viewing.session.totalVotesCast}
            participants={viewing.session.participants}
            testId="vote-history-results"
          />
        </section>
      )}
      {past && past.filter((p) => p.id !== vote?.session.id).length > 0 && (
        <details className="dr-wk-history" data-testid="vote-history">
          <summary>Past votes</summary>
          <ul>
            {past
              .filter((p) => p.id !== vote?.session.id)
              .map((p) => (
                <li key={p.id} data-testid="vote-history-row" data-session-id={p.id}>
                  <span className="dr-wk-history__title">{p.title}</span>
                  <span className="dr-muted">
                    {/* R2-08: no seconds, the same hour cycle as every other time */}
                    {formatDateTime(p.createdAt)} · {p.totalVotesCast} votes
                  </span>
                  {p.status === 'revealed' ? (
                    <button
                      type="button"
                      className="dr-linkbtn"
                      onClick={() =>
                        void store.results(p.id).then(
                          (r) => setViewing(r),
                          () => setError('Those results could not be loaded.'),
                        )
                      }
                    >
                      View results
                    </button>
                  ) : (
                    <span className="dr-muted">Not revealed</span>
                  )}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function CurrentVote({
  ctx,
  store,
  vote,
  facilitator,
  run,
}: {
  ctx: Ctx
  store: WorkshopStore
  vote: WorkshopVoteState
  facilitator: boolean
  run(p: Promise<{ ok: boolean; error?: string }>): Promise<void>
}) {
  const snap = store.getSnapshot()
  const s = vote.session
  const timed = !!s.endsAt && s.status === 'open'
  const now = useNow(timed, 500)
  const left = s.endsAt ? Math.max(0, Date.parse(s.endsAt) - (now + store.serverOffsetMs())) : 0
  // A timed vote that runs out here: fetch the server's view (which reports it as closed).
  useEffect(() => {
    if (timed && left <= 0) void store.refresh()
  }, [timed, left, store])
  const ballot = snap.ballot ?? { myVotes: vote.myVotes, myRemaining: vote.myRemaining }
  const mine = Object.entries(ballot.myVotes)
  const joined = snap.participation === 'joined'
  const canvas = ctx.canvas
  const voted = useVoted(ctx, vote, mine.length > 0)

  return (
    <section
      className="dr-wk-section"
      aria-label="Current vote"
      data-testid="vote-current"
      data-status={s.status}
    >
      <div className="dr-wk-section__head">
        <h3>{s.title}</h3>
        <span className={`dr-wk-status dr-wk-status--${s.status}`}>
          {s.status === 'open' ? 'Open' : s.status === 'closed' ? 'Ended' : 'Results'}
        </span>
      </div>
      <p className="dr-muted dr-wk-meta">
        Anonymous · {scopeText(vote, canvas)}
        {timed && (
          <>
            {' '}
            · <span aria-hidden="true">{formatClock(left)} left</span>
            <span className="dr-sr-only">{describeClock(left)} left</span>
          </>
        )}
      </p>

      {s.status === 'open' &&
        (!joined ? (
          <button
            type="button"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="vote-join-panel"
            onClick={() => void store.joinVote(s.id)}
          >
            Join the vote
          </button>
        ) : (
          <>
            <p className="dr-wk-lead">
              Click objects on the board to add a vote; click one of your dots to take it back.{' '}
              <strong>
                {ballot.myRemaining} of {s.votesPerPerson} left
              </strong>
              .
            </p>
            {mine.length > 0 && (
              <ul className="dr-wk-mine" aria-label="Your votes">
                {mine.map(([shapeId, n]) => {
                  const label = labelOfRef(shapeId, get(canvas))
                  return (
                    <li key={shapeId} data-testid="vote-mine-row" data-shape-id={shapeId}>
                      <button
                        type="button"
                        className="dr-linkbtn dr-wk-mine__label"
                        onClick={() => zoomTo(canvas, shapeId)}
                      >
                        {label}
                      </button>
                      <span className="dr-wk-mine__count">
                        {n} <span className="dr-sr-only">vote{n === 1 ? '' : 's'}</span>
                      </span>
                      <button
                        type="button"
                        className="dr-iconbtn dr-wk-step"
                        aria-label={`Remove one vote from ${label}`}
                        onClick={() => void run(store.cast(shapeId, -1))}
                      >
                        −
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        ))}

      {facilitator && s.status !== 'revealed' && (
        <div className="dr-wk-facil" data-testid="vote-facilitator">
          {/* K3-2: how many of the people here have voted, then the clear end below */}
          <p className="dr-wk-voted" data-testid="vote-voted" data-voted={voted.voted} data-of={voted.of}>
            {describeVoted(voted)}
          </p>
          <p data-testid="vote-progress">{describeProgress(vote)}</p>
          {timed && (
            <div className="dr-wk-row">
              <button
                type="button"
                className="dr-btn dr-btn--sm"
                data-testid="vote-extend-1m"
                onClick={() => void run(store.extendVote(60_000))}
              >
                +1 min
              </button>
              <button
                type="button"
                className="dr-btn dr-btn--sm"
                data-testid="vote-extend-5m"
                onClick={() => void run(store.extendVote(5 * 60_000))}
              >
                +5 min
              </button>
            </div>
          )}
          <div className="dr-wk-row">
            <button
              type="button"
              className="dr-btn dr-btn--primary dr-btn--sm"
              data-testid="vote-reveal"
              onClick={() => void run(store.revealVote())}
            >
              {s.status === 'open' ? 'End and show results' : 'Show results'}
            </button>
            {s.status === 'open' && (
              <button
                type="button"
                className="dr-btn dr-btn--sm dr-btn--ghost"
                data-testid="vote-close"
                onClick={() => void run(store.closeVote())}
              >
                End without results
              </button>
            )}
          </div>
        </div>
      )}
      {s.status === 'closed' && !facilitator && (
        <p className="dr-muted">Voting has ended. The results stay hidden until a facilitator shows them.</p>
      )}
      {/* K3-2: the end is plain to see: the vote is over, and how it went */}
      {s.status === 'revealed' && (
        <p className="dr-wk-final" role="status" data-testid="vote-final">
          Voting is over: {vote.totalVotesCast} vote{vote.totalVotesCast === 1 ? '' : 's'} from{' '}
          {vote.participants} {vote.participants === 1 ? 'person' : 'people'}. Everyone sees the results.
        </p>
      )}
      {s.status === 'revealed' && vote.results && (
        <>
          <label className="dr-wk-check">
            <input
              type="checkbox"
              data-testid="vote-results-on-board"
              checked={snap.showResults}
              onChange={(e) => store.setShowResults(s.id, e.target.checked)}
            />
            Show vote counts on the board
          </label>
          <Results
            ctx={ctx}
            title={s.title}
            results={vote.results}
            totalVotes={vote.totalVotesCast}
            participants={vote.participants}
            testId="vote-results"
          />
        </>
      )}
      {/* Once a vote has ended (with or without results), the facilitator can start the next one here. */}
      {facilitator && s.status !== 'open' && (
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="vote-start-panel"
          onClick={() => store.setSetupOpen(true)}
        >
          Start a new vote…
        </button>
      )}
    </section>
  )
}

/**
 * K3-2: "x of y voted" for this vote (../voting.ts votedOf): the api's count of people who voted, and who
 * else is on the board now (the roster: each person once, however many tabs they have).
 */
export function useVoted(
  ctx: Ctx,
  vote: Pick<WorkshopVoteState, 'participants' | 'done'>,
  castSome: boolean,
): { voted: number; of: number } {
  const me = ctx.me.user.id
  const othersHere = useValue(
    'dr-wk-others-here',
    () =>
      new Set(ctx.canvas.collaborators().map((c) => c.uid)).size -
      (ctx.canvas.collaborators().some((c) => c.uid === me) ? 1 : 0),
    [ctx.canvas, me],
  )
  return votedOf({ participants: vote.participants, othersHere, meIn: castSome || vote.done })
}

const MEDALS = ['1st', '2nd', '3rd']

function Results({
  ctx,
  title,
  results,
  totalVotes,
  participants,
  testId,
}: {
  ctx: Ctx
  title: string
  results: VoteResult[]
  totalVotes: number
  participants: number
  testId: string
}) {
  const [all, setAll] = useState(false)
  const top = useMemo(() => topResults(results, 3), [results])
  const shown = all ? results : top
  // export-control: a UI gate only (./export-gate.ts).
  const canExport = useExportAllowed(ctx)
  const csvOffId = useId()
  const canvas = ctx.canvas
  if (results.length === 0)
    return (
      <p className="dr-muted" data-testid={testId}>
        Nobody voted.
      </p>
    )
  return (
    <div className="dr-wk-results" data-testid={testId}>
      <p className="dr-muted">
        {totalVotes} vote{totalVotes === 1 ? '' : 's'} from {participants}{' '}
        {participants === 1 ? 'person' : 'people'}
      </p>
      <ol className="dr-wk-rank">
        {shown.map((r) => {
          const d = describeRef(canvas, r.shapeId)
          return (
            <li key={r.shapeId} data-testid="vote-result-row" data-shape-id={r.shapeId} data-rank={r.rank}>
              <span className={`dr-wk-rank__place${r.rank <= 3 ? ' dr-wk-rank__place--top' : ''}`}>
                {MEDALS[r.rank - 1] ?? `${r.rank}th`}
              </span>
              <button
                type="button"
                className="dr-linkbtn dr-wk-rank__label"
                onClick={() => zoomTo(canvas, r.shapeId)}
              >
                {d.label}
              </button>
              <span className="dr-wk-rank__count">
                {r.count} <span className="dr-sr-only">votes</span>
              </span>
            </li>
          )
        })}
      </ol>
      <div className="dr-wk-row">
        {results.length > top.length && (
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="vote-results-all"
            aria-expanded={all}
            onClick={() => setAll((a) => !a)}
          >
            {all ? 'Show top 3' : `See all ${results.length} results`}
          </button>
        )}
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="vote-results-csv"
          disabled={!canExport}
          aria-describedby={canExport ? undefined : csvOffId}
          onClick={() => {
            if (!canExport) return
            download(
              `${safeFileName(`${ctx.board.title} - ${title}`)}.csv`,
              resultsCsv(results, (id) => describeRef(canvas, id)),
            )
          }}
        >
          Export CSV
        </button>
      </div>
      {!canExport && (
        <p className="dr-wk-export-off" id={csvOffId} data-testid="vote-results-csv-off">
          {EXPORT_DISABLED_MESSAGE}
        </p>
      )}
    </div>
  )
}
