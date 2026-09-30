// Making sticky notes from canvas-ux on the Excalidraw canvas: a double-click on empty canvas (RETRO-21b),
// Tab and friends while editing a note (the next note beside, before, below or above: tldraw's note
// behaviour, RETRO-09), and the frame a new note goes into. Every new note is one `transact` (one undo
// step) and its editor opens through the text lease (`text.edit`).
//
// A note's colour: a new note beside another takes that note's colour (tldraw's); a note from a
// double-click takes Lobby's default (the note tool's own default, canvas/tools).
import type {
  Bounds,
  CanvasElement,
  CanvasFeatureContext,
  EditVia,
  LobbyCanvas,
  ScenePoint,
} from '../../../canvas/api/index.ts'
import { geometry } from '../../../canvas/api/index.ts'
import { isPrintableKey } from '../keys.ts'

/** Lobby's note size (canvas/tools/notes.ts LOBBY_NOTE_SIZE, §2.11). */
export const NOTE_SIZE = 200
/** The gap between a note and the one Tab makes next to it (tldraw's ADJACENT_NOTE_MARGIN). */
export const NOTE_GAP = 20

const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** The innermost frame whose area holds `point` (smallest first), or null. */
export function frameAt(
  canvas: Pick<LobbyCanvas, 'items' | 'bounds'>,
  point: ScenePoint,
  opts: { unlockedOnly?: boolean } = {},
): CanvasElement | null {
  let best: { el: CanvasElement; area: number } | null = null
  for (const el of canvas.items()) {
    if (el.type !== 'frame' || !live(el)) continue
    if (opts.unlockedOnly && el.locked) continue
    const b = canvas.bounds(el.id)
    if (!b || !geometry.containsPoint(b, point)) continue
    const area = b.width * b.height
    if (!best || area < best.area) best = { el, area }
  }
  return best?.el ?? null
}

/**
 * Creates a note with its top-left at `topLeft` (inside `frameId` when given), selects it and opens its
 * editor. Returns its id, or null on a read-only board.
 */
export function createNote(
  ctx: CanvasFeatureContext,
  opts: {
    topLeft: ScenePoint
    size?: number
    backgroundColor?: string
    frameId?: string | null
    via: EditVia
    label?: string
  },
): string | null {
  const { canvas } = ctx
  if (canvas.readOnly()) return null
  const size = opts.size ?? NOTE_SIZE
  const id = canvas.transact(opts.label ?? 'create note', (tx) => {
    const nid = tx.create('note', {
      x: opts.topLeft.x,
      y: opts.topLeft.y,
      size,
      ...(opts.backgroundColor ? { backgroundColor: opts.backgroundColor } : {}),
    })
    if (opts.frameId) tx.setFrame([nid], opts.frameId)
    return nid
  })
  canvas.select([id])
  void canvas.text.edit(id, { via: opts.via, caret: 'end' })
  return id
}

/** RETRO-21b: a note centred on `point`, inside the unlocked frame there. */
export function createNoteAt(ctx: CanvasFeatureContext, point: ScenePoint): string | null {
  const frame = frameAt(ctx.canvas, point, { unlockedOnly: true })
  return createNote(ctx, {
    topLeft: { x: point.x - NOTE_SIZE / 2, y: point.y - NOTE_SIZE / 2 },
    frameId: frame?.id ?? null,
    via: 'double-click',
  })
}

export type NoteDirection = 'right' | 'left' | 'below' | 'above'

/** Where the next note goes from `from` (its top-left), `size` the note's side. Pure. */
export function adjacentSpot(from: Bounds, dir: NoteDirection, size = from.width): ScenePoint {
  switch (dir) {
    case 'right':
      return { x: from.x + from.width + NOTE_GAP, y: from.y }
    case 'left':
      return { x: from.x - NOTE_GAP - size, y: from.y }
    case 'below':
      return { x: from.x, y: from.y + from.height + NOTE_GAP }
    case 'above':
      return { x: from.x, y: from.y - NOTE_GAP - size }
  }
}

/** Keys typed between leaving one note and the next one's editor asking for its lease (RETRO-09). */
interface Pending {
  text: string
  done: boolean
}

/**
 * Tab (right), Shift+Tab (left), Ctrl/Cmd+Enter (below), Ctrl/Cmd+Shift+Enter (above) while editing a
 * note: closes this editor, then edits the note already there, or a new one of the same size and colour
 * in the same frame. Keys typed meanwhile are kept and replayed into it, in order.
 */
export function editAdjacentNote(ctx: CanvasFeatureContext, dir: NoteDirection): boolean {
  const { canvas } = ctx
  const fromId = canvas.editingId()
  const from = fromId ? canvas.get(fromId) : undefined
  const b = fromId ? canvas.bounds(fromId) : null
  if (from?.type !== 'stickynote' || !b || canvas.readOnly()) return false
  const size = from.width
  const spot = adjacentSpot(b, dir, size)
  const centre = { x: spot.x + size / 2, y: spot.y + size / 2 }
  const p: Pending = { text: '', done: false }
  // until the next editor asks for its lease (the lease flow buffers from then on), printable keys wait
  // here: they must not reach the note just left (type-to-edit) or the tool letters
  const win = canvas.container()?.ownerDocument.defaultView ?? window
  const onKey = (e: KeyboardEvent) => {
    if (p.done || !isPrintableKey(e)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    p.text += e.key
  }
  win.addEventListener('keydown', onKey, true)
  const open = () => {
    if (p.done) return
    p.done = true
    win.removeEventListener('keydown', onKey, true)
    const existing = canvas
      .items()
      .find((e) => e.type === 'stickynote' && live(e) && e.id !== from.id && hitsBounds(canvas, e.id, centre))
    const initialText = p.text || undefined
    if (existing) {
      canvas.select([existing.id])
      void canvas.text.edit(existing.id, {
        via: 'api',
        caret: 'end',
        ...(initialText ? { initialText } : {}),
      })
      return
    }
    const id = canvas.transact('create note', (tx) => {
      const nid = tx.create('note', {
        x: spot.x,
        y: spot.y,
        size,
        backgroundColor: (from as { backgroundColor?: string }).backgroundColor,
      })
      if (from.frameId) tx.setFrame([nid], from.frameId)
      return nid
    })
    canvas.select([id])
    void canvas.text.edit(id, { via: 'api', caret: 'end', ...(initialText ? { initialText } : {}) })
  }
  // the editor closes first (its words are one undo step), then the next note opens
  const off = canvas.on('editingChanged', (id) => {
    if (id !== null) return
    off()
    clearTimeout(timer)
    open()
  })
  const timer = setTimeout(() => {
    off()
    open()
  }, 1500)
  canvas.text.stop()
  if (canvas.editingId() === null) {
    off()
    clearTimeout(timer)
    open()
  }
  return true
}

function hitsBounds(canvas: LobbyCanvas, id: string, p: ScenePoint): boolean {
  const b = canvas.bounds(id)
  return !!b && geometry.containsPoint(b, p)
}
