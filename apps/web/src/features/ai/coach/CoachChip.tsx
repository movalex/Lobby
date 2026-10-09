// OWNER: W2 (wave L, L2-4). The session coach's chip: one "next step" for the facilitator, next to the Facilitate
// control (K3-3) in a screen layer of the AI feature. Facilitators only (editors with an account), hidden while
// following someone in present mode, and per board dismissible ("Not now", kept in localStorage). It makes no
// request, no sound, and writes nothing until it is clicked; a click runs an existing command by id (canvas-ux
// runCommand), with that command's own gate, notice and server checks:
//   themes  → 'ai.themes' on the notes it names (they are selected first);
//   vote    → W5's 'workshops.vote.setup' {scope: 'selection', refs: the theme notes};
//   actions → 'ai.actions' {voteSessionId} on the vote's top items (selected first);
//   wrapup  → 'ai.recap' {scope: 'session'}.

import { can } from '@draftroom/permissions'
import { useEffect, useState } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useUserKind } from '../../../invite/guest.tsx'
import { subscribeValue } from '../../../lib/signals.ts'
import { runCommand } from '../../canvas-ux/ported/commands.ts'
import { SparkIcon } from '../icons.tsx'
import { AI_COMMAND_IDS } from '../ported/public.ts'
import { setAiCtx } from '../ported/runtime.ts'
import { idOfRef } from '../ported/target.ts'
import { coachFacts, coachWorkshop, dismissedSteps, dismissStep, seedWorkshop } from './facts.ts'
import { type CoachStep, nextStep, stepKey } from './next-step.ts'

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

/** The next step, read again once the board (or the workshop, or following) has been still for a moment. */
function useCoachStep(ctx: CanvasFeatureContext): CoachStep | null {
  const { canvas } = ctx
  const compute = () => {
    seedWorkshop(ctx)
    return JSON.stringify(
      nextStep(coachWorkshop(canvas).get(), coachFacts(canvas), {
        facilitator: !canvas.readOnly(),
        following: canvas.follow.current() !== null,
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
  if (!step || dismissed.has(stepKey(step))) return null
  return (
    <div className="dr-ai-coach" style={at} data-testid="coach-chip" data-step={step.id} role="status">
      <button
        type="button"
        className="dr-ai-coach__run"
        data-testid="coach-run"
        onClick={() => {
          if (!runStep(ctx, step) && step.id === 'vote')
            ctx.notify({
              key: 'dr-ai',
              text: 'Open Facilitate › Voting to start the vote on the themes.',
              testId: 'coach-vote-hint',
              timeoutMs: 6000,
            })
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
  )
}
