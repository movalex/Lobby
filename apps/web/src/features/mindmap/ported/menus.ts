// The mind-map entries of the canvas context menu (3a's menu shell renders the `contextMenu` registry;
// the port of ../ContextMenuGroup.tsx, same entries and labels):
//  - "Start a mind map" for one note, text or shape that is not a topic yet (or on empty canvas);
//  - for one selected topic: add child / sibling, move up a level, collapse or expand, Tidy up;
//  - for a map in the selection: the outline (copy as Markdown, download as Markdown or CSV), unless the
//    board limits exporting for this person.
// Read-only people only get the outline.

import type { CanvasFeatureContext, MenuEntrySpec, MenuTarget } from '../../../canvas/api/index.ts'
import { mindmapOf } from './bridge.ts'
import { selectedMapRoot, selectedTopic, startableSelection } from './commands.ts'

/** The menu's view of the mind map for the selection it opened on. */
function stateOf(ctx: CanvasFeatureContext, _target: MenuTarget) {
  const m = mindmapOf(ctx.canvas)
  if (!m) return null
  const { rt } = m
  const readonly = ctx.canvas.readOnly()
  const topic = selectedTopic(rt)
  const meta = topic ? rt.metaOf(topic) : null
  const node = topic ? rt.treeOfTopic(topic)?.nodes.get(topic) : undefined
  return {
    readonly,
    start: !readonly && (startableSelection(rt) !== null || ctx.canvas.selection.length === 0),
    topic: topic !== null,
    canPromote: !!node && node.depth >= 2,
    hasChildren: !!node && node.children.length > 0,
    collapsed: !!meta?.collapsed,
    map: selectedMapRoot(rt) !== null,
    exportOk: m.gate.allowed(),
  }
}

const when =
  (test: (s: NonNullable<ReturnType<typeof stateOf>>) => boolean) =>
  (ctx: CanvasFeatureContext, t: MenuTarget) => {
    const s = stateOf(ctx, t)
    return !!s && test(s)
  }

export const MINDMAP_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'mindmap.start',
    group: 'organize',
    order: 100,
    label: 'Start a mind map',
    command: 'mindmap.start',
    visible: when((s) => s.start),
  },
  {
    id: 'mindmap.add-child',
    group: 'organize',
    order: 101,
    label: 'Add child topic',
    command: 'mindmap.add-child',
    kbdHint: 'tab',
    visible: when((s) => !s.readonly && s.topic),
  },
  {
    id: 'mindmap.add-sibling',
    group: 'organize',
    order: 102,
    label: 'Add sibling topic',
    command: 'mindmap.add-sibling',
    kbdHint: 'enter',
    visible: when((s) => !s.readonly && s.topic),
  },
  {
    id: 'mindmap.promote',
    group: 'organize',
    order: 103,
    label: 'Move up a level',
    command: 'mindmap.promote',
    kbdHint: 'shift+tab',
    visible: when((s) => !s.readonly && s.topic && s.canPromote),
  },
  {
    id: 'mindmap.toggle-collapsed',
    group: 'organize',
    order: 104,
    label: (ctx, t) => (stateOf(ctx, t)?.collapsed ? 'Expand branch' : 'Collapse branch'),
    command: 'mindmap.toggle-collapsed',
    visible: when((s) => !s.readonly && s.topic && s.hasChildren),
  },
  {
    id: 'mindmap.tidy',
    group: 'organize',
    order: 105,
    label: 'Tidy up mind map',
    command: 'mindmap.tidy',
    visible: when((s) => !s.readonly && s.map),
  },
  {
    id: 'mindmap.outline',
    group: 'organize',
    order: 106,
    label: 'Mind map outline',
    visible: when((s) => s.map && s.exportOk),
    submenu: [
      {
        id: 'mindmap.copy-outline',
        group: 'organize',
        order: 0,
        label: 'Copy outline (Markdown)',
        command: 'mindmap.copy-outline',
      },
      {
        id: 'mindmap.download-md',
        group: 'organize',
        order: 1,
        label: 'Download outline as Markdown',
        command: 'mindmap.download-md',
      },
      {
        id: 'mindmap.download-csv',
        group: 'organize',
        order: 2,
        label: 'Download outline as CSV',
        command: 'mindmap.download-csv',
      },
    ],
  },
]
