// K7-4: where each AI result will land, as a placeholder plan (./shimmer.ts), worked out when a request
// starts. Reads the board only; nothing is ever written. A summary lands in the private panel (no board
// placeholder); everything else has a place: the notes' block, the sub-topics beside the topic, the new map's
// spot, the notes about to be regrouped.

import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { DEFAULT_LAYOUT } from '../../mindmap/layout.ts'
import { mindmapOf } from '../../mindmap/ported/bridge.ts'
import { levelStyle } from '../../mindmap/ported/style.ts'
import { ideasHeading } from '../copy.ts'
import { previewNotes } from './apply.ts'
import type { AiRequest } from './runtime.ts'
import { mapTiles, pillTiles, regionTile, type ShimmerPlan } from './shimmer.ts'
import type { AiTarget } from './target.ts'

/** Action items: a typical answer has about this many. */
export const ACTION_ITEMS_GUESS = 5

/** The room a drafted map takes: a hub with a ring of branches (about 760 px wide). */
export const MAP_ROOM_W = 760
const mapRoomH = (branches: number) => Math.max(280, 72 * Math.ceil(branches / 2))

/** The sub-topics' column beside the topic (right of it, or left on the left side of the map). */
function expandLanding(canvas: LobbyCanvas, topicId: string, count: number): ShimmerPlan | null {
  const m = mindmapOf(canvas)
  const tree = m?.rt.treeOfTopic(topicId)
  const node = tree?.nodes.get(topicId)
  if (!tree || !node) return null
  const depth = node.depth + 1
  const st = levelStyle(depth)
  const h = count * st.minH + (count - 1) * DEFAULT_LAYOUT.vGap(depth)
  // the central topic's new branches go to the lighter side; deeper topics grow away from the centre
  let side = node.side
  if (node.parentId === null) {
    const kids = node.children.map((c) => tree.nodes.get(c)?.side)
    side =
      kids.filter((s) => s === 'left').length < kids.filter((s) => s === 'right').length ? 'left' : 'right'
  }
  const gap = DEFAULT_LAYOUT.hGap(depth)
  const x = side === 'right' ? node.box.x + node.box.w + gap : node.box.x - gap - st.minW
  const rect = { x, y: node.box.y + node.box.h / 2 - h / 2, w: st.minW, h }
  return pillTiles(rect, count)
}

function mapLanding(canvas: LobbyCanvas, count: number): ShimmerPlan | null {
  const m = mindmapOf(canvas)
  if (!m) return null
  const room = { w: MAP_ROOM_W, h: mapRoomH(count) }
  const box = m.rt.previewMapRect(room)
  return mapTiles({ x: box.x, y: box.y, w: box.w, h: box.h }, count)
}

/** The placeholder for `req` on `target`, or null (a summary, or nowhere to point at). */
export function landingFor(canvas: LobbyCanvas, req: AiRequest, target: AiTarget): ShimmerPlan | null {
  switch (req.action) {
    case 'summarize':
      return null
    case 'themes': {
      const b = target.bounds
      return b ? regionTile({ x: b.x - 12, y: b.y - 12, w: b.width + 24, h: b.height + 24 }) : null
    }
    case 'actions':
      return previewNotes(canvas, target, {
        heading: 'Action items',
        count: ACTION_ITEMS_GUESS,
        kind: 'action-item',
      })
    case 'ideas': {
      const count = req.count ?? 6
      if (req.into?.kind === 'expand') return expandLanding(canvas, req.into.topicId, count)
      if (req.into?.kind === 'mindmap') return mapLanding(canvas, count)
      return previewNotes(canvas, target, { heading: ideasHeading(req.prompt), count, kind: 'idea' })
    }
  }
}
