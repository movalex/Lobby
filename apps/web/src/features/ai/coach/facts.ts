// OWNER: W2 (wave L, L2-4). What the session coach knows (./next-step.ts decides from it):
//  - the workshop's state, from the board event stream only (WORKSHOP_EVENTS vote and results, the private
//    brainstorm's event; parsed with the contracts' schemas, never the workshops feature's internals), seeded on
//    open with the last revealed vote this tab's workshop store holds (W5's lastRevealedResults);
//  - the board's facts: the team's notes per frame that no AI theme groups yet (contracts splitThemeNotes, as
//    Group into themes counts them), the AI theme labels and the notes they group, AI action items, a recap frame;
//  - the dismissed steps of this board, kept in localStorage (try/catch: blocked storage keeps them for the page).
// Nothing here requests, writes or plays anything.

import {
  PRIVATE_NOTES_EVENTS,
  PrivateBrainstormEvent,
  splitThemeNotes,
  WORKSHOP_EVENTS,
  WorkshopVoteEvent,
  WorkshopVoteResultsEvent,
} from '@draftroom/contracts'
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { items } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { lastRevealedResults } from '../../workshops/store.ts'
import { aiKindWord } from '../ported/provenance.ts'
import { perCanvas } from '../ported/runtime.ts'
import { frameIndex, frameOfElement, idOfRef, isLive, isNote, noteFacts } from '../ported/target.ts'
import type { CoachFacts, CoachFrameNotes, CoachWorkshop } from './next-step.ts'

/** Elements looked at when the board's facts are read (a huge board stops counting here). */
export const COACH_SCAN_LIMIT = 3000

export const coachWorkshop = perCanvas<Atom<CoachWorkshop>>(() =>
  atom<CoachWorkshop>('lobby-ai-coach-ws', { brainstorm: null, vote: null }),
)

const topOf = (results: readonly { shapeId?: string; ref?: string; count: number; rank: number }[]) =>
  [...results]
    .filter((r) => r.count > 0)
    .sort((a, b) => a.rank - b.rank || b.count - a.count)
    .map((r) => (r.shapeId ?? r.ref) as string)

/** A workshop event applied to the coach's state (pure). Unknown or malformed data changes nothing. */
export function applyWorkshopEvent(ws: CoachWorkshop, type: string, data: unknown): CoachWorkshop {
  if (type === WORKSHOP_EVENTS.vote) {
    const ev = WorkshopVoteEvent.safeParse(data)
    if (!ev.success) return ws
    const same = ws.vote?.sessionId === ev.data.sessionId
    return {
      ...ws,
      vote: {
        sessionId: ev.data.sessionId,
        status: ev.data.status,
        top: same && ev.data.status === 'revealed' ? (ws.vote?.top ?? []) : [],
      },
    }
  }
  if (type === WORKSHOP_EVENTS.results) {
    const ev = WorkshopVoteResultsEvent.safeParse(data)
    if (!ev.success) return ws
    return { ...ws, vote: { sessionId: ev.data.sessionId, status: 'revealed', top: topOf(ev.data.results) } }
  }
  if (type === PRIVATE_NOTES_EVENTS.changed) {
    const ev = PrivateBrainstormEvent.safeParse(data)
    if (!ev.success) return ws
    return {
      ...ws,
      brainstorm: { status: ev.data.session.status, frameId: idOfRef(ev.data.session.frameId) },
    }
  }
  return ws
}

