// OWNER: WS5 (wave T). "Timeline" (palette command `timeline.new`): a new timeline frame in the empty space nearest the
// middle of the view, in one transaction (one undo step), selected and brought into view. Its range starts on this
// week's Monday and runs twelve weeks, by week, with a lane per status; the strip under the frame changes all of it.
import { TIMELINE_KEY, type TimelineValue } from '@draftroom/canvas-schema/planning'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { findEmptySpot, type Rect } from '../canvas-ux/placement.ts'
import { planningOffered } from '../planning/index.ts'
import { addDays, mondayOf, todayOf } from './dates.ts'

export const TIMELINE_NEW_COMMAND_ID = 'timeline.new'
/** a new timeline frame's size (scene units): a week is 100 units wide with room for the lane labels */
export const NEW_TIMELINE_SIZE = { width: 1400, height: 520 } as const
export const NEW_TIMELINE_WEEKS = 12

/** The value of a new timeline starting in the week of `today`. */
export function newTimelineValue(today: string = todayOf()): TimelineValue {
  const start = mondayOf(today) ?? today
  const end = addDays(start, NEW_TIMELINE_WEEKS * 7 - 1) ?? start
  return { start, end, scale: 'week', lanes: 'status' }
}

/** Makes the timeline frame; returns its id, or null when this page may not write planning keys. */
export function createTimeline(ctx: CanvasFeatureContext, today: string = todayOf()): string | null {
  const { canvas } = ctx
  if (!planningOffered('timeline', canvas)) return null
  const vp = canvas.viewport.get()
  const obstacles: Rect[] = []
  for (const el of canvas.items()) {
    if (el.type === 'text' && el.containerId) continue
    const b = canvas.bounds(el.id)
    if (b) obstacles.push({ x: b.x, y: b.y, w: b.width, h: b.height })
  }
  const at = findEmptySpot(
    { w: NEW_TIMELINE_SIZE.width, h: NEW_TIMELINE_SIZE.height },
    { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 },
    obstacles,
  )
  const id = canvas.transact('New timeline', (tx) =>
    tx.create('frame', {
      x: Math.round(at.x),
      y: Math.round(at.y),
      width: NEW_TIMELINE_SIZE.width,
      height: NEW_TIMELINE_SIZE.height,
      name: 'Timeline',
      customData: { lobby: { [TIMELINE_KEY]: newTimelineValue(today) } },
    }),
  )
  canvas.select([id])
  const b = canvas.bounds(id)
  if (b) canvas.viewport.ensureVisible(b, { animate: true, margin: 64 })
  return id
}
