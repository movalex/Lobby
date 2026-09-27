// COL-07: the main toolbar holds Select, Hand, Note, Text, Shape, Pen, Connector, Frame, Insert file,
// Comment (when the comments feature registers its tool) and Templates, in that fixed order;
// everything else (eraser, other geo shapes, line, highlighter, laser) is one level down in the
// overflow ("More"). tldraw's DefaultToolbar keeps the order and shows the most recently used overflow
// tool as one extra slot at the end, so the main tools never move (PRF-09).

import { DefaultToolbar, TldrawUiMenuToolItem, ToolbarItem, useEditor, useTools, useValue } from 'tldraw'
import { activePanel } from './bridge.ts'
import { PANEL, TEMPLATES_TOOL_ID } from './overrides.tsx'

/**
 * The comment tool is registered by the comments feature (tldraw's own 'comment' id is licence-gated,
 * so it may use another id). Any tool flagged `meta.draftroomToolbar` also gets a main slot.
 */
const COMMENT_TOOL_IDS = ['dr-comment', 'comment'] as const

const MAIN_TOOLS = ['select', 'hand', 'note', 'text', 'rectangle', 'draw', 'arrow', 'frame'] as const
const OVERFLOW_TOOLS = [
  'eraser',
  'ellipse',
  'triangle',
  'diamond',
  'hexagon',
  'oval',
  'rhombus',
  'star',
  'cloud',
  'heart',
  'x-box',
  'check-box',
  'arrow-left',
  'arrow-up',
  'arrow-down',
  'arrow-right',
  'line',
  'highlight',
  'laser',
] as const

export function DraftroomToolbar() {
  const tools = useTools()
  const editor = useEditor()
  const templatesOpen = useValue('dr-templates-open', () => activePanel(editor).get() === PANEL.templates, [
    editor,
  ])
  const commentTool = COMMENT_TOOL_IDS.find((id) => tools[id])
  const flagged = Object.values(tools)
    .filter((t) => t.meta?.draftroomToolbar === true && t.id !== commentTool && t.id !== TEMPLATES_TOOL_ID)
    .map((t) => t.id)
  const main = [
    ...MAIN_TOOLS.filter((id) => tools[id]),
    'asset',
    ...(commentTool ? [commentTool] : []),
    ...flagged,
  ]
  const count = main.length + (tools[TEMPLATES_TOOL_ID] ? 1 : 0)
  return (
    <DefaultToolbar minItems={5} maxItems={count} minSizePx={320} maxSizePx={560}>
      {MAIN_TOOLS.map((id) => (tools[id] ? <ToolbarItem key={id} tool={id} /> : null))}
      {/* Insert file: an action-like tool (never "selected"), as in tldraw's own toolbar. */}
      <TldrawUiMenuToolItem toolId="asset" />
      {commentTool && <ToolbarItem tool={commentTool} />}
      {flagged.map((id) => (
        <ToolbarItem key={id} tool={id} />
      ))}
      <TldrawUiMenuToolItem toolId={TEMPLATES_TOOL_ID} isSelected={templatesOpen} />
      {OVERFLOW_TOOLS.map((id) => (tools[id] ? <ToolbarItem key={id} tool={id} /> : null))}
    </DefaultToolbar>
  )
}
