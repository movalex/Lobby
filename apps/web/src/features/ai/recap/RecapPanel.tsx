// OWNER: W2 (wave L, L2-3). The private recap panel (a screen layer of the AI feature, shown to everyone who opens
// a recap, AI or not): the headline, decisions, actions with owners and open questions with their sources (a
// chip only moves this tab's camera), the top voted items, planned vs actual, and the actions: "Add as Recap
// frame" (editors, one undo step), "Copy as Markdown" (lib/clipboard.ts, bounded; only while this person may copy
// here: the board's export policy covers copying, canvas-ux export-gate.ts) and "Export recap as PDF" (the
// export dialog for the recap frame, W5's 'present-export.export'; only while this person may export).

import { useEffect, useId, useRef, useState } from 'react'
import {
  type CanvasFeatureContext,
  commandRunnable,
  useCanvasFeatureContext,
} from '../../../canvas/api/index.ts'
import { copyText } from '../../../lib/clipboard.ts'
import { useValue } from '../../../lib/signals.ts'
import { runCommand } from '../../canvas-ux/ported/commands.ts'
import { exportAllowed } from '../../canvas-ux/ported/export-gate.ts'
import { exportAllowedOn } from '../../sharing/ported/export-policy.ts'
import { plural } from '../copy.ts'
import { SparkIcon } from '../icons.tsx'
import { offerUndoFor } from '../ported/actions.ts'
import { showSources } from '../ported/ask.ts'
import { revealResult } from '../reveal.ts'
import { applyRecap, latestRecapFrame } from './apply.ts'
import { recapMarkdown } from './markdown.ts'
import { type RecapPlan, recapIsEmpty } from './plan.ts'
import { aiRecap, type RecapState } from './recap.ts'

/** W5's export command (features/workshops/commands.ts WORKSHOP_COMMAND_IDS.presentExport), run with frameIds. */
const EXPORT_COMMAND = 'present-export.export'

/** The recap layer: the panel while a recap is open in this tab. */
export function AiRecapOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const state = useValue('lobby-ai-recap-state', () => aiRecap(ctx.canvas).get(), [ctx.canvas])
  if (!state) return null
  return (
    <div className="dr-ai-recap-layer">
      <RecapView state={state} />
    </div>
  )
}

function Chip({ refs, n }: { refs: readonly string[]; n: number }) {
  const { canvas } = useCanvasFeatureContext()
  if (!refs.length) return null
  return (
    <button
      type="button"
      className="dr-ai-cite"
      data-testid="recap-cite"
      aria-label={`Source ${n}: show it on the board`}
      onClick={() => showSources(canvas, refs)}
    >
      {n}
    </button>
  )
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="dr-ai-recap__section" data-testid={testId}>
      <h3 className="dr-ai-recap__h">{title}</h3>
      {children}
    </section>
  )
}

