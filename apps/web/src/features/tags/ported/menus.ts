// "Tags…" in the canvas context menu (3a's shell renders `contextMenu` entries; the port of
// ../ContextMenu.tsx), for a selection that holds something taggable. It opens the same picker as the
// selection bar's button. People who cannot edit get "Show tags" while the selection carries tags. The
// id keeps the tldraw item's test id (`context-menu.dr-tags-open`).

import type { CanvasFeatureContext, MenuEntrySpec } from '../../../canvas/api/index.ts'
import { tagsOf } from './bridge.ts'
import { elementTags } from './model.ts'

type Item = 'edit' | 'view' | null

export function contextItem(ctx: CanvasFeatureContext): Item {
  const rt = tagsOf(ctx.canvas)?.rt
  if (!rt) return null
  const els = rt.selectedElements()
  if (!els.length) return null
  if (!ctx.canvas.readOnly()) return rt.selectedTaggable().length ? 'edit' : null
  return els.some((el) => elementTags(el).length > 0) ? 'view' : null
}

export const TAGS_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'dr-tags-open',
    group: 'organize',
    order: 200,
    label: (ctx) => (contextItem(ctx) === 'view' ? 'Show tags' : 'Tags…'),
    visible: (ctx) => contextItem(ctx) !== null,
    // After the menu has closed and handed the focus back, so the picker keeps it.
    run: (ctx) => {
      setTimeout(() => tagsOf(ctx.canvas)?.rt.openPicker(), 0)
    },
  },
]
