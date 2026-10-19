// OWNER: WS2 (wave V, V1; docs/WAVE-V-CONTRACTS.md §5). Wrap up's sections for what the board's live activities
// found (registered through features/ai/recap/sources.ts; WS5 draws them): "Polls and scales" and "Word clouds", one
// line per activity of the recap's window, oldest first, from GET /api/boards/:bid/activities (aggregates only: an
// anonymous activity never names anyone, and nothing here asks for named answers). Read-only; null when there is
// nothing to say (or the feature is off here: the api answers 404, which the registry leaves out).
import { type ActivitySummary, activitiesPath, ListActivitiesResponse } from '@draftroom/contracts'
import type { RecapSection, RecapSourceInput, RecapSourceSpec } from '../ai/recap/sources.ts'
import { liveActivitiesOn } from './hooks.ts'
import { recapLine } from './words.ts'

/**
 * When an activity last changed (its reveal, else its close, else the time it ran out: an open activity past endsAt is
 * reported closed), or null while it is open.
 */
const endedAt = (s: ActivitySummary): number | null => {
  const a = s.activity
  if (a.status === 'open') return null
  return Date.parse(a.revealedAt ?? a.closedAt ?? a.endsAt ?? a.createdAt)
}

/**
 * The activities of the window, oldest first (cancelled ones say nothing): every one that ran in it: started in it,
 * still open, or closed or revealed in it (one started before the window and revealed inside it is in). The window is
 * the sources' (ai/recap/sources.ts recapSourceSince: for This session, the session's whole day).
 */
export function inWindow(list: readonly ActivitySummary[], since: number | null): ActivitySummary[] {
  return list
    .filter((s) => s.activity.status !== 'cancelled')
    .filter((s) => {
      if (since === null || Date.parse(s.activity.createdAt) >= since) return true
      const ended = endedAt(s)
      return ended === null || ended >= since
    })
    .slice()
    .sort((a, b) => Date.parse(a.activity.createdAt) - Date.parse(b.activity.createdAt))
}

/** One section from the list (pure; tested). */
export function sectionOf(
  id: 'activities' | 'word-clouds',
  list: readonly ActivitySummary[],
  since: number | null,
): RecapSection | null {
  const mine = inWindow(list, since).filter((s) =>
    id === 'word-clouds' ? s.activity.kind === 'words' : s.activity.kind !== 'words',
  )
  const lines = mine.flatMap((s) => {
    const text = recapLine(s)
    return text ? [{ text }] : []
  })
  if (!lines.length) return null
  return { id, title: id === 'word-clouds' ? 'Word clouds' : 'Polls and scales', lines }
}

async function listOf(input: RecapSourceInput): Promise<readonly ActivitySummary[] | null> {
  if (!liveActivitiesOn()) return null
  const r = await input.ctx.api.request('GET', activitiesPath(input.ctx.board.id), {
    schema: ListActivitiesResponse,
    signal: input.signal,
  })
  return r.activities
}

/** The two sources (registered on the feature's mount). Each reads the list once per recap. */
export function recapSourcesOf(): RecapSourceSpec[] {
  return [
    {
      id: 'activities',
      order: 10,
      collect: async (input) => {
        const list = await listOf(input)
        return list ? sectionOf('activities', list, input.since) : null
      },
    },
    {
      id: 'word-clouds',
      order: 11,
      collect: async (input) => {
        const list = await listOf(input)
        return list ? sectionOf('word-clouds', list, input.since) : null
      },
    },
  ]
}
