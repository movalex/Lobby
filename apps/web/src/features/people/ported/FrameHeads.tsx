// OWNER: W6 (wave L, L6-2). Face piles on frames: beside each frame's top right corner, the faces of the people
// looking at it (the innermost frame that holds the centre of their view, ./frame-heads.ts), at most three and
// "+N". Presence-derived and read-only (nothing is written or sent). Hidden with the cursors (`cursorVisible`:
// present mode, "hide everyone's cursors"), except the person presenting to everyone, whose face stays so the
// room can find them. The engine draws the frame names (canvas/lod/frame-names.ts is not involved); a frame
// too small on screen gets no pile. Only the people the room streams to this tab count: the label says "near
// you", never a board total.

import type { CSSProperties } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { initialsFor, safeColor } from '../../../lib/identity.ts'
import { useValue } from '../../../lib/signals.ts'
import { getLive } from '../../present-export/live/ported/controller.ts'
import { frameHeads, type HeadFrame } from './frame-heads.ts'

/** Faces drawn per frame (the rest is "+N"). */
export const FRAME_HEADS_SHOWN = 3
/** A frame narrower than this on screen gets no pile (px). */
const MIN_FRAME_PX = 120

/** A frame element's name, or empty. */
const nameOf = (e: unknown): string => {
  const n = (e as { name?: unknown }).name
  return typeof n === 'string' ? n : ''
}

interface Frame extends HeadFrame {
  readonly name: string
}

export function FrameHeads({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas, registries } = ctx
  const frames = useValue(
    'people-frame-heads-frames',
    (): Frame[] =>
      // wave N.1: the live frames from the scene index (no walk of the whole scene per change)
      canvas.index
        .byType('frame')
        .filter((e) => !canvas.isHidden(e.id))
        .map((e) => ({
          id: e.id,
          x: e.x,
          y: e.y,
          width: e.width,
          height: e.height,
          name: nameOf(e),
        })),
    [canvas],
  )
  const presenterUid = useValue(
    'people-frame-heads-presenter',
    () => getLive(registries)?.store.presentation.get()?.presenter.userId ?? null,
    [registries],
  )
  const piles = useValue('people-frame-heads', () => {
    if (!frames.length) return []
    const peers = canvas.presence
      .peers()
      .filter(
        (p) =>
          p.streaming !== false && p.view && (registries.cursorVisible.call(p.sid) || p.uid === presenterUid),
      )
    const heads = frameHeads(frames, peers)
    const zoom = canvas.viewport.get().zoom
    const out: { frame: Frame; at: { x: number; y: number }; people: typeof peers }[] = []
    for (const f of frames) {
      const people = heads.get(f.id)
      if (!people?.length || f.width * zoom < MIN_FRAME_PX) continue
      out.push({ frame: f, at: canvas.sceneToOverlay({ x: f.x + f.width, y: f.y }), people })
    }
    return out
  }, [canvas, registries, frames, presenterUid])
  if (!piles.length) return null
  return (
    <>
      {piles.map(({ frame, at, people }) => {
        const shown = people.slice(0, FRAME_HEADS_SHOWN)
        const more = people.length - shown.length
        const n = people.length
        const label = `${n} ${n === 1 ? 'person' : 'people'} near you looking at ${frame.name || 'this frame'}`
        return (
          <div
            key={frame.id}
            className="dr-frame-heads"
            data-testid="frame-heads"
            data-frame-id={frame.id}
            data-count={n}
            role="img"
            aria-label={label}
            title={`${people.map((p) => p.name).join(', ')} (near you)`}
            style={
              {
                position: 'absolute',
                left: Math.round(at.x),
                top: Math.round(at.y),
              } as CSSProperties
            }
          >
            {shown.map((p) => (
              <span
                key={p.uid}
                className="dr-frame-heads__face"
                data-uid={p.uid}
                style={{ background: safeColor(p.color, p.uid) }}
              >
                {initialsFor(p.name)}
              </span>
            ))}
            {more > 0 ? <span className="dr-frame-heads__more">+{more}</span> : null}
          </div>
        )
      })}
    </>
  )
}
