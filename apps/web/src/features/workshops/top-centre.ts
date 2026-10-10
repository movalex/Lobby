// Wave M (W2, M2-1): the board's top-centre stack for the meeting features (workshops' spotlight bar, people's
// "Following" pills, present-live's invitation). Ported feature code reaches the canvas only through canvas/api
// (biome.json), and the stack is the overlay's own (canvas/overlay/top-centre.tsx), so this is where those features
// reach it: a feature's top-centre box is `<TopCentreItem slot="spotlight">…</TopCentreItem>`; without a stack (a test)
// it renders where it is put.

export type { TopCentreSlot } from '../../canvas/overlay/top-centre.ts'
export { TopCentreItem } from '../../canvas/overlay/top-centre.tsx'
