// OWNER: WS3 (wave V; registered empty by the wave V foundation, docs/WAVE-V-CONTRACTS.md §1). The 'join' feature on the
// Excalidraw board page: the join card (V2: the QR of the link's /j/ URL, the short code in large type, the host, the
// expiry; never on the board) behind the Facilitate menu's "Show join code" (workshops/ported/facilitate-entries.ts).
// The /j/:code page is ./JoinPage.tsx (App.tsx), the Share dialog's "Show QR" row is board/ShareDialog.tsx
// WorkshopLinksSection. Until WS3 implements it, it contributes nothing; its switch is features/live/flags.ts
// LIVE_FLAGS.joinCodes (off), and the api's DRAFTROOM_JOIN_CODES must be on too (liveEnabled).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'join',
}
