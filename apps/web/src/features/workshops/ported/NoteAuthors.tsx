// OWNER: 3f. The note-author label on the Excalidraw page (CR-3F-4; decided at wave 3b: the feature that
// draws overlays on notes owns it, on the overlay layers registry). tldraw's note face drew the first name
// of the note's last editor in its bottom right corner (`.tl-note__attribution`); this scene layer draws
// the same label over every note on screen, from ./note-authors.ts, and nothing while the board's "Hide
// note authors" session setting is on (lb_doc `workshop`; the <html> attribute hides it too).
//
// The labels are laid out in scene units inside one box that the camera moves and scales (a pan
// re-renders one transform, not every label), each rotated with its note. Like the canvas ink, they are
// drawn through Excalidraw's dark-mode filter in dark mode. The layer takes no pointer events, so the
// canvas keeps every click on the note.
//
// Deviations from the tldraw note face: no hover tooltip with the whole name (a label that took the
// pointer would take the note's clicks; the name is the label's title for assistive tech); no label below
// MIN_LABEL_ZOOM (its 11 scene px would be under 3 px on screen: nothing is computed then, so zoomed-out
// views of big boards pay nothing) or on notes smaller than MIN_NOTE_PX on screen; exports never draw it
// (overlays are not exported, docs/research/excalidraw/wave3/3E.md item 11), whatever the setting.
import { memo, useMemo } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { THEME_FILTER } from '../../canvas-ux/ported/style-vocabulary.ts'
import { type NoteAuthor, noteAuthorsOf } from './note-authors.ts'
import { workshopSettingsOf } from './session-settings.ts'
import './note-authors.css'

/** Notes narrower than this on screen get no label (the +1 badges' limit). */
export const MIN_NOTE_PX = 56
/** Below this zoom no label is drawn: 11 scene px would be under 3 screen px (a default note under 56 px). */
export const MIN_LABEL_ZOOM = 0.28
/** Labels are kept this far (screen px) past the edges of the view, so a small pan shows them at once. */
const VIEW_MARGIN_PX = 200

export function NoteAuthorsLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const off = useValue('dr-wk-authors-off', () => workshopSettingsOf(canvas).hideNoteAuthors, [canvas])
  const far = useValue('dr-wk-authors-far', () => canvas.viewport.get().zoom < MIN_LABEL_ZOOM, [canvas])
  return off || far ? null : <NoteAuthors canvas={canvas} />
}

function NoteAuthors({ canvas }: { canvas: LobbyCanvas }) {
  // what to draw follows the elements (and this tab's editor); where, the camera
  const all = useValue(
    'dr-wk-authors',
    () =>
      noteAuthorsOf(canvas.items(), {
        get: (id) => canvas.get(id),
        hidden: (id) => canvas.isHidden(id),
        editing: canvas.editingId(),
      }),
    [canvas],
  )
  const shown = useValue('dr-wk-authors-shown', () => {
    const v = canvas.viewport.get()
    const m = VIEW_MARGIN_PX / v.zoom
    const out: string[] = []
    for (const a of all) {
      if (a.box.w * v.zoom < MIN_NOTE_PX) continue
      const r = Math.max(a.box.w, a.box.h) // a rotated note stays inside its circumscribed square
      const cx = a.box.x + a.box.w / 2
      const cy = a.box.y + a.box.h / 2
      if (cx + r < v.x - m || cx - r > v.x + v.width + m) continue
      if (cy + r < v.y - m || cy - r > v.y + v.height + m) continue
      out.push(a.id)
    }
    return out.join(' ')
  }, [canvas, all])
  const transform = useValue('dr-wk-authors-camera', () => {
    const o = canvas.sceneToOverlay({ x: 0, y: 0 })
    return `translate(${o.x}px, ${o.y}px) scale(${canvas.viewport.get().zoom})`
  }, [canvas])
  const dark = useValue('dr-wk-authors-theme', () => canvas.theme() === 'dark', [canvas])
  const list = useMemo(() => {
    const ids = new Set(shown ? shown.split(' ') : [])
    return all.filter((a) => ids.has(a.id))
  }, [all, shown])
  if (list.length === 0) return null
  return (
    <div
      className="dr-note-authors"
      data-testid="note-authors"
      style={{ transform, filter: dark ? THEME_FILTER : undefined }}
    >
      {list.map((a) => (
        <AuthorLabel key={a.id} author={a} />
      ))}
    </div>
  )
}

const AuthorLabel = memo(function AuthorLabel({ author: a }: { author: NoteAuthor }) {
  return (
    <div
      className="dr-note-author__box"
      style={{
        left: a.box.x,
        top: a.box.y,
        width: a.box.w,
        height: a.box.h,
        transform: a.angle ? `rotate(${a.angle}rad)` : undefined,
        opacity: a.opacity,
      }}
    >
      <span
        className="dr-note-author"
        data-testid="note-author"
        data-note-id={a.id}
        title={a.full}
        style={{ color: a.color }}
      >
        {a.short}
      </span>
    </div>
  )
}, sameAuthor)

function sameAuthor(a: { author: NoteAuthor }, b: { author: NoteAuthor }): boolean {
  const x = a.author
  const y = b.author
  return (
    x.id === y.id &&
    x.box.x === y.box.x &&
    x.box.y === y.box.y &&
    x.box.w === y.box.w &&
    x.box.h === y.box.h &&
    x.angle === y.angle &&
    x.short === y.short &&
    x.full === y.full &&
    x.color === y.color &&
    x.opacity === y.opacity
  )
}
