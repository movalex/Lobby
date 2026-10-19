// OWNER: WS2 (wave V; registered empty by the wave V foundation, docs/WAVE-V-CONTRACTS.md §1). The 'live-activities'
// feature on the Excalidraw board page: polls, scales and word clouds (V1): the setup dialog, the answer sheet (a phone
// sheet too), the live and revealed results, moderation, Results to board (one canvas.transact, kind 'poll-chart' /
// 'word-cloud'), its Facilitate entry (workshops/ported/facilitate-entries.ts) and recap source (ai/recap/sources.ts).
// Until WS2 implements it, it contributes nothing, so the board page is unchanged; its switch is features/live/flags.ts
// LIVE_FLAGS.activities (off), and the api's DRAFTROOM_LIVE_ACTIVITIES must be on too (liveEnabled).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'live-activities',
}
