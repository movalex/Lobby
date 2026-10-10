// OWNER: W8 (wave M, M8-4; registered empty by the wave M foundation). The 'ws-templates' feature on the Excalidraw
// board page: "Save as workspace template" (the board menu and the palette, command 'ws-templates.save', shown to
// creators who are workspace admins). Until W8 implements it, it contributes nothing (no command, no menu entry),
// so the board page is unchanged; the routes it calls are pending on the api (404).
import type { CanvasFeature } from '../../canvas/api/index.ts'

/** The command W8 registers (contracts usage.ts PALETTE_COMMAND_IDS). */
export const WS_TEMPLATES_SAVE_COMMAND_ID = 'ws-templates.save'

export const feature: CanvasFeature = {
  id: 'ws-templates',
}
