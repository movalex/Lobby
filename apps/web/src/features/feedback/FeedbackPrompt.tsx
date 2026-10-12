// Wave M (W2, M2-5, S6): "How did this go in Lobby? [Good] [Something got in the way]", one line in the board's
// top-centre stack after a facilitated moment (the rules: ./prompt.ts; the moments: ./prompt-moments.ts).
//  - Good sends `feedbackPromptGoodText(moment)` ("Good (after a vote reveal)") through the feedback client as it is,
//    with the usual context but the board's id alone, no title (N1: nothing is sent that the person has not seen):
//    POST /api/feedback, no new route, kind or field;
//  - Something got in the way opens the existing Send feedback dialog with `feedbackPromptIssuePrefill(moment)` in
//    "What happened?", for the person to finish;
//  - × says not now. It counts feedback.prompt.shown, .good and .issue (no text, no ids), asks a person at most once
//    in 7 days, never a name-only guest and never while words are being typed.
// The vote reveal is noticed here (the starter's tab saw its results come in); the other moments are noted where they
// happen (the presenter's controller, "Results to board", the agenda strip).

import {
  type FeedbackPromptMoment,
  feedbackPromptGoodText,
  feedbackPromptIssuePrefill,
} from '@draftroom/contracts'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useUserKind } from '../../invite/guest.tsx'
import { useValue } from '../../lib/signals.ts'
import { countUsage } from '../../lib/usage.ts'
import { TopCentreItem } from '../workshops/top-centre.ts'
import { useWorkshop } from '../workshops/workshop-context.ts'
import { feedbackApi } from './api.ts'
import { APP_BUILD } from './build-info.ts'
import { toInput } from './model.ts'
import {
  decideFeedbackPrompt,
  holdsTextLease,
  notePromptShown,
  ownsMoment,
  PROMPT_VISIBLE_MS,
  promptDue,
  promptGoodContext,
} from './prompt.ts'
import { momentsFor, noteFeedbackMoment } from './prompt-moments.ts'
import { openFeedback } from './state.ts'
import './feedback.css'

/** How long "Thanks" stays after a Good. */
const THANKS_MS = 2_500

export function FeedbackPromptLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const me = ctx.me.user.id
  const bus = momentsFor(ctx.canvas)
  const pending = useSyncExternalStore(bus.subscribe, bus.get, bus.get)
  const kind = useUserKind()
  const { snap } = useWorkshop(ctx)
  const [shown, setShown] = useState<FeedbackPromptMoment | null>(null)

  // a vote revealed in front of this tab by its starter is a moment (the card's news: the tab saw the results come in)
  const newsSeq = snap.resultsNews?.seq
  const starter = snap.vote?.session.createdBy ?? null
  useEffect(() => {
    if (newsSeq === undefined) return
    if (ownsMoment('vote-reveal', { me, voteStarter: starter, presenter: null }))
      noteFeedbackMoment(ctx.canvas, 'vote-reveal')
  }, [newsSeq, starter, me, ctx.canvas])

  // words in progress: an open editor, or a text lease held by this tab (reactive: leases and the roster)
  const typing = useValue('dr-fb-typing', () => {
    ctx.canvas.collaborators() // tracks lease and roster changes
    return holdsTextLease({
      editingId: ctx.canvas.editingId(),
      holders: ctx.canvas.engine?.leaseHolders() ?? null,
      mySid: ctx.canvas.engine?.welcome?.sid ?? null,
    })
  }, [ctx.canvas])

  // ask, wait or let it go (only an account is ever asked; a kind this tab does not know yet is waited for, N1)
  useEffect(() => {
    if (!pending || shown) return
    const now = Date.now()
    const decision = decideFeedbackPrompt({
      guest: kind === null ? null : kind !== 'account',
      typing,
      due: promptDue(me, now),
      noted: pending.at,
      now,
    })
    if (decision === 'wait') return
    bus.clear()
    if (decision === 'drop') return
    notePromptShown(me, now)
    countUsage('feedback.prompt.shown')
    setShown(pending.moment)
  }, [pending, shown, kind, typing, me, bus])

  return (
    <TopCentreItem slot="feedback">
      {shown ? <PromptLine ctx={ctx} moment={shown} onDone={() => setShown(null)} /> : null}
    </TopCentreItem>
  )
}

function PromptLine({
  ctx,
  moment,
  onDone,
}: {
  ctx: CanvasFeatureContext
  moment: FeedbackPromptMoment
  onDone(): void
}) {
  const [phase, setPhase] = useState<'asking' | 'sending' | 'thanks'>('asking')
  const done = useRef(onDone)
  done.current = onDone
  // unanswered, it goes by itself
  useEffect(() => {
    if (phase !== 'asking') return
    const t = setTimeout(() => done.current(), PROMPT_VISIBLE_MS)
    return () => clearTimeout(t)
  }, [phase])
  useEffect(() => {
    if (phase !== 'thanks') return
    const t = setTimeout(() => done.current(), THANKS_MS)
    return () => clearTimeout(t)
  }, [phase])

  const good = async () => {
    countUsage('feedback.prompt.good')
    setPhase('sending')
    try {
      // the board by its id alone: the prompt shows nothing of what a Good sends (./prompt.ts promptGoodContext)
      const context = promptGoodContext({
        pathname: location.pathname,
        userAgent: navigator.userAgent,
        width: window.innerWidth,
        height: window.innerHeight,
        build: APP_BUILD,
        now: new Date(),
        boardId: ctx.board.id,
      })
      await feedbackApi().send(toInput(feedbackPromptGoodText(moment), '', context))
      setPhase('thanks')
    } catch {
      ctx.notify({
        key: 'feedback-prompt',
        text: 'That was not sent. You can still tell us from Feedback in the board menu.',
        tone: 'error',
        testId: 'feedback-prompt-error',
        timeoutMs: 6000,
      })
      done.current()
    }
  }
  const issue = () => {
    countUsage('feedback.prompt.issue')
    done.current()
    openFeedback(
      { id: ctx.board.id, title: ctx.board.title },
      () => ctx.canvas.focus({ preventScroll: true }),
      feedbackPromptIssuePrefill(moment),
    )
  }

  if (phase === 'thanks')
    return (
      <section
        className="dr-fb-prompt"
        role="status"
        data-testid="feedback-prompt"
        data-moment={moment}
        data-phase="thanks"
      >
        <span data-testid="feedback-prompt-thanks">Thanks, that helps.</span>
      </section>
    )
  return (
    <section
      className="dr-fb-prompt"
      role="status"
      aria-label="Feedback"
      data-testid="feedback-prompt"
      data-moment={moment}
      data-phase={phase}
    >
      <span className="dr-fb-prompt__q">How did this go in Lobby?</span>
      <button
        type="button"
        className="dr-btn dr-btn--sm"
        data-testid="feedback-prompt-good"
        disabled={phase === 'sending'}
        onClick={() => void good()}
      >
        Good
      </button>
      <button type="button" className="dr-btn dr-btn--sm" data-testid="feedback-prompt-issue" onClick={issue}>
        Something got in the way
      </button>
      <button
        type="button"
        className="dr-iconbtn dr-iconbtn--sm dr-fb-prompt__x"
        aria-label="Not now"
        title="Not now"
        data-testid="feedback-prompt-close"
        onClick={() => done.current()}
      >
        ×
      </button>
    </section>
  )
}
