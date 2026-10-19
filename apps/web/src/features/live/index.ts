// OWNER: the wave V foundation (the lead): what the wave V web features share (docs/WAVE-V-CONTRACTS.md §6). Read-only to
// WS2-WS5: the switches (./flags.ts), and pointers to the shared seams that live with their hosts:
//   - the Facilitate menu's entries and pill parts: ../workshops/ported/facilitate-entries.ts
//   - the top-centre stack's 'breakout' slot: ../workshops/top-centre.ts (TopCentreItem)
//   - the recap's sources: ../ai/recap/sources.ts
//   - the Export dialog's 'session-csv' section: ../present-export/ported/export-sections.ts
export {
  LIVE_FLAG_KEYS,
  LIVE_FLAG_SERVER,
  LIVE_FLAGS,
  type LiveFlag,
  type LiveFlags,
  liveEnabled,
  liveFlags,
  liveSwitches,
  setLiveSwitches,
} from './flags.ts'
