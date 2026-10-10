// OWNER: W4 (wave L). The 'flow' feature on the Excalidraw board page: flow building and diagrams.
//
//  - L4-1 keyboard flow-building (./keys.ts, ./runtime.ts): Ctrl/Cmd+Arrow makes the next connected shape of the
//    one selected shape, Ctrl/Cmd+Shift+Arrow one of the last created kind; its editor opens through the text lease
//    with no key lost; the + handles (./Handles.tsx) do the same with the pointer, and drag to connect. Alt+Arrow
//    walks the connections (a11y's walk, told the arrow by ./runtime.ts) and the live region names them.
//  - L4-2 Diagram from words (../ai/diagram/DiagramPrompt.tsx): the command 'flow.diagram' (the palette), and, since
//    wave M (M4-5), "Diagram from words…" inside the context menu's AI submenu (../ai/ported/menus.tsx).
//  - L4-3 Mermaid paste (./MermaidPaste.tsx): a pasted flowchart becomes the same native diagram, no AI.
//
// W3 registers it in features/canvas-registry.ts BEFORE a11y (its contextual Ctrl/Cmd+Shift+Arrow is asked first).
// With it absent, the board is exactly as before: the wave L chords stay blocked by the allowlist, Alt+Arrow walks
// the reading order, a pasted flowchart is bulk paste's.
import type { CanvasFeature } from '../../canvas/api/index.ts'
import { DIAGRAM_COMMAND, DiagramPrompt } from '../ai/diagram/DiagramPrompt.tsx'
import { FlowHandles } from './Handles.tsx'
import { FLOW_KEYS } from './keys.ts'
import { MERMAID_PASTE_HANDLER, MermaidPastePrompt } from './MermaidPaste.tsx'
import { mountFlow } from './runtime.ts'

export const feature: CanvasFeature = {
  id: 'flow',
  keys: FLOW_KEYS,
  commands: [DIAGRAM_COMMAND],
  contentHandlers: [MERMAID_PASTE_HANDLER],
  overlays: [
    // the layers take no clicks; their buttons and dialogs do (pointer-events on their own elements)
    { id: 'flow.handles', layer: 'screen', order: 40, pointer: 'none', component: FlowHandles },
    { id: 'flow.mermaid-paste', layer: 'screen', order: 61, pointer: 'none', component: MermaidPastePrompt },
    { id: 'flow.diagram-prompt', layer: 'screen', order: 62, pointer: 'none', component: DiagramPrompt },
  ],
  onMount: (ctx) => mountFlow(ctx),
}
