// OWNER: 3h (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'ai' feature on the Excalidraw board page
// (plan §4.7; the tldraw twin is ../index.tsx): AI on the board, through the api.
//  - entry points: "AI" in the selection bar and "AI ›" in the context menu (./menus.tsx; 3a's shells
//    render both), with Summarize, Group into themes, Action items and Generate ideas; the owners' AI
//    switches in the board menu;
//  - the AI popover, the first-use "Sends the selected text to OpenAI" notice, the busy pill and the
//    summary panel (./Overlay.tsx, a screen layer);
//  - results applied as ordinary canvas edits in one `transact` (./apply.ts, layout math in ../layout.ts),
//    every element made carrying `customData.lobby.ai`.
// Hidden entirely unless the api reports AI on for this person on this board: not configured, switched
// off, a name-only guest, or a viewer limited by the export policy all see nothing. The api enforces
// every rule and every cost limit; the client only follows its answer.
import type { CanvasFeature } from '../../../canvas/api/index.ts'
import '../ai.css'
import './ai-ported.css'
import { AiEntryFallback, CONTEXT_MENU, MAIN_MENU, SELECTION_BAR } from './menus.tsx'
import { AiOverlay } from './Overlay.tsx'
import { aiJob, aiMenu, aiPanel, setAiCtx } from './runtime.ts'

export const feature: CanvasFeature = {
  id: 'ai',
  // the popover, busy pill and summary panel take clicks through their own elements (ai.css), the layer never
  overlays: [
    { id: 'ai', layer: 'screen', order: 60, pointer: 'none', component: AiOverlay },
    { id: 'ai-entry', layer: 'screen', order: 59, pointer: 'none', component: AiEntryFallback },
  ],
  selectionBar: SELECTION_BAR,
  contextMenu: CONTEXT_MENU,
  mainMenu: MAIN_MENU,
  onMount(ctx) {
    setAiCtx(ctx)
    const { canvas } = ctx
    return () => {
      aiJob(canvas).get()?.abort.abort()
      aiJob(canvas).set(null)
      aiMenu(canvas).set(null)
      aiPanel(canvas).set(null)
    }
  },
}