/** Keeps `coachWorkshop` from the board's event stream (see the header). Returns the stop. */
export function listenWorkshop(ctx: Pick<CanvasFeatureContext, 'canvas' | 'events'>): () => void {
  const slot = coachWorkshop(ctx.canvas)
  const seed = () => {
    const last = lastRevealedResults(ctx.events)
    if (!last || slot.get().vote) return
    slot.set({
      ...slot.get(),
      vote: { sessionId: last.sessionId, status: 'revealed', top: topOf(last.results) },
    })
  }
  seed()
  const offs = [WORKSHOP_EVENTS.vote, WORKSHOP_EVENTS.results, PRIVATE_NOTES_EVENTS.changed].map((type) =>
    ctx.events.on(type, (data) => slot.set(applyWorkshopEvent(slot.get(), type, data))),
  )
  // a reconnect: the stream starts over; what the workshop store holds then is the seed again
  offs.push(ctx.events.onResync(seed))
  return () => {
    for (const off of offs) off()
  }
}

/** The board's facts for the coach (reads the canvas only). */
export function coachFacts(
  canvas: Pick<LobbyCanvas, 'items' | 'get' | 'isHidden' | 'isLocked' | 'text'>,
): CoachFacts {
  const all = canvas.items()
  const index = frameIndex(canvas as LobbyCanvas)
  const byFrame = new Map<string | null, CanvasElement[]>()
  const labelled = new Set<string | null>()
  let themeLabels = 0
  let actionItems = 0
  let recap = false
  let seen = 0
  for (const el of all) {
    if (++seen > COACH_SCAN_LIMIT) break
    if (!isLive(el) || canvas.isHidden(el.id)) continue
    const kind = aiKindWord(el)
    const own = items.lobbyValue(el, 'kind')
    if (own === 'recap' || own === 'ai-recap') recap = true
    if (kind === 'action-item') actionItems++
    if (kind === 'theme-label') {
      themeLabels++
      labelled.add(frameOfElement(canvas as LobbyCanvas, el, index)?.id ?? null)
      continue
    }
    if (!isNote(el) || kind !== null || canvas.isLocked(el.id)) continue
    if (!canvas.text.of(el.id).trim()) continue
    const key = frameOfElement(canvas as LobbyCanvas, el, index)?.id ?? null
    const list = byFrame.get(key) ?? []
    list.push(el)
    byFrame.set(key, list)
  }
  const frames: CoachFrameNotes[] = []
  const themeNotes: string[] = []
  for (const [frameId, notes] of byFrame) {
    // the team's notes (a template's prompt notes are not ideas: the rule Group into themes uses)
    const { ideas } = splitThemeNotes(notes, (n) => noteFacts(canvas as LobbyCanvas, n))
    if (labelled.has(frameId)) themeNotes.push(...ideas.map((n) => n.id))
    else frames.push({ frameId, ungrouped: ideas.map((n) => n.id) })
  }
  return { frames, themeLabels, themeNotes, actionItems, recap }
}

// ---- dismissals (per board, this device) -----------------------------------------------------------------

export const coachKey = (boardId: string) => `lobby-coach-dismissed:${boardId}`
export type CoachStorage = Pick<Storage, 'getItem' | 'setItem'>

const browserStorage = (): CoachStorage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Per page, for storage that refuses: the dismissals still hold until the page goes. */
const inPage = new Map<string, Set<string>>()

export function dismissedSteps(
  boardId: string,
  storage: CoachStorage | null = browserStorage(),
): Set<string> {
  const out = new Set(inPage.get(boardId) ?? [])
  try {
    const raw = storage?.getItem(coachKey(boardId))
    const list = raw ? (JSON.parse(raw) as unknown) : []
    if (Array.isArray(list)) for (const k of list) if (typeof k === 'string') out.add(k)
  } catch {
    // unreadable or blocked: what this page remembers
  }
  return out
}

export function dismissStep(
  boardId: string,
  key: string,
  storage: CoachStorage | null = browserStorage(),
): void {
  const all = dismissedSteps(boardId, storage)
  all.add(key)
  inPage.set(boardId, all)
  try {
    storage?.setItem(coachKey(boardId), JSON.stringify([...all].slice(-50)))
  } catch {
    // blocked or full: the page keeps it
  }
}

/** Forgets what this page remembered (tests). */
export const resetDismissals = () => inPage.clear()
