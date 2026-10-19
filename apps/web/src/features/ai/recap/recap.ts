// OWNER: W2 (wave L, L2-3). Wrap up and Catch me up: one private recap panel (./RecapPanel.tsx) for the session, the
// selected frames, or what changed since this device's last visit. In about 3 s the facilitator has the meeting's
// decisions, owners and questions (AI) next to the room's real results (the top voted items from the revealed
// tallies, planned vs actual from the run of show). With AI off for the board, for a name-only guest, or when the
// AI call is refused, the recap is the non-AI sections only, says so, and makes no /ai request when AI is off.
// Nothing is written until an editor adds it as a Recap frame (./apply.ts, one undo step).
//
// Entry points: the command 'ai.recap' (args AiRecapArgs; W5's Facilitate > Wrap up and the coach run it), the AI
// menu ("Wrap up"), the context menu's AI submenu, and the board menu ("Catch me up").
//
// Wave V (WS5, the session summary; docs/WAVE-V-CONTRACTS.md §5): while the summary's switch is on
// (features/live liveEnabled('summary'): a web switch only, it needs no api switch), the recap also asks every
// registered source (./sources.ts: polls and scales, word clouds, breakouts) for its section, at the same time as the
// AI call and never through it: those sections are the board's own aggregates, read from the features' own routes,
// so they are there with AI off, for a guest and when the AI call is refused. A late or failing source is left out.
// The Export dialog's "Session results (CSV)" section (../../present-export/session-csv) is registered here, with the
// recap it belongs to.

import type { AiStatus } from '@draftroom/contracts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { knownUserKind } from '../../../invite/guest.tsx'
import { type Atom, atom } from '../../../lib/signals.ts'
import { liveEnabled } from '../../live/index.ts'
import { agendaActuals } from '../../present-export/live/agenda.ts'
import { registerExportSection } from '../../present-export/ported/export-sections.ts'
import { SESSION_CSV_SECTION } from '../../present-export/session-csv/Section.tsx'
import { lastRevealedResults } from '../../workshops/store.ts'
import { ensureAiStatus, runPublic } from '../ported/actions.ts'
import { aiStatus, openingPrivatePanel, perCanvas, registerPrivatePanel } from '../ported/runtime.ts'
import { idOfRef, refOf } from '../ported/target.ts'
import { type RecapPlan, type RecapResult, recapPlan } from './plan.ts'
import { collectRecapSections, type RecapSection, recapSourceSince } from './sources.ts'
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

registerPrivatePanel('recap', (canvas) => aiRecap(canvas).set(null))
// offered only while the summary's and the activities' switches are on (its own `offered`)
registerExportSection(SESSION_CSV_SECTION)

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
  // one private panel at a time: the summary or an answer closes
  openingPrivatePanel(canvas, 'recap')
  const actuals = agendaActuals(boardId)
  const visit = scope === 'catch-up' ? catchUpWindow(boardId, now) : null
  const since = visit ? visit.since : scope === 'session' ? sessionSince(canvas.items(), now, actuals) : null
  // a selection recap: only the votes on what is in the selected frames, and only their sections of the run of show
  const inScope = scope === 'selection' ? inSelection(canvas, about) : undefined
  // wave V: the sources' sections, asked now (beside the AI call, never through it); aborted when this recap is
  // replaced or closed (checked below)
  const sourcesCtl = new AbortController()
  const sectionsOf: Promise<RecapSection[]> = liveEnabled('summary')
    ? collectRecapSections({
        ctx,
        scope,
        // the session's whole day for the live sources: a poll run before anything was drawn is in (./sources.ts)
        since: recapSourceSince(scope, since, now),
        now,
        signal: sourcesCtl.signal,
      })
    : Promise.resolve([])
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
  if (slot.get() !== mine) {
    sourcesCtl.abort()
    return null // replaced or closed meanwhile
  }
  const sections = await sectionsOf
  if (slot.get() !== mine) return null
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
    sections,
  })
  const done: RecapState = { status: 'done', scope, plan, about, frameId: null }
  slot.set(done)
  return done
}
