// fix/firefox (the NAS cross-browser run, 2026-10-19): a local drag's relayed offset counts from where the dragged
// selection was before the drag, not from the first dragging frame. That frame already holds the first pointer step,
// and in WebKit a quick drag arrives coalesced, all of it in that one frame: the others' preview then stood still
// (offset 0) until the drop (board-presence W5-28 and board-drag-arrows D1 failed in WebKit only; in Chromium the
// preview lagged by the first step, 140 of 160 px).
import { describe, expect, it } from 'vitest'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import { note, text } from '../sync/testing/elements.ts'
import type { SceneElement } from '../sync/types.ts'
import { IDLE_GESTURE } from '../sync/types.ts'
import { PresenceHub } from './hub.ts'

type DragOut = { d: number; ids?: string[]; dx: number; dy: number } | null

function setup() {
  const scene = new Map<string, SceneElement>()
  scene.set('n1', note('n1', 'a1', { x: 140, y: 120 }))
  scene.set('n1.t', text('n1.t', 'a2', { containerId: 'n1' }))
  scene.set('n2', note('n2', 'a3', { x: 600, y: 120 }))
  const sent: { drag?: DragOut }[] = []
  const core = {
    sid: 'usr_me:t' as string | null,
    on: () => () => {},
    roster: () => new Map(),
    sendPresence: (p: { drag?: DragOut }) => sent.push(p),
  }
  const hub = new PresenceHub({
    core: core as unknown as LobbyEngineCore,
    overrides: null,
    elements: () => [...scene.values()],
    elementMap: () => scene,
    view: () => null,
    readOnly: () => false,
  })
  const moveTo = (id: string, x: number, y: number) =>
    scene.set(id, { ...(scene.get(id) as SceneElement), x, y })
  const drags = () => sent.filter((p) => p.drag !== undefined).map((p) => p.drag)
  return { hub, scene, moveTo, drags }
}

describe('a drag relays its offset from where the selection was before it', () => {
  it('a coalesced drag (WebKit: every step in the first dragging frame) relays the whole move at once', () => {
    const { hub, moveTo, drags } = setup()
    hub.onGesture({ ...IDLE_GESTURE, selectedElementIds: ['n1'] })
    moveTo('n1', 300, 160)
    hub.onGesture({ ...IDLE_GESTURE, dragging: true, selectedElementIds: ['n1'] })
    expect(drags()).toEqual([{ d: 1, ids: ['n1'], dx: 160, dy: 40 }])
    hub.onGesture({ ...IDLE_GESTURE, selectedElementIds: ['n1'] })
    expect(drags().at(-1)).toBeNull()
    hub.dispose()
  })

  it('step by step (Chromium): the last offset is the whole move, not the move less its first step', () => {
    const { hub, moveTo, drags } = setup()
    hub.onGesture({ ...IDLE_GESTURE, selectedElementIds: ['n1'] })
    for (let i = 1; i <= 8; i++) {
      moveTo('n1', 140 + 20 * i, 120 + 5 * i)
      hub.onGesture({ ...IDLE_GESTURE, dragging: true, selectedElementIds: ['n1'] })
    }
    expect(drags()[0]).toEqual({ d: 1, ids: ['n1'], dx: 20, dy: 5 })
    expect(drags().at(-1)).toEqual({ d: 1, dx: 160, dy: 40 })
    hub.dispose()
  })

  it('the next drag counts from where the last one dropped; a selection the drag frame made (alt-drag copies) from that frame', () => {
    const { hub, scene, moveTo, drags } = setup()
    hub.onGesture({ ...IDLE_GESTURE, selectedElementIds: ['n1'] })
    moveTo('n1', 200, 120)
    hub.onGesture({ ...IDLE_GESTURE, dragging: true, selectedElementIds: ['n1'] })
    hub.onGesture({ ...IDLE_GESTURE, selectedElementIds: ['n1'] })
    moveTo('n1', 260, 150)
    hub.onGesture({ ...IDLE_GESTURE, dragging: true, selectedElementIds: ['n1'] })
    expect(drags().at(-1)).toEqual({ d: 2, ids: ['n1'], dx: 60, dy: 30 })
    hub.onGesture({ ...IDLE_GESTURE, selectedElementIds: ['n1'] })
    // a copy that exists only from the dragging frame on: no place before the drag, its first frame is the origin
    scene.set('n1copy', note('n1copy', 'a9', { x: 280, y: 150 }))
    hub.onGesture({ ...IDLE_GESTURE, dragging: true, selectedElementIds: ['n1copy'] })
    expect(drags().at(-1)).toEqual({ d: 3, ids: ['n1copy'], dx: 0, dy: 0 })
    hub.dispose()
  })

  it('a remote move of the selected note before the drag moves the origin with it', () => {
    const { hub, moveTo, drags } = setup()
    hub.onGesture({ ...IDLE_GESTURE, selectedElementIds: ['n2'] })
    moveTo('n2', 640, 100) // someone else moved it: a scene change, no drag
    hub.onGesture({ ...IDLE_GESTURE, selectedElementIds: ['n2'] })
    moveTo('n2', 700, 100)
    hub.onGesture({ ...IDLE_GESTURE, dragging: true, selectedElementIds: ['n2'] })
    expect(drags().at(-1)).toEqual({ d: 1, ids: ['n2'], dx: 60, dy: 0 })
    hub.dispose()
  })
})
