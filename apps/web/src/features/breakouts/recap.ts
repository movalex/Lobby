// OWNER: WS4 (wave V, breakouts). The recap's 'breakouts' section (../ai/recap/sources.ts): how many groups, how many
// people, how long, and each group's member count. Aggregates only: no person is named. Built from the state this page
// holds (GET /api/boards/:bid/breakouts' answer and its events), never from a new request; null when no session ran
// in the recap's window.
import type { BreakoutState } from '@draftroom/contracts'
import type { RecapSection, RecapSourceInput } from '../ai/recap/sources.ts'
import { countText } from './model.ts'

const MODE_TEXT = {
  auto: 'split automatically',
  manual: 'assigned by the facilitator',
  choose: 'people chose',
} as const

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))

export function recapSection(
  state: BreakoutState | null,
  input: Pick<RecapSourceInput, 'since' | 'now'>,
): RecapSection | null {
  const s = state?.session
  if (!state || !s) return null
  const started = Date.parse(s.createdAt)
  const ended = s.endedAt ? Date.parse(s.endedAt) : null
  // in the window: still running, or ended after its start
  if (input.since !== null && ended !== null && ended < input.since) return null
  const people = new Set(state.members.map((m) => m.userId)).size
  const ranMs = (ended ?? input.now) - started
  const head = `${s.groups.length} groups, ${countText(people, null).replace('Empty', 'nobody')}, ${
    s.status === 'running' ? `running for ${minutes(ranMs)} min` : `${minutes(ranMs)} min`
  } (${MODE_TEXT[s.mode]})`
  const lines = [
    { text: head },
    ...s.groups.map((g) => ({
      text: `${g.name}: ${countText(state.members.filter((m) => m.groupId === g.id).length, null)}`,
    })),
  ]
  return { id: 'breakouts', title: 'Breakouts', lines }
}
