// OWNER: WS4 (wave V; registered empty by the wave V foundation, docs/WAVE-V-CONTRACTS.md §1). The 'breakouts' feature
// on the Excalidraw board page: breakouts (V3): the facilitator panel, the top-centre chip (slot 'breakout'), Go to my
// frame, broadcasts, group summons (contracts breakoutSummonApplies), the optional cursor dimming, its Facilitate entry
// and recap source. Until WS4 implements it, it contributes nothing, so the board page is unchanged; its switch is
// features/live/flags.ts LIVE_FLAGS.breakouts (off), and the api's DRAFTROOM_BREAKOUTS must be on too (liveEnabled).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'breakouts',
}
