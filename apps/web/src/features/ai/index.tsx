// Feature module: ai (docs/WAVE4-CONTRACTS.md §4 ai-assist): AI on the board, through the api.
//  - entry points: "AI" in the selection bar and "AI ›" in the context menu (menus.tsx; canvas-ux
//    renders both), with Summarize, Group into themes, Action items and Generate ideas;
//  - the AI popover, the first-use "Sends the selected text to OpenAI" notice, the busy pill and the
//    summary panel for people who cannot edit (Overlay.tsx);
//  - results applied as ordinary canvas edits in one undo step (apply.ts, layout math in layout.ts).
// Hidden entirely unless the api reports AI on for this person on this board: not configured, switched
// off, a name-only guest, or a viewer limited by the export policy all see nothing. The api enforces
// every rule and every cost limit; the client only follows its answer.

import type { BoardFeature } from '../types.ts'
import { AI_TRANSLATIONS } from './menus.tsx'
import { AiOverlay } from './Overlay.tsx'
import { aiJob, aiMenu, aiPanel, setAiCtx } from './runtime.ts'
import './ai.css'

export const aiFeature: BoardFeature = {
  id: 'ai',
  Overlay: AiOverlay,
  overrides: { translations: { en: AI_TRANSLATIONS } },
  onMount(ctx) {
    setAiCtx(ctx.editor, ctx)
    const { editor } = ctx
    return () => {
      aiJob(editor).get()?.abort.abort()
      aiJob(editor).set(null)
      aiMenu(editor).set(null)
      aiPanel(editor).set(null)
    }
  },
}
