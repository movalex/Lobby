// OWNER: W2 (wave L, L2-4). The session coach's chip: one "next step" for the facilitator, next to the Facilitate
// control (K3-3) in a screen layer of the AI feature. Facilitators only: editors with an account who run the session
// (wave M, M2-2, ./next-step.ts `runsSession`: the vote's starter, else the live presenter, else the board's owner
// while nobody presents), hidden while following someone in present mode, and per board dismissible ("Not now",
// kept in localStorage). It counts its showing and its use (coach.shown, coach.run: no id, no text). It makes no
// request, no sound, and writes nothing until it is clicked; a click runs an existing command by id (canvas-ux
// runCommand), with that command's own gate, notice and server checks:
//   themes  → 'ai.themes' on the notes it names (they are selected first);
//   vote    → W5's 'workshops.vote.setup' {scope: 'selection', refs: the theme notes};
//   actions → 'ai.actions' {voteSessionId} on the vote's top items (selected first);
//   wrapup  → 'ai.recap' {scope: 'session'}.
// The AI steps (themes, actions) are offered only while AI may add to this board for this person (./next-step.ts:
// the AI status, read again when it changes); a click that still cannot run says why (never a silent click).

import { can } from '@draftroom/permissions'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { TopCentreItem } from '../../../canvas/overlay/top-centre.tsx'
import { useUserKind } from '../../../invite/guest.tsx'
import { computed, subscribeValue } from '../../../lib/signals.ts'
import { countUsage } from '../../../lib/usage.ts'
import { runCommand } from '../../canvas-ux/ported/commands.ts'
import { getLive } from '../../present-export/live/ported/controller.ts'
import { serverNowOf, voteStarterOf } from '../../workshops/store.ts'
import { SparkIcon } from '../icons.tsx'
import { canBuildWithAi } from '../ported/gate.ts'
import { AI_COMMAND_IDS } from '../ported/public.ts'
import { aiJob, aiStatus, setAiCtx } from '../ported/runtime.ts'
import { idOfRef } from '../ported/target.ts'
import { coachFacts, coachWorkshop, dismissedSteps, dismissStep, seedWorkshop } from './facts.ts'
import {
  type CoachStep,
  liveWorkshop,
  nextStep,
  runsSession,
  type SessionFacts,
  stepKey,
} from './next-step.ts'

/** W5's vote setup (features/workshops/commands.ts WORKSHOP_COMMAND_IDS.voteSetup). */
const VOTE_SETUP = 'workshops.vote.setup'

/** Runs `step` (a click on the chip). False when its command is not there or may not run now. */
export function runStep(ctx: CanvasFeatureContext, step: CoachStep): boolean {
  setAiCtx(ctx)
  switch (step.id) {
    case 'themes':
      ctx.canvas.select([...step.notes])
      return runCommand(ctx, AI_COMMAND_IDS.themes, 'menu')
    case 'vote':
      return runCommand(ctx, VOTE_SETUP, 'menu', {
        scope: 'selection',
        refs: [...step.refs],
        onePerObject: false,
      })
    case 'actions': {
      const ids = step.refs.map(idOfRef).filter((id) => !!ctx.canvas.get(id))
      if (ids.length) ctx.canvas.select(ids)
      return runCommand(ctx, AI_COMMAND_IDS.actions, 'menu', { voteSessionId: step.voteSessionId })
    }
    case 'wrapup':
      return runCommand(ctx, AI_COMMAND_IDS.recap, 'menu', { scope: 'session' })
  }
}

/** What the chip says when its step could not run (null: nothing to say; Wrap up always runs). */
export function refusedHint(
  ctx: CanvasFeatureContext,
  step: CoachStep,
): { text: string; testId: string; tone?: 'error' } | null {
  if (step.id === 'vote')
    return { text: 'Open Facilitate › Voting to start the vote on the themes.', testId: 'coach-vote-hint' }
  if (step.id === 'wrapup') return null
  const text = aiJob(ctx.canvas).get()
    ? 'Lobby is still working on another AI request. Wait for it to finish.'
    : 'AI isn’t available on this board right now.'
  return { text, testId: 'ai-error', tone: 'error' }
}

/**
 * Where the chip goes: under the Facilitate button, its right edge with the button's (so it grows to the left, clear
 * of the style panel at the canvas's top right), else the canvas's top right.
 */
function useAnchor(ctx: CanvasFeatureContext): { right: number } {
  const [at, setAt] = useState<{ right: number }>({ right: 12 })
  useEffect(() => {
    const place = () => {
      const c = ctx.canvas.container()
      const doc = c?.ownerDocument ?? document
      const btn = doc.querySelector<HTMLElement>('[data-testid="facilitate-button"]')
      const box = c?.getBoundingClientRect()
      const b = btn?.getBoundingClientRect()
      if (!box || !b || b.width === 0) return setAt({ right: 12 })
      const right = Math.max(8, Math.min(box.right - b.right, box.width - 240))
      setAt({ right: Math.round(right) })
    }
    place()
    const win = ctx.canvas.container()?.ownerDocument.defaultView ?? globalThis
    win.addEventListener?.('resize', place)
    return () => win.removeEventListener?.('resize', place)
  }, [ctx])
  return at
}

