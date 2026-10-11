// OWNER: 3h (docs/EXCALIDRAW-CONTRACTS.md §7.2); wave L: W2. The ported 'ai' feature on the Excalidraw board page
// (plan §4.7; the tldraw twin is ../index.tsx): AI on the board, through the api.
//  - entry points: "AI" in the selection bar and "AI ›" in the context menu (./menus.tsx; 3a's shells
//    render both), with Summarize, Group into themes, Action items and Generate ideas; the owners' AI
//    switches in the board menu;
//  - the AI popover, the first-use "Sends the selected text to OpenAI" notice, the busy pill and the
//    summary panel (./Overlay.tsx, a screen layer);
//  - results applied as ordinary canvas edits in one `transact` (./apply.ts, layout math in ../layout.ts),
//    every element made carrying `customData.lobby.ai`.
//  - mind maps (K7): "Expand with AI" on a selected topic (the topic bar of ../../mindmap, the context menu, the AI
//    menu, command ai.expand) and "Mind map from a prompt" (the AI menu, the ideas prompt's "Show them as", commands
//    ai.mindmap and ai.ideas): the existing 'ideas' action, its answer built as topics in one undo step
//    (./expand.ts, ./actions.ts);
//  - the wait (K7-4): a shimmer where the result will land and a brief highlight on it (./Placeholders.tsx, overlay
//    only), and the status read that waits for an idle moment after the board is live (./idle.ts).
//  - wave L (W2): the trust layer (L2-1): the preview before a plan moves or recolours anything (./preview.tsx),
//    provenance with the run id (./provenance.ts), the AI lens (./lens.tsx), "Remove this AI result"
//    (./remove.ts) and the live "Dana is using AI here" shimmer (./working.tsx); the cross-workstream API in
//    ./public.ts; Ask this board (L2-2, ./ask.ts); Wrap up and Catch me up (L2-3, ../recap/); the session coach
//    (L2-4, ../coach/).
//  - wave N (WS5): Capture the room (../capture/): a photo or a meeting transcript becomes notes, a native diagram or
//    a meeting frame, previewed first; its dialog is the 'ai-capture' overlay.
// Hidden entirely unless the api reports AI on for this person on this board: not configured, switched
// off, a name-only guest, or a viewer limited by the export policy all see nothing. The api enforces
// every rule and every cost limit; the client only follows its answer. The live shimmer and the lens are the
// exceptions: they only show what others did, to everyone on the board, and never ask the api anything.
import type { CanvasFeature } from '../../../canvas/api/index.ts'
import '../ai.css'
import './ai-ported.css'
import './wave-l.css'
import './wave-m.css'
import { CaptureDialogOverlay } from '../capture/CaptureDialog.tsx'
import { releaseCaptureCanvas, setCaptureCanvas } from '../capture/client.ts'
import { captureJob, closeCaptureDialog } from '../capture/run.ts'
import { CoachOverlay } from '../coach/CoachChip.tsx'
import { listenWorkshop } from '../coach/facts.ts'
import { AiRecapOverlay } from '../recap/RecapPanel.tsx'
import { aiRecap } from '../recap/recap.ts'
import { noteVisit, writeLastVisit } from '../recap/window.ts'
import { aiAnswer } from './ask.ts'
import { AiLensOverlay } from './lens.tsx'
import { AiEntryFallback, COMMANDS, CONTEXT_MENU, MAIN_MENU, SELECTION_BAR } from './menus.tsx'
import { AiOverlay } from './Overlay.tsx'
import { AiPreviewOverlay, discardPreview } from './preview.tsx'
import { watchAiRuns } from './remove.ts'
import { aiJob, aiMenu, aiPanel, setAiCtx } from './runtime.ts'
import { AiWorkingOverlay, isOwnRun, listenAiWorking } from './working.tsx'

export const feature: CanvasFeature = {
  id: 'ai',
  // the popover, busy pill and summary panel take clicks through their own elements (ai.css), the layer never
  overlays: [
    { id: 'ai-working', layer: 'screen', order: 57, pointer: 'none', component: AiWorkingOverlay },
    { id: 'ai-lens', layer: 'screen', order: 58, pointer: 'none', component: AiLensOverlay },
    { id: 'ai', layer: 'screen', order: 60, pointer: 'none', component: AiOverlay },
    { id: 'ai-entry', layer: 'screen', order: 59, pointer: 'none', component: AiEntryFallback },
    { id: 'ai-preview', layer: 'screen', order: 61, pointer: 'none', component: AiPreviewOverlay },
    { id: 'ai-recap', layer: 'screen', order: 62, pointer: 'none', component: AiRecapOverlay },
    { id: 'ai-coach', layer: 'screen', order: 56, pointer: 'none', component: CoachOverlay },
    // wave N (WS5): Capture the room's dialog (../capture/CaptureDialog.tsx)
    { id: 'ai-capture', layer: 'screen', order: 63, pointer: 'none', component: CaptureDialogOverlay },
  ],
  commands: COMMANDS,
  selectionBar: SELECTION_BAR,
  contextMenu: CONTEXT_MENU,
  mainMenu: MAIN_MENU,
  onMount(ctx) {
    setAiCtx(ctx)
    const { canvas } = ctx
    // wave N (WS5): the board Capture the room works on (../capture/client.ts)
    setCaptureCanvas(canvas)
    // L2-3 Catch me up: this visit is the next one's "since" (device-local; no request)
    noteVisit(ctx.board.id, Date.now())
    const left = () => writeLastVisit(ctx.board.id, Date.now())
    globalThis.addEventListener?.('pagehide', left)
    const stopRuns = watchAiRuns(ctx)
    // L2-4: the coach's view of the workshop, from the event stream only (no request)
    const stopCoach = listenWorkshop(ctx)
    const stopWorking = listenAiWorking(ctx, (ev) => isOwnRun(canvas, ctx.me.user.name, ev))
    return () => {
      left()
      globalThis.removeEventListener?.('pagehide', left)
      stopRuns()
      stopCoach()
      stopWorking()
      discardPreview(canvas)
      captureJob(canvas).get()?.abort.abort()
      captureJob(canvas).set(null)
      closeCaptureDialog(canvas)
      releaseCaptureCanvas(canvas)
      aiJob(canvas).get()?.abort.abort()
      aiJob(canvas).set(null)
      aiMenu(canvas).set(null)
      aiPanel(canvas).set(null)
      aiAnswer(canvas).set(null)
      aiRecap(canvas).set(null)
    }
  },
}
