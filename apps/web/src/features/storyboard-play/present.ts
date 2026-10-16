// OWNER: WS3 (wave T). "Present storyboard": the presenter (present-export) presents a storyboard's panels as slides in
// storyboard order, through its one slides source (presenter.ts StartOptions.slides), with every rule of present mode
// (keys, Esc, focus mode, the view restored after). The animatic player is the local playback; this is the slide
// show of the same panels. A panel's slide title is its frame name, else its shot number.
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { getController } from '../present-export/ported/controller.ts'
import type { Slide } from '../present-export/slides.ts'
import { shotLabel, storyboardById } from './model.ts'

/** The panels of storyboard `id` as slides, in storyboard order (panels with no area left out). */
export function storyboardSlides(canvas: LobbyCanvas, id: string): Slide<string>[] {
  const view = storyboardById(canvas, id)
  if (!view) return []
  const out: Slide<string>[] = []
  for (const p of view.panels) {
    const b = p.bounds
    if (!b || !(b.width > 0 && b.height > 0)) continue
    out.push({
      id: p.id,
      name: p.name || shotLabel(p.number),
      bounds: { x: b.x, y: b.y, w: b.width, h: b.height },
    })
  }
  return out
}

/** Presents storyboard `id` (call from a user gesture: full screen needs it); false when there is nothing to show. */
export function presentStoryboard(canvas: LobbyCanvas, id: string): boolean {
  const presenter = getController(canvas).presenter
  if (presenter.isPresenting()) return false
  return presenter.start({ slides: () => storyboardSlides(canvas, id) }).ok
}
