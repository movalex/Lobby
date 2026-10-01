// OWNER: 3d (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'mindmap' feature on the Excalidraw board page:
// mind maps: layout inside transact, keys, collapse (canvas.hide + the hit guard).
//
// Miro-style mind maps from plain canvas elements (the port of ../index.tsx; docs/EXCALIDRAW-MIGRATION.md
// §4.7): topics are rectangles with a bound label (a map may also start from a sticky note, an ellipse, a
// diamond or a free text), lines are bound elbow arrows, and the tree lives in `customData.lobby.mindmap`
// and `mindmapEdge` (./meta.ts). Everything syncs through the sync engine, so collaborators see every change
// live, and the server's read-only rule and text lease apply unchanged.
//
//  - Creating: the toolbar's "Mind map" (a tool whose activation starts a new map in the free space
//    nearest the view's centre), or "Start a mind map" (Alt+Shift+M, context menu).
//  - Keyboard-first editing (./keyboard.ts): Tab child, Enter sibling, Shift+Tab up a level, arrows to move
//    through the map, F2 to edit; keys typed before a new topic's editor opens are kept, and an empty new
//    topic left with Esc disappears.
//  - Automatic horizontal layout (../layout.ts), kept by the runtime's keeper (./runtime.ts).
//  - Collapse/expand with a count badge (hidden through `canvas.hide`: the render override, the hit guard,
//    Ctrl+A and box selection, exports).
//  - Delete takes the whole branch and asks above 10 topics.
//  - The outline as Markdown or CSV, following the board's export policy.
// Permissions: editors build maps; viewers, commenters and view/comment guests see them, move the
// selection with the arrow keys and export the outline when the board allows exporting. The server
// refuses canvas writes from read-only sessions, so the client checks are only for a quiet UI.

import type {
  CanvasFeature,
  CanvasFeatureContext,
  CommandSpec,
  FeatureToolSpec,
} from '../../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../../lib/identity.ts'
import { MindmapIcon } from '../icons.tsx'
import { mindmapOf, setMindmap } from './bridge.ts'
import {
  addChildTopic,
  addSiblingTopic,
  copyOutline,
  deleteSelection,
  downloadOutline,
  type Mindmap,
  newMindmap,
  promoteTopic,
  selectedMapRoot,
  selectedTopic,
  startMindmap,
  tidyMindmap,
  toggleTopicCollapsed,
} from './commands.ts'
import { watchExportPolicy } from './export-gate.ts'
import { MindmapKeyboard, mindmapKeys } from './keyboard.ts'
import { MINDMAP_MENU } from './menus.ts'
import { MINDMAP_EDGE_KEY, MINDMAP_KEY } from './meta.ts'
import { MindmapOverlay } from './Overlay.tsx'
import { MindmapRuntime } from './runtime.ts'

/** The toolbar's Mind map (a FeatureToolSpec: activating it starts a new map and returns to Select). */
export const MINDMAP_TOOL_ID = 'mindmap'

const on = (ctx: CanvasFeatureContext): Mindmap | null => mindmapOf(ctx.canvas)
const run = (fn: (m: Mindmap) => unknown) => (ctx: CanvasFeatureContext) => {
  const m = on(ctx)
  if (m) void fn(m)
}
const editing = (ctx: CanvasFeatureContext) => !ctx.canvas.readOnly() && on(ctx) !== null

