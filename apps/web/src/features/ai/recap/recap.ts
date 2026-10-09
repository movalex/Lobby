// OWNER: W2 (wave L, L2-3). Wrap up and Catch me up: one private recap panel (./RecapPanel.tsx) for the session, the
// selected frames, or what changed since this device's last visit. In about 3 s the facilitator has the meeting's
// decisions, owners and questions (AI) next to the room's real results (the top voted items from the revealed
// tallies, planned vs actual from the run of show). With AI off for the board, for a name-only guest, or when the
// AI call is refused, the recap is the non-AI sections only, says so, and makes no /ai request when AI is off.
// Nothing is written until an editor adds it as a Recap frame (./apply.ts, one undo step).
//
// Entry points: the command 'ai.recap' (args AiRecapArgs; W5's Facilitate > Wrap up and the coach run it), the AI
// menu ("Wrap up"), the context menu's AI submenu, and the board menu ("Catch me up").

import type { AiStatus } from '@draftroom/contracts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { knownUserKind } from '../../../invite/guest.tsx'
import { type Atom, atom } from '../../../lib/signals.ts'
import { agendaActuals } from '../../present-export/live/agenda.ts'
import { lastRevealedResults } from '../../workshops/store.ts'
import { ensureAiStatus, runPublic } from '../ported/actions.ts'
import { aiStatus, perCanvas } from '../ported/runtime.ts'
import { idOfRef, refOf } from '../ported/target.ts'
import { type RecapPlan, type RecapResult, recapPlan } from './plan.ts'
import { apiScope, catchUpWindow, type RecapScopeName, sessionSince } from './window.ts'

export interface RecapState {
  readonly status: 'working' | 'done'
  readonly scope: RecapScopeName
  readonly plan: RecapPlan | null
  /** what a 'selection' recap is about (element ids: the selected frames, else the selection); else none */
  readonly about: readonly string[]
  /** the Recap frame this tab added from it, once added */
  readonly frameId: string | null
}

/** The open recap of each canvas (private: this tab only, never stored). */
export const aiRecap = perCanvas<Atom<RecapState | null>>(() =>
  atom<RecapState | null>('lobby-ai-recap', null),
)

/** Why the recap has no AI part (the panel and the Markdown say so). */
export function aiOffNote(status: AiStatus | null, guest: boolean): string {
  if (guest) return 'Without AI: AI is not available to guests.'
  switch (status?.reason) {
    case 'not-configured':
    case 'turned-off':
      return 'Without AI: AI is not set up for Lobby right now.'
    case 'export-policy':
      return 'Without AI: AI is off for you on this board.'
    default:
      return 'Without AI: AI is off on this board.'
  }
}

/** The refs a 'selection' recap is about: the selected frames, else the selection itself. */
export function selectionRefs(canvas: Pick<LobbyCanvas, 'selection' | 'get'>): string[] {
  const sel = canvas.selection.filter((id) => !!canvas.get(id))
  const frames = sel.filter((id) => canvas.get(id)?.type === 'frame')
  return (frames.length ? frames : sel).map(refOf)
}

/** Whether a ref is in what a selection recap is about: one of `about`, or in one of those frames. */
export function inSelection(
  canvas: Pick<LobbyCanvas, 'get'>,
  about: readonly string[],
): (ref: string) => boolean {
  const set = new Set(about)
  return (ref) => {
    const id = idOfRef(ref)
    if (set.has(id)) return true
    const frameId = (canvas.get(id) as { frameId?: string | null } | undefined)?.frameId
    return !!frameId && set.has(frameId)
  }
}

/**
 * Opens the recap of `scope` (see the header): asks AI when it may (one budgeted call, the privacy notice first
 * when needed), joins the room's results, and shows the panel. A newer recap replaces one still on its way.
 */
export async function runRecap(
  ctx: CanvasFeatureContext,
  scope: RecapScopeName = 'session',
  now: number = Date.now(),
): Promise<RecapState | null> {
  const { canvas } = ctx
  const boardId = ctx.board.id
  const refs = scope === 'selection' ? selectionRefs(canvas) : []
  if (scope === 'selection' && !refs.length) {
    ctx.notify({
      key: 'dr-ai',
      text: 'Select the frames to recap first.',
      testId: 'ai-error',
      timeoutMs: 5000,
    })
    return null
  }
  const about = refs.map(idOfRef)
  const mine: RecapState = { status: 'working', scope, plan: null, about, frameId: null }
  const slot = aiRecap(canvas)
  slot.set(mine)
  const actuals = agendaActuals(boardId)
  const visit = scope === 'catch-up' ? catchUpWindow(boardId, now) : null
  const since = visit ? visit.since : scope === 'session' ? sessionSince(canvas.items(), now, actuals) : null
  // a selection recap: only the votes on what is in the selected frames, and only their sections of the run of show
  const inScope = scope === 'selection' ? inSelection(canvas, about) : undefined
  await ensureAiStatus(canvas)
  const status = aiStatus(canvas).get()
  const guest = knownUserKind(ctx.me.user.id) === 'guest' || status?.reason === 'guest'
  let result: RecapResult | null = null
  let aiNote: string | null = null
  if (status?.enabled && status.canSummarize && !guest) {
    const s = apiScope(scope, since ?? now, refs)
    const r = s ? await runPublic(ctx, { action: 'recap', scope: s, mode: 'panel' }) : null
    if (r?.action === 'recap') result = r
    else aiNote = 'Without AI this time: here is what the board itself knows.'
  } else aiNote = aiOffNote(status, guest)
  if (slot.get() !== mine) return null // replaced or closed meanwhile
  const plan = recapPlan({
    scope,
    now,
    result,
    aiNote,
    since,
    ...(visit ? { visit: visit.visit } : {}),
    ...(inScope ? { inScope } : {}),
    actuals: inScope ? (actuals?.filter((a) => inScope(refOf(a.frameId))) ?? null) : actuals,
    revealed: lastRevealedResults(ctx.events),
    textOf: (ref) => canvas.text.of(idOfRef(ref)),
  })
  const done: RecapState = { status: 'done', scope, plan, about, frameId: null }
  slot.set(done)
  return done
}
