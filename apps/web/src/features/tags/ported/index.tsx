// OWNER: 3d (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'tags' feature on the Excalidraw board page
// (the port of ../index.tsx; docs/EXCALIDRAW-MIGRATION.md §4.7 "Tags: Rewrite"; checklist COL-11,
// MAK-12's tag filter, PRS-13's tags column). Tags on sticky notes, file cards, images, shapes (mind-map
// topics) and free text:
//  - storage: one `customData.lobby['tag:<key>']` per tag on the element and the board's list as
//    lb_doc `tagDef:<key>` keys (canvas-schema custom-data.ts and doc.ts; the server takes a tag only
//    with its definition, so a new tag's definition is written first, in the same or an earlier push);
//  - chips on the elements: a `scene` layer over the canvas (./Chips.tsx), in scene units, full, dots or
//    hidden by zoom;
//  - the picker in the selection bar (3a's shell renders ./TagPicker.tsx `TagsBarButton`) and the
//    context menu (./menus.ts), drawn in the tags `screen` layer; the Tags dock panel (./TagsPanel.tsx:
//    filter, create, rename, colour, delete everywhere); "Show only #tag" (./Filter.tsx: a veil over the
//    canvas and the bar); search by tag (./search.ts, ./SearchTagFilter.tsx, for 3b's search panel) and
//    the CSV column (./csv.ts, for 3e's export).
// Permissions: whoever may edit the canvas may change tags; viewers and commenters see and filter them
// (their sessions are read-only on the sync server, which refuses their pushes). Name-only guests follow
// their link's role for the elements' tags, but the room refuses every guest's lb_doc write, so a guest
// can use the board's tags but not create one (a change request: docs/research/excalidraw/wave3/3D.md).
// The filter and the search are each person's own view.

import type {
  CanvasFeature,
  CanvasFeatureContext,
  CanvasPanelSpec,
  FeatureOverlaySpec,
  SelectionBarItemSpec,
} from '../../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../../lib/identity.ts'
import { useValue } from '../../../lib/signals.ts'
import { TagIcon } from '../icons.tsx'
import { setTags, type Tags, tagsOf } from './bridge.ts'
import { TagChipsLayer } from './Chips.tsx'
import { FilterBar, FilterVeilLayer } from './Filter.tsx'
import { TAGS_MENU } from './menus.ts'
import { TagsRuntime } from './runtime.ts'
import { barState, TAGS_PANEL_ID, TagPickerHost, TagsBarButton } from './TagPicker.tsx'
import { TagsPanel } from './TagsPanel.tsx'

export { TAGS_PANEL_ID }

/** The tags `screen` layer: the "Show only" bar and the picker (hidden in focus mode). */
function TagsScreen({ ctx }: { ctx: CanvasFeatureContext }) {
  const t = useValue('tags.bridge', () => tagsOf(ctx.canvas), [ctx.canvas])
  if (!t) return null
  return (
    <>
      <FilterBar rt={t.rt} />
      <TagPickerHost t={t} />
    </>
  )
}

const PANELS: readonly CanvasPanelSpec[] = [
  { id: TAGS_PANEL_ID, label: 'Tags', icon: () => <TagIcon />, order: 60, component: TagsPanel },
]

// pointer 'none': the layers' own boxes never take clicks; the bar and the picker do (../tags.css, ./tags.css)
const OVERLAYS: readonly FeatureOverlaySpec[] = [
  // the chips stay while presenting (they were part of the shapes on the tldraw page)
  {
    id: 'tags.chips',
    layer: 'scene',
    order: 6,
    pointer: 'none',
    focusMode: 'show',
    component: TagChipsLayer,
  },
  // above the chips, so the other elements' chips fade too; presenting suspends "Show only"
  { id: 'tags.filter', layer: 'scene', order: 7, pointer: 'none', component: FilterVeilLayer },
  { id: 'tags.screen', layer: 'screen', order: 26, pointer: 'none', component: TagsScreen },
]

const SELECTION_BAR: readonly SelectionBarItemSpec[] = [
  {
    id: 'tags',
    order: 50,
    visible: (ctx) => {
      const rt = tagsOf(ctx.canvas)?.rt
      return !!rt && barState(rt) !== null
    },
    component: TagsBarButton,
  },
]

function mount(ctx: CanvasFeatureContext): () => void {
  const rt = new TagsRuntime(ctx.canvas)
  const uninstall = rt.install()
  const t: Tags = { rt, ctx }
  setTags(ctx.canvas, t)
  const debug = window as unknown as { __lobbyTags?: Tags }
  // e2e and debugging only, behind the same local-dev guard as the board page's debug handle
  if (DEV_AUTH_ENABLED) debug.__lobbyTags = t
  return () => {
    uninstall()
    setTags(ctx.canvas, null)
    if (debug.__lobbyTags === t) debug.__lobbyTags = undefined
  }
}

export const feature: CanvasFeature = {
  id: 'tags',
  panels: PANELS,
  overlays: OVERLAYS,
  contextMenu: TAGS_MENU,
  selectionBar: SELECTION_BAR,
  commands: [
    {
      id: 'tags.picker',
      label: 'Tags…',
      readOnlyAllowed: true,
      enabled: (ctx) => {
        const rt = tagsOf(ctx.canvas)?.rt
        return !!rt && barState(rt) !== null
      },
      run: (ctx) => tagsOf(ctx.canvas)?.rt.openPicker(),
    },
  ],
  onMount: mount,
}
