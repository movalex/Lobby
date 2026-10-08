// K7-4: the 2 to 3 seconds of an AI request made to feel deliberate. While it runs, a shimmer placeholder
// shows where the result will land (./landing.ts works the place out when the request starts); when the
// result is on the board, the new elements are highlighted for a moment. Both are pictures in the AI overlay
// layer: they read the camera and the elements' bounds and write nothing to the board, ever. Under reduced
// motion the placeholder stands still and the highlight is not drawn.
//
// The two views are plain components of pixel boxes (unit-tested by rendering them); the connected ones
// below read the job, the flash and the camera from the signals of ./runtime.ts.

import { useEffect, useMemo, useState } from 'react'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { aiFlash, aiJob } from './runtime.ts'
import { onScreen, type Rect, type ShimmerTile, toPixels } from './shimmer.ts'

export interface PxTile extends Rect {
  shape: ShimmerTile['shape']
}

/** Boxes drawn for a highlight at most. */
export const FLASH_MAX_BOXES = 40
/** Pixels a highlight reaches past an element's edge. */
const FLASH_PAD = 4

/** The placeholder: one block per thing the result will make. `still`: reduced motion, no animation. */
export function ShimmerView({
  tiles,
  action,
  still,
}: {
  tiles: readonly PxTile[]
  action: string
  still: boolean
}) {
  if (!tiles.length) return null
  return (
    <div
      className="dr-ai-shimmer"
      data-testid="ai-shimmer"
      data-action={action}
      data-motion={still ? 'still' : 'shimmer'}
      aria-hidden="true"
    >
      {tiles.map((t, i) => (
        <span
          key={i}
          className={`dr-ai-shimmer__tile dr-ai-shimmer__tile--${t.shape}`}
          style={{ left: t.x, top: t.y, width: t.w, height: t.h, animationDelay: `${(i % 6) * 90}ms` }}
        />
      ))}
    </div>
  )
}

/** The highlight of what a result just wrote. Nothing under reduced motion. */
export function FlashView({ boxes, still }: { boxes: readonly Rect[]; still: boolean }) {
  if (still || !boxes.length) return null
  return (
    <div className="dr-ai-flash" data-testid="ai-flash" aria-hidden="true">
      {boxes.map((b, i) => (
        <span
          key={i}
          className="dr-ai-flash__box"
          style={{
            left: b.x - FLASH_PAD,
            top: b.y - FLASH_PAD,
            width: b.w + 2 * FLASH_PAD,
            height: b.h + 2 * FLASH_PAD,
          }}
        />
      ))}
    </div>
  )
}

/** Whether the person asks the system for less motion (it follows the setting while the page is open). */
export function useReducedMotion(doc: Document): boolean {
  const mq = useMemo(() => doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null, [doc])
  const [still, setStill] = useState(mq?.matches ?? false)
  useEffect(() => {
    if (!mq) return
    const on = () => setStill(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [mq])
  return still
}

/** A JSON value selector: re-renders only when the content changes, not on every camera tick. */
function useJson<T>(name: string, fn: () => T, deps: readonly unknown[]): T {
  const json = useValue(name, () => JSON.stringify(fn() ?? null), deps)
  return useMemo(() => JSON.parse(json) as T, [json])
}

/** The placeholder of the running request, in screen pixels (follows the camera). */
export function AiShimmer({ canvas }: { canvas: LobbyCanvas }) {
  const doc = canvas.container()?.ownerDocument ?? document
  const still = useReducedMotion(doc)
  const shown = useJson<{ action: string; tiles: PxTile[] } | null>('lobby-ai-shimmer', () => {
    const job = aiJob(canvas).get()
    const plan = job?.landing
    if (!job || !plan) return null
    canvas.viewport.get()
    const screen = canvas.viewport.screenRect()
    const tiles = plan.tiles
      .map((t) => ({ ...toPixels(t, (p) => canvas.sceneToOverlay(p)), shape: t.shape }))
      .filter((t) => onScreen(t, screen.width, screen.height))
    return { action: job.action, tiles }
  }, [canvas])
  if (!shown) return null
  return <ShimmerView tiles={shown.tiles} action={shown.action} still={still} />
}

/** The highlight of the latest result, in screen pixels (follows the camera, gone after a moment). */
export function AiFlash({ canvas }: { canvas: LobbyCanvas }) {
  const doc = canvas.container()?.ownerDocument ?? document
  const still = useReducedMotion(doc)
  const boxes = useJson<Rect[]>('lobby-ai-flash-boxes', () => {
    const flash = aiFlash(canvas).get()
    if (!flash || still) return []
    canvas.viewport.get()
    const screen = canvas.viewport.screenRect()
    const out: Rect[] = []
    for (const id of flash.ids) {
      if (out.length >= FLASH_MAX_BOXES) break
      const b = canvas.bounds(id)
      if (!b) continue
      const px = toPixels({ x: b.x, y: b.y, w: b.width, h: b.height }, (p) => canvas.sceneToOverlay(p))
      if (onScreen(px, screen.width, screen.height)) out.push(px)
    }
    return out
  }, [canvas, still])
  return <FlashView boxes={boxes} still={still} />
}
