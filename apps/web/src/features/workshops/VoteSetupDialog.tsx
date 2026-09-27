// Vote setup (facilitators): what can be voted on (whole board or one frame, all objects or sticky
// notes only), votes per person (1-99), one vote per object, optional time limit. Anonymous by
// design: people only ever see their own dots until the facilitator reveals the results.

import { VOTES_PER_PERSON_MAX } from '@draftroom/contracts'
import { type FormEvent, useId, useMemo, useState } from 'react'
import type { TLShape } from 'tldraw'
import { Dialog } from '../../ui/Dialog.tsx'
import type { FeatureContext } from '../types.ts'
import type { WorkshopStore } from './store.ts'
import { shapeLabel } from './voting.ts'

const DURATIONS: { label: string; ms: number | null }[] = [
  { label: 'No time limit', ms: null },
  { label: '2 minutes', ms: 2 * 60_000 },
  { label: '5 minutes', ms: 5 * 60_000 },
  { label: '10 minutes', ms: 10 * 60_000 },
  { label: '15 minutes', ms: 15 * 60_000 },
  { label: '30 minutes', ms: 30 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
]

/** The frame the selection is in (or is), to preselect "this frame". */
function selectedFrameId(ctx: FeatureContext, frames: TLShape[]): string | null {
  const ed = ctx.editor
  const ids = new Set(frames.map((f) => f.id))
  for (const s of ed.getSelectedShapes()) {
    if (ids.has(s.id)) return s.id
    const anc = ed.findShapeAncestor(s, (a) => ids.has(a.id))
    if (anc) return anc.id
  }
  return null
}

export function VoteSetupDialog({
  ctx,
  store,
  onClose,
}: {
  ctx: FeatureContext
  store: WorkshopStore
  onClose(): void
}) {
  const frames = useMemo(
    () =>
      ctx.editor
        .getCurrentPageShapesSorted()
        .filter((s) => s.type === 'frame')
        .slice(0, 200),
    [ctx.editor],
  )
  const [title, setTitle] = useState('Dot vote')
  const [votes, setVotes] = useState('3')
  const [onePerObject, setOnePerObject] = useState(false)
  const [scope, setScope] = useState<string>(() => selectedFrameId(ctx, frames) ?? 'board')
  const [types, setTypes] = useState<'all' | 'note'>('all')
  const [duration, setDuration] = useState<string>('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  const votesN = Number(votes)
  const votesOk = Number.isInteger(votesN) && votesN >= 1 && votesN <= VOTES_PER_PERSON_MAX

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!votesOk) return
    setBusy(true)
    setError(null)
    const d = DURATIONS.find((x) => String(x.ms ?? 'none') === duration)
    const r = await store.startVote({
      title: title.trim() || 'Dot vote',
      votesPerPerson: votesN,
      onePerObject,
      scope: scope === 'board' ? 'board' : 'frame',
      frameId: scope === 'board' ? null : scope,
      durationMs: d?.ms ?? null,
      shapeTypes: types === 'note' ? ['note'] : null,
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'The vote could not be started.')
      return
    }
    onClose()
    ctx.openPanel('voting')
  }

  return (
    <Dialog
      title="Start a vote"
      description="Votes are anonymous: everyone sees only their own dots until you reveal the results."
      onClose={onClose}
      testId="vote-setup-dialog"
    >
      <form className="dr-form dr-wk-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor={`${id}-title`}>Title</label>
        <input
          id={`${id}-title`}
          className="dr-input dr-input--block"
          data-testid="vote-title"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label htmlFor={`${id}-votes`}>Votes per person</label>
        <div className="dr-wk-duration">
          <button
            type="button"
            className="dr-iconbtn dr-wk-step"
            aria-label="One vote less"
            onClick={() => setVotes(String(Math.max(1, (votesOk ? votesN : 3) - 1)))}
          >
            −
          </button>
          <input
            id={`${id}-votes`}
            className="dr-input dr-wk-duration__input"
            data-testid="vote-per-person"
            type="number"
            min={1}
            max={VOTES_PER_PERSON_MAX}
            value={votes}
            aria-invalid={!votesOk}
            onChange={(e) => setVotes(e.target.value)}
          />
          <button
            type="button"
            className="dr-iconbtn dr-wk-step"
            aria-label="One vote more"
            onClick={() => setVotes(String(Math.min(VOTES_PER_PERSON_MAX, (votesOk ? votesN : 3) + 1)))}
          >
            +
          </button>
        </div>
        {!votesOk && <p className="dr-field-error">Choose between 1 and {VOTES_PER_PERSON_MAX} votes.</p>}

        <label className="dr-wk-check">
          <input
            type="checkbox"
            data-testid="vote-one-per-object"
            checked={onePerObject}
            onChange={(e) => setOnePerObject(e.target.checked)}
          />
          At most one vote per object
        </label>

        <label htmlFor={`${id}-scope`}>What can be voted on</label>
        <select
          id={`${id}-scope`}
          className="dr-select dr-input--block"
          data-testid="vote-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="board">Everything on the board</option>
          {frames.map((f) => (
            <option key={f.id} value={f.id}>
              Only inside frame “{shapeLabel(f)}”
            </option>
          ))}
        </select>

        <label htmlFor={`${id}-types`}>Objects</label>
        <select
          id={`${id}-types`}
          className="dr-select dr-input--block"
          data-testid="vote-types"
          value={types}
          onChange={(e) => setTypes(e.target.value as 'all' | 'note')}
        >
          <option value="all">All objects (notes, shapes, images, files…)</option>
          <option value="note">Sticky notes only</option>
        </select>

        <label htmlFor={`${id}-duration`}>Time limit</label>
        <select
          id={`${id}-duration`}
          className="dr-select dr-input--block"
          data-testid="vote-duration"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        >
          {DURATIONS.map((d) => (
            <option key={d.label} value={String(d.ms ?? 'none')}>
              {d.label}
            </option>
          ))}
        </select>

        {error && (
          <p className="dr-field-error" role="alert" data-testid="vote-setup-error">
            {error}
          </p>
        )}
        <div className="dr-dialog__actions">
          <button type="button" className="dr-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="dr-btn dr-btn--primary"
            data-testid="vote-setup-submit"
            disabled={busy || !votesOk}
          >
            Start vote
          </button>
        </div>
      </form>
    </Dialog>
  )
}
