// OWNER: W8 (wave M, M8-2; registered empty by the wave M foundation). The 'ai-workspace-ask' feature on the
// Excalidraw board page: Ask across boards. W8 adds the palette command 'ai.askWorkspace' (./client.ts
// AI_ASK_WORKSPACE_COMMAND_ID) and sets what askWorkspaceAvailable() reads from the feature context in onMount.
// Until then it contributes nothing (no command, no panel, no key), so the board page is unchanged.
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'ai-workspace-ask',
}
