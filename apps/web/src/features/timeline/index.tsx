// OWNER: WS5 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1). The 'timeline' feature
// on the Excalidraw board page: timeline frames (a frame carrying the `timeline` key), whose ruler (days, weeks or
// months), lanes (by assignee, status or tag), today marker and bars are an overlay drawn from the cards' `card:start`
// and `card:due`: nothing but the frame's own key is stored, so there is nothing to keep in sync and a receiving client
// writes nothing.
//
//  - ./Overlay.tsx: the `scene` layer; a bar drags (both dates) or resizes (one), a milestone moves its due date, in one
//    transaction (one undo step) written by the person who acts; a click opens WS4's card popover (`openCardPopover`),
//    a double-click zooms to the card; ←/→ and Shift+←/→ on a focused bar;
//  - ./Controls.tsx: the strip under a selected timeline (scale, lanes, tag, range, "Go to today");
//  - ./export.ts: the export layer `timeline` (PNG, SVG, vector PDF draw the same layout);
//  - ./commands.ts: the palette command `timeline.new`.
//
// While PLANNING_FLAGS.timeline is off the feature contributes nothing (the layer draws nothing, the command is not
// offered, the export layer is quiet) and the board page is exactly as before wave T. Writes (the command, a drag, the
// strip) are offered only where `planningOffered` says so: the switch, a rev-14 room, and an editor.
import type { CanvasFeature, CommandSpec, FeatureOverlaySpec } from '../../canvas/api/index.ts'
import { planningOffered, planningShown } from '../planning/index.ts'
import { registerExportOverlay } from '../present-export/ported/badges.ts'
import { createTimeline, TIMELINE_NEW_COMMAND_ID } from './commands.ts'
import { TIMELINE_EXPORT_LAYER } from './export.ts'
import { TimelineLayer } from './Overlay.tsx'

export const OVERLAYS: readonly FeatureOverlaySpec[] = [
  // under the comment pins and the review pills; the layer takes no clicks, its bars do (timeline.css)
  { id: 'timeline.layer', layer: 'scene', order: 8, pointer: 'none', component: TimelineLayer },
]

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: TIMELINE_NEW_COMMAND_ID,
    label: 'Timeline',
    group: 'Insert',
    keywords: ['timeline', 'gantt', 'schedule', 'plan', 'dates', 'calendar', 'cards', 'insert'],
    available: () => planningShown('timeline'),
    enabled: (ctx) => planningOffered('timeline', ctx.canvas),
    run: (ctx) => {
      const id = createTimeline(ctx)
      if (id === null)
        ctx.notify({
          key: 'timeline:new',
          tone: 'error',
          text: "Couldn't add a timeline here. Reload the board and try again.",
        })
    },
  },
]

export const feature: CanvasFeature = {
  id: 'timeline',
  overlays: OVERLAYS,
  commands: COMMANDS,
  // the export layer lives as long as the board page does (a board that is not open has no timeline to export)
  onMount: () => registerExportOverlay(TIMELINE_EXPORT_LAYER),
}
