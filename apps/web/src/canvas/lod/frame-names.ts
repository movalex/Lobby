/**
 * W5-51 (wave C): frame names that would run into a neighbouring frame are hidden, from the level-of-detail
 * pass (./index.ts installs this next to the frame bitmaps).
 *
 * Excalidraw draws each frame's name as a DOM label just above the frame's top edge, always 14 px high
 * whatever the zoom, and already cuts it to the frame's width with an ellipsis (App.renderFrameNames:
 * `maxWidth` = the frame's width on screen, `textOverflow: ellipsis`). Zoomed out (about 14 % on a template
 * board) the gap between two frames stacked one above the other gets smaller than the name, so the lower
 * frame's name covered the bottom of the frame above it: the titles ran into one another just where people
 * orient themselves. Nothing of the engine positions a name per frame, so the rule is a stylesheet of
 * Lobby's: a name whose box overlaps a neighbouring frame, or a name kept before it (top first), is hidden
 * (`visibility: hidden`, so the engine's own layout is untouched). The frame above keeps its name; a name
 * comes back as soon as it fits again (zoomed in, the frames moved apart). The name being edited is never
 * hidden. A frame that the named frame lies inside or overlaps is not a neighbour: a frame inside another
 * (a converted tldraw board lifts nested frames, so they sit inside their parent) or laid over one by hand
 * keeps its name at every zoom, where the name necessarily sits on the frame around it. Nothing here writes
 * to the document or the engine's state.
 *
 * The stylesheet is a `<style>` element written with `textContent`: it needs the CSP's style-src
 * 'unsafe-inline' (render.yaml), as ../overrides.ts's stylesheet does.
 *
 * `crowdedFrameNames` is the rule, pure and Node-tested (./frame-names.test.ts); `installFrameNameGuard` reads
 * the names' boxes from the DOM after the engine has drawn them (one animation frame after a camera move or
 * a scene change) and writes the stylesheet. Browser only for the install.
 */
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { noteSceneWalk } from '../api/parts/scene-index.ts'

export interface NameBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface FrameNameBoxes {
  readonly id: string
  /** the frame on screen */
  readonly frame: NameBox
  /** its name's label on screen, or null when the engine draws none now (out of view, names off) */
  readonly name: NameBox | null
  /** the name is being edited: always shown */
  readonly editing?: boolean
}