function Body({ plan }: { plan: RecapPlan }) {
  let n = 0
  const cite = (refs: readonly string[]) => (refs.length ? <Chip refs={refs} n={++n} /> : null)
  return (
    <>
      {plan.headline && (
        <p className="dr-ai-panel__text" data-testid="recap-headline">
          {plan.headline}
        </p>
      )}
      {plan.decisions.length > 0 && (
        <Section title="Decisions" testId="recap-decisions">
          <ul>
            {plan.decisions.map((d, i) => (
              <li key={i}>
                {d.text} {cite(d.refs)}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {plan.actions.length > 0 && (
        <Section title="Action items" testId="recap-actions">
          <ul>
            {plan.actions.map((a, i) => (
              <li key={i}>
                {a.task}
                {a.owner && <span className="dr-ai-recap__owner"> · {a.owner}</span>} {cite(a.refs)}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {plan.questions.length > 0 && (
        <Section title="Open questions" testId="recap-questions">
          <ul>
            {plan.questions.map((q, i) => (
              <li key={i}>
                {q.text} {cite(q.refs)}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {plan.topVoted.length > 0 && (
        <Section title={plan.topVotedTitle} testId="recap-top-voted">
          <ol>
            {plan.topVoted.map((v) => (
              <li
                key={v.ref}
                data-testid="recap-vote"
                data-ref={v.ref}
                data-votes={v.votes}
                data-rank={v.rank}
              >
                {v.label} <span className="dr-ai-recap__owner">· {plural(v.votes, 'vote')}</span>{' '}
                {cite([v.ref])}
              </li>
            ))}
          </ol>
        </Section>
      )}
      {plan.plannedVsActual && plan.plannedVsActual.length > 0 && (
        <Section title="Planned vs actual" testId="recap-pva">
          <table className="dr-ai-recap__table">
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">Planned</th>
                <th scope="col">Actual</th>
              </tr>
            </thead>
            <tbody>
              {plan.plannedVsActual.map((r, i) => (
                <tr key={i} data-testid="recap-pva-row">
                  <td>{r.name}</td>
                  <td>{r.plannedMin === null ? '—' : `${r.plannedMin} min`}</td>
                  <td>{r.actualMin} min</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {recapIsEmpty(plan) && (
        <p className="dr-ai-panel__text" data-testid="recap-empty">
          Nothing to recap yet: nothing changed on the board in this window.
        </p>
      )}
      {plan.aiNote && (
        <p className="dr-ai-pop__foot" data-testid="recap-ai-note">
          {plan.aiNote}
        </p>
      )}
    </>
  )
}

function RecapView({ state }: { state: RecapState }) {
  const ctx = useCanvasFeatureContext()
  const { canvas } = ctx
  const ref = useRef<HTMLElement>(null)
  const titleId = useId()
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const readOnly = useValue('lobby-ai-recap-ro', () => canvas.readOnly(), [canvas])
  const frame = useValue('lobby-ai-recap-frame', () => {
    const own = state.frameId ? canvas.get(state.frameId) : undefined
    if (own && !(own as { isDeleted?: boolean }).isDeleted) return own.id
    return latestRecapFrame(canvas)?.id ?? null
  }, [canvas, state.frameId])
  const canExport = useValue('lobby-ai-recap-export', () => {
    const cmd = ctx.registries.commands.get(EXPORT_COMMAND)
    return !!cmd && exportAllowedOn(ctx.board.id) && commandRunnable(cmd, ctx)
  }, [ctx])
  // the export policy covers copying too (canvas-ux export-gate.ts): no Copy for a person it limits
  const canCopy = useValue('lobby-ai-recap-copy', () => exportAllowed(ctx), [ctx])
  const close = () => aiRecap(canvas).set(null)
  const closeRef = useRef(close)
  closeRef.current = close
  // Escape closes it from anywhere it owns; keys and presses inside stay off the canvas.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    const key = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
        canvas.focus({ preventScroll: true })
      }
    }
    el.addEventListener('keydown', key)
    for (const t of ['keyup', 'pointerdown', 'mousedown'] as const) el.addEventListener(t, stop)
    return () => {
      el.removeEventListener('keydown', key)
      for (const t of ['keyup', 'pointerdown', 'mousedown'] as const) el.removeEventListener(t, stop)
    }
  }, [canvas])
  const plan = state.plan
  // M4-4 (FTU-8): once the frame is on the board the panel folds to its header, so it does not cover the frame
  const [collapsed, setCollapsed] = useState(false)
  // a new recap opens unfolded
  useEffect(() => {
    if (plan) setCollapsed(false)
  }, [plan])
  const addFrame = () => {
    if (!plan || canvas.readOnly()) return
    const made = applyRecap(canvas, plan, ctx.me.user.id, state.about)
    aiRecap(canvas).set({ ...state, frameId: made.frameId })
    setCollapsed(true)
    offerUndoFor(canvas, 'Recap frame added to the board.', made.ids)
    // shown whole, clear of the board's chrome and of the folded panel (this tab's camera only)
    void revealResult(canvas, [made.frameId], {
      avoid: () => {
        const r = ref.current?.getBoundingClientRect()
        return r && r.width > 0 ? [{ x: r.left, y: r.top, width: r.width, height: r.height }] : []
      },
    })
  }
  return (
    <section
      ref={ref}
      className="dr-ai-panel dr-ai-recap"
      role="dialog"
      aria-labelledby={titleId}
      aria-busy={state.status === 'working'}
      data-testid="recap-panel"
      data-status={state.status}
      data-collapsed={collapsed ? '' : undefined}
      data-ai={plan ? String(plan.ai) : undefined}
    >
      <div className="dr-ai-pop__head">
        <span className="dr-ai-pop__badge" aria-hidden="true">
          <SparkIcon size={14} />
        </span>
        <h2 id={titleId} className="dr-ai-pop__title">
          {plan?.title ?? 'Recap'}{' '}
          <span className="dr-ai-pop__about">· {plan?.scopeLabel ?? 'working…'}</span>
        </h2>
        {collapsed && (
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="recap-expand"
            aria-expanded={false}
            onClick={() => setCollapsed(false)}
          >
            Show
          </button>
        )}
        <button type="button" className="dr-iconbtn dr-iconbtn--sm" aria-label="Close recap" onClick={close}>
          ×
        </button>
      </div>
      {collapsed ? (
        <p className="dr-ai-pop__foot" data-testid="recap-added" role="status">
          Added to the board as a frame.
        </p>
      ) : (
        <>
          <div className="dr-ai-recap__body">
            {plan ? (
              <Body plan={plan} />
            ) : (
              <div aria-hidden="true">
                <span className="dr-ai-line dr-ai-line--long" />
                <span className="dr-ai-line" />
                <span className="dr-ai-line dr-ai-line--short" />
              </div>
            )}
          </div>
          {plan && (
            <>
              <p className="dr-ai-pop__foot">
                {plan.ai
                  ? 'Only you can see this. Written by AI from the board, with the room’s own results.'
                  : 'Only you can see this. The room’s own results, no AI.'}
              </p>
              <div className="dr-ai-panel__actions dr-ai-recap__actions">
                {canCopy && (
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm"
                    data-testid="recap-copy"
                    onClick={() =>
                      void copyText(recapMarkdown(plan)).then((ok) => setCopied(ok ? 'yes' : 'no'))
                    }
                  >
                    {copied === 'yes' ? 'Copied' : copied === 'no' ? 'Copy failed' : 'Copy as Markdown'}
                  </button>
                )}
                {frame && canExport && (
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm"
                    data-testid="recap-pdf"
                    onClick={() => runCommand(ctx, EXPORT_COMMAND, 'menu', { frameIds: [frame] })}
                  >
                    Export recap as PDF
                  </button>
                )}
                {!readOnly && !recapIsEmpty(plan) && (
                  <button
                    type="button"
                    // once added, adding again is the lesser choice (M4-4)
                    className={state.frameId ? 'dr-btn dr-btn--sm' : 'dr-btn dr-btn--primary dr-btn--sm'}
                    data-testid="recap-add"
                    onClick={addFrame}
                  >
                    {state.frameId ? 'Add again' : 'Add as Recap frame'}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
