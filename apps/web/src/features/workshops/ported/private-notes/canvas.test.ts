// OWNER: 3f. Private brainstorming's canvas helpers on the Excalidraw page.
import { PRIVATE_FRAME_DEFAULT_NAME } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { el, fakeCanvas, note } from '../test-kit.ts'
import {
  createPrivateFrame,
  NEW_FRAME_H,
  NEW_FRAME_W,
  newElementId,
  placedNoteIds,
  planPrivateFrame,
  removeEmptyPrivateFrame,
  selectedFrame,
  showPlacedNotes,
  targetForFrame,
  waitForPlacedNotes,
  zoomToSession,
} from './canvas.ts'

const placed = (id: string, session: string, patch: Record<string, unknown> = {}) =>
  note(id, 'An idea', { customData: { lobbyServer: { privateNote: { session } } }, ...patch })

describe('where the notes go', () => {
  it('the selected frame (or the frame of the selection), as a target with the one page', () => {
    const f = fakeCanvas([
      el('fr', 'frame', { x: 10, y: 20, width: 300, height: 200 }),
      ...note('n', 'x', { frameId: 'fr' }),
    ])
    f.selection = ['n']
    const frame = selectedFrame(f.canvas)
    expect(frame?.id).toBe('fr')
    expect(frame && targetForFrame(f.canvas, frame)).toEqual({
      frameId: 'shape:fr',
      pageId: 'page:page',
      x: 10,
      y: 20,
      w: 300,
      h: 200,
    })
    f.selection = []
    expect(selectedFrame(f.canvas)).toBeNull()
  })

  it('plans a new frame in free space, and makes it only after the start, marked for the session', () => {
    const f = fakeCanvas([el('busy', 'frame', { x: 0, y: 0, width: 1000, height: 800 })])
    const plan = planPrivateFrame(f.canvas)
    expect(plan.id).toMatch(/^[A-Za-z0-9_-]{21}$/)
    expect(plan.target).toMatchObject({
      frameId: `shape:${plan.id}`,
      pageId: 'page:page',
      w: NEW_FRAME_W,
      h: NEW_FRAME_H,
    })
    const t = plan.target
    const overlaps = t.x < 1000 && t.x + t.w > 0 && t.y < 800 && t.y + t.h > 0
    expect(overlaps).toBe(false)
    expect(f.canvas.get(plan.id)).toBeUndefined() // nothing made yet
    expect(createPrivateFrame(f.canvas, plan, 'pbs_0123456789', 'usr_a')).toBe(true)
    expect(f.canvas.get(plan.id)).toMatchObject({
      type: 'frame',
      name: PRIVATE_FRAME_DEFAULT_NAME,
      customData: { lobby: { privateFrame: { session: 'pbs_0123456789', by: 'usr_a' } } },
    })
    expect(newElementId()).not.toBe(newElementId())
  })

  it('takes away only an empty, unlocked "Private ideas" frame made for a brainstorm', () => {
    const made = {
      name: PRIVATE_FRAME_DEFAULT_NAME,
      customData: { lobby: { privateFrame: { session: 's', by: 'u' } } },
    }
    const f = fakeCanvas([
      el('mine', 'frame', made),
      el('picked', 'frame', { name: PRIVATE_FRAME_DEFAULT_NAME }),
      el('renamed', 'frame', { ...made, name: 'Ideas' }),
      el('locked', 'frame', { ...made, locked: true }),
      el('full', 'frame', made),
      ...note('kid', 'x', { frameId: 'full' }),
    ])
    for (const id of ['picked', 'renamed', 'locked', 'full'])
      expect(removeEmptyPrivateFrame(f.canvas, `shape:${id}`), id).toBe(false)
    expect(removeEmptyPrivateFrame(f.canvas, 'shape:mine')).toBe(true)
    expect(f.steps).toEqual(['remove empty private frame'])
  })
})

describe('after the reveal', () => {
  it('finds the notes a session placed, and waits for all of them', async () => {
    const f = fakeCanvas([...placed('p1', 'pbs_a'), ...placed('p2', 'pbs_b')])
    expect(placedNoteIds(f.canvas, 'pbs_a')).toEqual(['p1'])
    const listeners: (() => void)[] = []
    ;(f.canvas as unknown as { on: (e: string, l: () => void) => () => void }).on = (_e, l) => {
      listeners.push(l)
      return () => {}
    }
    const got: string[][] = []
    waitForPlacedNotes(f.canvas, 'pbs_a', 2, (ids) => got.push(ids))
    expect(got).toEqual([])
    f.elements.push(...placed('p3', 'pbs_a'))
    for (const l of listeners) l()
    expect(got).toEqual([['p1', 'p3']])
  })

  it('shows the placed notes unless they are all readable in view already, and zooms to their frame', () => {
    const f = fakeCanvas([
      el('fr', 'frame', { x: 5000, y: 0, width: 800, height: 600 }),
      ...placed('p1', 's', { x: 5100, y: 100, frameId: 'fr' }),
    ])
    expect(showPlacedNotes(f.canvas, ['p1'], false)).toBe(true)
    expect(f.moves).toHaveLength(1)
    expect(showPlacedNotes(f.canvas, ['p1'], false)).toBe(false) // now in view at 100%
    expect(showPlacedNotes(f.canvas, ['p1'], true)).toBe(false) // never while presenting
    expect(zoomToSession(f.canvas, 's', 'shape:gone')).toBe(true)
    const v = f.viewport
    expect(v.x <= 5000 && v.x + v.width >= 5800).toBe(true)
    expect(zoomToSession(f.canvas, 'none', 'shape:gone')).toBe(false)
  })
})