const overlaps = (a: NameBox, b: NameBox) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * The frames whose name to hide: a name that overlaps a neighbouring frame (one whose box does not meet the
 * named frame's own: a frame it lies inside or overlaps is not a neighbour), or a name kept before it
 * (names are taken top first, then left first, so the upper of two crowded names stays). Pure.
 */
export function crowdedFrameNames(frames: readonly FrameNameBoxes[]): Set<string> {
  const hidden = new Set<string>()
  const kept: NameBox[] = []
  const named = frames
    .filter((f): f is FrameNameBoxes & { name: NameBox } => !!f.name && f.name.width > 0 && f.name.height > 0)
    .sort((a, b) => a.name.y - b.name.y || a.name.x - b.name.x || (a.id < b.id ? -1 : 1))
  for (const f of named) {
    if (f.editing) {
      kept.push(f.name)
      continue
    }
    const crowded =
      frames.some((o) => o.id !== f.id && !overlaps(f.frame, o.frame) && overlaps(f.name, o.frame)) ||
      kept.some((k) => overlaps(f.name, k))
    if (crowded) hidden.add(f.id)
    else kept.push(f.name)
  }
  return hidden
}

/** Element ids as the engine makes them (nanoid's alphabet): the only ids put into a selector. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Excalidraw's frame name label id: `${appId}-frame-name-${frameId}` (App.getFrameNameDOMId). */
const NAME_ID = /-frame-name-([A-Za-z0-9_-]{1,64})$/

/** The stylesheet that hides `ids`' names (Excalidraw's `.frame-name` labels). */
export function hiddenNamesCss(ids: Iterable<string>): string {
  const rules: string[] = []
  for (const id of [...ids].sort())
    if (SAFE_ID.test(id)) rules.push(`.excalidraw .frame-name[id$="-frame-name-${id}"]{visibility:hidden}`)
  return rules.join('\n')
}

interface FrameLike {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The ids of a change batch (LobbyCanvas `change`). */
export interface ChangedIds {
  readonly created: readonly string[]
  readonly updated: readonly string[]
  readonly deleted: readonly string[]
}

export interface FrameNameGuard {
  /** the frames whose name is hidden now */
  hidden(): ReadonlySet<string>
  /** re-reads the frames (a scene change) and the names on the next animation frame */
  refresh(): void
  dispose(): void
}

/**
 * Hides the crowded frame names of the engine inside `root` (see the header). `subscribe` adds the scene's
 * change listener (LobbyCanvas `change`: a frame moved, resized, renamed, created or deleted, here or by
 * someone else); the frames are re-read on the next measure after it fires. A camera move and a resize of
 * the window measure again too (a pan that draws the same names reads no box: overlaps move with it). Nothing
 * else is listened to: the engine's `onChange` fires on every pointer move, and a frame dragged here is
 * mutated in place (its cached copy is the live element).
 */
export function installFrameNameGuard(o: {
  readonly api: ExcalidrawImperativeAPI
  readonly root: HTMLElement
  /**
   * the scene's change listener; with the changed ids (N1-6, wave N), a batch that touches no frame (a note dragged on
   * a 10k board, every pointer move) re-reads nothing
   */
  readonly subscribe?: (onChange: (changed?: ChangedIds) => void) => () => void
}): FrameNameGuard {
  const { api, root } = o
  const doc = root.ownerDocument
  const win = doc.defaultView ?? window
  const style = doc.createElement('style')
  style.setAttribute('data-lobby-frame-names', '')
  root.appendChild(style)
  let hidden: ReadonlySet<string> = new Set()
  let frames: FrameLike[] | null = null
  let frame: number | null = null
  let disposed = false
  /** a frame changed or the window was resized since the last measure */
  let dirty = true
  /** the zoom and the names drawn at the last measure: a pan with the same names keeps every overlap */
  let lastKey = ''

  const framesNow = (): FrameLike[] => {
    if (!frames) {
      noteSceneWalk('frame-names.frames')
      frames = (api.getSceneElements() as unknown as readonly FrameLike[]).filter(
        (e) => e.type === 'frame' && !e.isDeleted,
      )
    }
    return frames
  }
  /**
   * N1-6: a change batch moves the frames list by its ids alone (no walk): false when it touches no frame (one this
   * guard knows, or one that is a frame now). Before the list exists there is nothing to move.
   */
  const applyChange = (c: ChangedIds): boolean => {
    if (!frames) return true
    const map = api.getSceneElementsMapIncludingDeleted() as unknown as ReadonlyMap<string, FrameLike>
    let byId: Map<string, FrameLike> | null = null
    for (const list of [c.created, c.updated, c.deleted])
      for (const id of list) {
        const el = map.get(id)
        const isFrame = el?.type === 'frame' && !el.isDeleted
        if (!isFrame && !frames.some((f) => f.id === id)) continue
        byId ??= new Map(frames.map((f) => [f.id, f]))
        byId.delete(id)
        if (isFrame && el) byId.set(id, el)
      }
    if (!byId) return false
    frames = [...byId.values()]
    return true
  }

  const measure = () => {
    frame = null
    if (disposed) return
    const s = api.getAppState()
    const z = s.zoom.value
    const labels = [...root.querySelectorAll<HTMLElement>('.excalidraw .frame-name')]
    // a pan moves every frame and name alike: no box is read again (no layout) unless the zoom, the names
    // drawn (one scrolled in or out) or a frame changed
    const key = `${z}|${labels.map((el) => el.id + (el.querySelector('input') ? '*' : '')).join(',')}`
    if (!dirty && key === lastKey) return
    dirty = false
    lastKey = key
    const list = framesNow()
    const byId = new Map<string, FrameNameBoxes>()
    for (const f of list)
      byId.set(f.id, {
        id: f.id,
        frame: {
          x: (f.x + s.scrollX) * z + s.offsetLeft,
          y: (f.y + s.scrollY) * z + s.offsetTop,
          width: f.width * z,
          height: f.height * z,
        },
        name: null,
      })
    for (const el of labels) {
      const id = NAME_ID.exec(el.id)?.[1]
      const entry = id ? byId.get(id) : undefined
      if (!id || !entry) continue
      const r = el.getBoundingClientRect()
      byId.set(id, {
        ...entry,
        name: { x: r.left, y: r.top, width: r.width, height: r.height },
        editing: !!el.querySelector('input'),
      })
    }
    const next = crowdedFrameNames([...byId.values()])
    if (next.size === hidden.size && [...next].every((id) => hidden.has(id))) return
    hidden = next
    style.textContent = hiddenNamesCss(next)
  }

  const schedule = () => {
    if (frame !== null || disposed) return
    frame = win.requestAnimationFrame(measure)
  }
  const offs: (() => void)[] = []
  offs.push(api.onScrollChange(() => schedule()))
  const onResize = () => {
    dirty = true
    schedule()
  }
  win.addEventListener('resize', onResize)
  offs.push(() => win.removeEventListener('resize', onResize))
  if (o.subscribe)
    offs.push(
      o.subscribe((changed) => {
        if (changed) {
          if (!applyChange(changed)) return
        } else frames = null
        dirty = true
        schedule()
      }),
    )
  schedule()

  return {
    hidden: () => hidden,
    refresh() {
      frames = null
      dirty = true
      schedule()
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of offs.splice(0)) off()
      if (frame !== null) win.cancelAnimationFrame(frame)
      style.remove()
    },
  }
}
