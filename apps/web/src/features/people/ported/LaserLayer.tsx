// OWNER: W6 (wave L, L6-1). The other sessions' lasers on the board: per person a tapered trail in their
// presence colour, smoothed and fading over about a second (./laser-path.ts), and a dot where the laser points
// while it is pressed. Read from `canvas.presence.lasers()` (CONTRACTS_REV 12 presence, relayed by the room to
// rev-12 tabs only); every role's laser shows, read-only reviewers' included. "Hide everyone's cursors"
// (workshops' setting) is read by the cursor layer, not here: pointing is deliberate, so lasers still show.
// Under reduced motion only the dot is drawn, without the fade. A scene overlay layer that takes no pointer
// events and shows in focus mode (a presentation), so a presenter's laser reaches everyone watching.
// Nothing here is written to the board.

import { useEffect, useReducer } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { safeColor } from '../../../lib/identity.ts'
import { untracked, useValue } from '../../../lib/signals.ts'
import { useMediaQuery } from '../../../ui/useMedia.ts'
import { LASER_DOT_PX, LASER_FADE_MS, laserShape } from './laser-path.ts'

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
/** Under reduced motion the layer looks again this often (no animation, only the dot coming and going). */
const REDUCED_RECHECK_MS = 200

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

type RemoteLaser = ReturnType<LobbyCanvas['presence']['lasers']>[number]

/** What changes when new samples arrive (the presence frames): one string, so a re-render happens only then. */
function laserStamp(lasers: readonly RemoteLaser[]): string {
  let s = ''
  for (const l of lasers)
    s += `${l.sid}:${l.points.length}:${l.points[l.points.length - 1]?.at ?? 0}:${l.active};`
  return s
}

export function LaserLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY)
  const stamp = useValue('people-lasers', () => laserStamp(canvas.presence.lasers()), [canvas])
  // a camera move moves every trail with the board
  useValue('people-lasers-view', () => canvas.viewport.get(), [canvas])
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  // the fade: a render per animation frame while anything is left to draw (a timer under reduced motion)
  useEffect(() => {
    if (!stamp) return
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const left = () => untracked(() => canvas.presence.lasers()).length > 0
    const step = () => {
      if (stopped) return
      redraw()
      if (!left()) return
      if (reduced) timer = setTimeout(step, REDUCED_RECHECK_MS)
      else raf = requestAnimationFrame(step)
    }
    if (reduced) timer = setTimeout(step, REDUCED_RECHECK_MS)
    else raf = requestAnimationFrame(step)
    return () => {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
    }
  }, [stamp, canvas, reduced])

  const lasers = untracked(() => canvas.presence.lasers())
  if (!lasers.length) return null
  const now = clock()
  const toOverlay = (p: { x: number; y: number }) => untracked(() => canvas.sceneToOverlay(p))
  const drawn = lasers.flatMap((l) => {
    const shape = laserShape(l.points, now, toOverlay, { keepNewest: l.active })
    if (!shape) return []
    const newest = l.points[l.points.length - 1]
    const fresh = l.active || (newest ? now - newest.at <= LASER_FADE_MS : false)
    return [{ l, shape, fresh, color: safeColor(l.color, l.uid) }]
  })
  if (!drawn.length) return null
  return (
    <svg
      data-testid="laser-layer"
      data-reduced-motion={reduced || undefined}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
      }}
    >
      {drawn.map(({ l, shape, fresh, color }) => (
        <g
          key={l.sid}
          data-testid="laser"
          data-sid={l.sid}
          data-uid={l.uid}
          data-color={color}
          data-points={shape.samples}
          data-active={l.active || undefined}
        >
          {!reduced && shape.d ? (
            <path data-testid="laser-path" d={shape.d} fill={color} fillOpacity={0.85} />
          ) : null}
          {fresh ? (
            <circle
              data-testid="laser-dot"
              cx={Math.round(shape.head.x * 10) / 10}
              cy={Math.round(shape.head.y * 10) / 10}
              r={LASER_DOT_PX}
              fill={color}
              stroke="#ffffff"
              strokeWidth={1.5}
            />
          ) : null}
        </g>
      ))}
    </svg>
  )
}