/** The coach layer (a screen overlay of the AI feature). Nothing for people who do not facilitate. */
export function CoachOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const kind = useUserKind()
  const facilitator = can(ctx.role, 'edit', ctx.board.status) && kind !== 'guest'
  if (!facilitator) return null
  return <CoachChip ctx={ctx} />
}

/** How long the board must be still before the coach looks again (a drag or a paste is many changes). */
export const COACH_SETTLE_MS = 300

/** Who presents to everyone now (a user id), or null. Reactive: the live controller may mount after the coach. */
const livePresenter = (ctx: CanvasFeatureContext) =>
  computed(
    'lobby-ai-coach-presenter',
    () => getLive(ctx.registries)?.store.presentation.get()?.presenter.userId ?? null,
  )

/** What decides whether this person runs the session (./next-step.ts `runsSession`), as of now. */
export function sessionFactsOf(
  ctx: CanvasFeatureContext,
  presenter: string | null,
  now: number = serverNowOf(ctx.events),
): SessionFacts {
  // N1: last week's vote is no longer this session's: its starter does not keep the coach
  const vote = liveWorkshop(coachWorkshop(ctx.canvas).get(), now).vote
  return {
    me: ctx.me.user.id,
    role: ctx.role,
    voteStarter: vote ? (vote.startedBy ?? voteStarterOf(ctx.events, vote.sessionId)) : null,
    presenter,
  }
}

/** The next step, read again once the board (or the workshop, or following) has been still for a moment. */
function useCoachStep(ctx: CanvasFeatureContext): CoachStep | null {
  const { canvas } = ctx
  const presenter = useMemo(() => livePresenter(ctx), [ctx])
  const compute = () => {
    seedWorkshop(ctx)
    return JSON.stringify(
      nextStep(liveWorkshop(coachWorkshop(canvas).get(), serverNowOf(ctx.events)), coachFacts(canvas), {
        facilitator: !canvas.readOnly() && runsSession(sessionFactsOf(ctx, presenter.get())),
        following: canvas.follow.current() !== null,
        ai: canBuildWithAi(aiStatus(canvas).get(), canvas.readOnly()),
      }),
    )
  }
  const [json, setJson] = useState(compute)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        setJson(compute())
      }, COACH_SETTLE_MS)
    }
    const offs = [
      canvas.on('change', later),
      canvas.on('followChanged', later),
      subscribeValue(coachWorkshop(canvas), later),
      // a presentation to everyone starting or ending changes who runs the session
      subscribeValue(presenter, later),
      // AI switched on or off here, the budget spent, the first status read landing
      subscribeValue(aiStatus(canvas), later),
    ]
    later()
    return () => {
      for (const off of offs) off()
      if (timer) clearTimeout(timer)
    }
  }, [ctx])
  return JSON.parse(json) as CoachStep | null
}

function CoachChip({ ctx }: { ctx: CanvasFeatureContext }) {
  const [dismissed, setDismissed] = useState(() => dismissedSteps(ctx.board.id))
  const step = useCoachStep(ctx)
  const at = useAnchor(ctx)
  const shown = step && !dismissed.has(stepKey(step)) ? stepKey(step) : null
  // one count per step shown (coach.shown: how often the chip is in front of someone, not how long)
  const counted = useRef<string | null>(null)
  useEffect(() => {
    if (shown === null || counted.current === shown) return
    counted.current = shown
    countUsage('coach.shown')
  }, [shown])
  if (!step || shown === null) return null
  return (
    <TopCentreItem slot="coach">
      <div className="dr-ai-coach" style={at} data-testid="coach-chip" data-step={step.id} role="status">
        <button
          type="button"
          className="dr-ai-coach__run"
          data-testid="coach-run"
          onClick={() => {
            countUsage('coach.run')
            if (runStep(ctx, step)) return
            const hint = refusedHint(ctx, step)
            if (hint) ctx.notify({ key: 'dr-ai', timeoutMs: 6000, ...hint })
          }}
        >
          <SparkIcon size={13} />
          <span className="dr-ai-coach__label">{step.label}</span>
        </button>
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm dr-ai-coach__x"
          aria-label="Not now"
          title="Not now"
          data-testid="coach-dismiss"
          onClick={() => {
            dismissStep(ctx.board.id, stepKey(step))
            setDismissed(dismissedSteps(ctx.board.id))
          }}
        >
          ×
        </button>
      </div>
    </TopCentreItem>
  )
}