const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'mindmap.start',
    label: 'Start a mind map',
    kbd: ['alt+shift+m'],
    enabled: editing,
    run: run(startMindmap),
  },
  { id: 'mindmap.new', label: 'Mind map', enabled: editing, run: run(newMindmap) },
  {
    id: 'mindmap.add-child',
    label: 'Add child topic',
    enabled: (ctx) => editing(ctx) && !!on(ctx) && selectedTopic((on(ctx) as Mindmap).rt) !== null,
    run: run(addChildTopic),
  },
  {
    id: 'mindmap.add-sibling',
    label: 'Add sibling topic',
    enabled: (ctx) => editing(ctx) && !!on(ctx) && selectedTopic((on(ctx) as Mindmap).rt) !== null,
    run: run(addSiblingTopic),
  },
  { id: 'mindmap.promote', label: 'Move up a level', enabled: editing, run: run(promoteTopic) },
  {
    id: 'mindmap.toggle-collapsed',
    label: 'Collapse or expand branch',
    enabled: editing,
    run: run((m) => toggleTopicCollapsed(m)),
  },
  { id: 'mindmap.tidy', label: 'Tidy up mind map', enabled: editing, run: run(tidyMindmap) },
  {
    id: 'mindmap.copy-outline',
    label: 'Copy outline (Markdown)',
    readOnlyAllowed: true,
    enabled: (ctx) => !!on(ctx) && selectedMapRoot((on(ctx) as Mindmap).rt) !== null,
    run: run((m) => copyOutline(m)),
  },
  {
    id: 'mindmap.download-md',
    label: 'Download outline as Markdown',
    readOnlyAllowed: true,
    enabled: (ctx) => !!on(ctx) && selectedMapRoot((on(ctx) as Mindmap).rt) !== null,
    run: run((m) => downloadOutline(m, 'md')),
  },
  {
    id: 'mindmap.download-csv',
    label: 'Download outline as CSV',
    readOnlyAllowed: true,
    enabled: (ctx) => !!on(ctx) && selectedMapRoot((on(ctx) as Mindmap).rt) !== null,
    run: run((m) => downloadOutline(m, 'csv')),
  },
  {
    // the board's Delete widened to whole branches, for 3a's Delete entry (the Delete key is ./keyboard.ts)
    id: 'mindmap.delete',
    label: 'Delete',
    enabled: (ctx) =>
      editing(ctx) && !!on(ctx) && (on(ctx) as Mindmap).rt.planDelete(ctx.canvas.selection) !== null,
    run: run(deleteSelection),
  },
]

const TOOL: FeatureToolSpec = {
  id: MINDMAP_TOOL_ID,
  label: 'Mind map',
  readOnlyAllowed: false,
  toolbar: { group: 'main', order: 70, icon: () => <MindmapIcon /> },
}

/**
 * Copies keep their originals' values (the key's default `relink` rule would drop them, having no ids
 * to relink them with): the runtime rewrites them as a map of their own right after the copy, in the same
 * undo step (./runtime.ts normalizeCopies), from the copies' own ids and the copied lines' bindings.
 */
const CUSTOM_DATA: NonNullable<CanvasFeature['customData']> = [
  { id: MINDMAP_KEY, match: 'exact', onDuplicate: (v) => structuredClone(v) },
  { id: MINDMAP_EDGE_KEY, match: 'exact', onDuplicate: (v) => structuredClone(v) },
]

function mount(ctx: CanvasFeatureContext): () => void {
  const { canvas } = ctx
  const rt = new MindmapRuntime(canvas)
  const uninstall = rt.install()
  const keys = new MindmapKeyboard(rt)
  const unkeys = keys.install()
  const gate = watchExportPolicy(ctx)
  const m: Mindmap = {
    rt,
    keys,
    gate,
    boardTitle: () => ctx.board.title,
    notify: (text, tone) =>
      ctx.notify({ key: 'mindmap-outline', text, tone, testId: 'mindmap-outline-notice', timeoutMs: 5000 }),
  }
  setMindmap(canvas, m)
  // The toolbar's Mind map is a button: activating the tool hands the canvas back to Select and then starts
  // a map. Only once Select is in: the engine clears the selection when its tool changes, which would
  // take the new topic's selection, and with it its editor, away.
  let startPending: ReturnType<typeof setTimeout> | null = null
  const start = () => {
    if (startPending === null) return
    clearTimeout(startPending)
    startPending = null
    newMindmap(m)
  }
  const offTool = canvas.on('toolChanged', (tool) => {
    if (tool === MINDMAP_TOOL_ID) {
      if (startPending !== null) return
      startPending = setTimeout(start, 250)
      canvas.setTool('select')
      return
    }
    if (startPending !== null) queueMicrotask(start)
  })
  const debug = window as unknown as { __lobbyMindmap?: Mindmap }
  // e2e and debugging only, behind the same local-dev guard as the board page's debug handle
  if (DEV_AUTH_ENABLED) debug.__lobbyMindmap = m
  return () => {
    offTool()
    if (startPending !== null) clearTimeout(startPending)
    gate.dispose()
    unkeys()
    uninstall()
    setMindmap(canvas, null)
    if (debug.__lobbyMindmap === m) debug.__lobbyMindmap = undefined
  }
}

export const feature: CanvasFeature = {
  id: 'mindmap',
  commands: COMMANDS,
  keys: mindmapKeys((ctx) => on(ctx)),
  tools: [TOOL],
  // pointer 'none': the layer's own box never takes clicks; its bar and badges do (mindmap.css)
  overlays: [{ id: 'mindmap', layer: 'screen', order: 24, pointer: 'none', component: MindmapOverlay }],
  contextMenu: MINDMAP_MENU,
  customData: CUSTOM_DATA,
  onMount: mount,
}
