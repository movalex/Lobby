// OWNER: W4 (wave L). The 'flow' feature on the Excalidraw board page: flow building and diagrams.
//
//  - L4-1 keyboard flow-building (./keys.ts, ./runtime.ts): Ctrl/Cmd+Arrow makes the next connected shape of the
//    one selected shape, Ctrl/Cmd+Shift+Arrow one of the last created kind; its editor opens through the text lease
//    with no key lost; the + handles (./Handles.tsx) do the same with the pointer, and drag to connect. Alt+Arrow
//    walks the connections (a11y's walk, told the arrow by ./runtime.ts) and the live region names them.
//  - L4-2 Diagram from words (../ai/diagram/DiagramPrompt.tsx): the AI group's "Diagram from words…" and the
//    command 'flow.diagram'.
//
// W3 registers it in features/canvas-registry.ts BEFORE a11y (its contextual Ctrl/Cmd+Shift+Arrow is asked first),
// through ./ported/index.tsx. With it absent, the board is exactly as before: the wave L chords stay blocked by the
// allowlist and Alt+Arrow walks the reading order.
import type { CanvasFeature } from '../../canvas/api/index.ts'
import { DIAGRAM_COMMAND, DIAGRAM_MENU, DiagramPrompt } from '../ai/diagram/DiagramPrompt.tsx'
import { FlowHandles } from './Handles.tsx'
import { FLOW_KEYS } from './keys.ts'
import { mountFlow } from './runtime.ts'

export const feature: CanvasFeature = {
  id: 'flow',
  keys: FLOW_KEYS,
  commands: [DIAGRAM_COMMAND],
  contextMenu: [DIAGRAM_MENU],
  overlays: [
    // the layers take no clicks; their buttons and dialogs do (pointer-events on their own elements)
    { id: 'flow.handles', layer: 'screen', order: 40, pointer: 'none', component: FlowHandles },
    { id: 'flow.diagram-prompt', layer: 'screen', order: 62, pointer: 'none', component: DiagramPrompt },
  ],
  onMount: (ctx) => mountFlow(ctx),
}
