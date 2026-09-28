// Feature module: tags (docs/WAVE4-CONTRACTS.md §2 tags; checklist COL-11, MAK-12's tag filter, PRS-13's
// tags column). Tags on sticky notes and file cards:
//  - storage: one meta key per tag on the shape and in the board's list on the document record
//    (@draftroom/contracts tags.ts; synced by the board's own sync, no API, no migration);
//  - chips on the shapes (ShapeWrapper.tsx: inside the shape, so they scale with zoom for free; full,
//    dots or hidden by zoom through one container attribute);
//  - the picker in the selection bar and the context menu (TagPicker.tsx, ContextMenu.tsx; canvas-ux
//    renders both hooks), the Tags dock panel (TagsPanel.tsx: filter, create, rename, colour, delete
//    everywhere), "Show only #tag" (Overlay.tsx), search by tag (SearchTagFilter.tsx, search.ts, used by
//    canvas-ux's search panel) and the CSV column (csv.ts, used by present-export).
// Permissions: whoever may edit the canvas may change tags; viewers and commenters see and filter them
// (their sessions are read-only on the sync server, which skips their writes). Name-only guests follow
// their board role like everyone else. The filter and the search are each person's own view.

import { react } from 'tldraw'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { TAGS_TRANSLATIONS } from './ContextMenu.tsx'
import { TagIcon } from './icons.tsx'
import { TagsOverlay } from './Overlay.tsx'
import { setTagsCtx, type TagsLod, tagsLodFor } from './runtime.ts'
import { TagShapeWrapper } from './ShapeWrapper.tsx'
import { TAGS_PANEL_ID } from './TagPicker.tsx'
import { TagsPanel } from './TagsPanel.tsx'
import './tags.css'

export const LOD_ATTR = 'data-dr-tags-lod'

/** One reactor per board: the chips' level of detail follows the (efficient) zoom level. */
function installChipLod(ctx: FeatureContext): () => void {
  const { editor } = ctx
  const container = editor.getContainer()
  let last: TagsLod | null = null
  const stop = react('dr-tags-lod', () => {
    const lod = tagsLodFor(editor.getEfficientZoomLevel())
    if (lod === last) return
    last = lod
    container.setAttribute(LOD_ATTR, lod)
  })
  return () => {
    stop()
    container.removeAttribute(LOD_ATTR)
  }
}

export const tagsFeature: BoardFeature = {
  id: 'tags',
  panels: [
    {
      id: TAGS_PANEL_ID,
      label: 'Tags',
      icon: <TagIcon />,
      Component: TagsPanel,
    },
  ],
  Overlay: TagsOverlay,
  components: { ShapeWrapper: TagShapeWrapper },
  overrides: { translations: { en: TAGS_TRANSLATIONS } },
  onMount(ctx) {
    setTagsCtx(ctx.editor, ctx)
    return installChipLod(ctx)
  },
}
