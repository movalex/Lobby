// 3c's follow part (./follow.ts) on a fake canvas: the camera fits the followed session's view, and
// following ends on stop(), when they leave, and when this person moves the camera; a camera rule
// (CR-3F-3) shapes where the camera goes.
import { describe, expect, it, vi } from 'vitest'
import { atom } from '../../../lib/signals.ts'
import type { CanvasInputEvent, LobbyCanvas, RemoteCursor, RosterEntry } from '../lobby-canvas.ts'
import { createFollowPart, followCamera, followerCamera } from './follow.ts'

const peer = (sid: string, view: RemoteCursor['view']): RemoteCursor => ({
  sid,
  uid: `usr_${sid}`,
  name: sid,
  color: '#123456',
  guest: false,
  point: null,
  view,
  selection: [],
  idle: false,
  editing: null,
})
const entry = (sid: string): RosterEntry =>
  ({ sid, uid: `usr_${sid}`, name: sid, color: '#123456', role: 'editor', guest: false }) as RosterEntry

function fakeCanvas() {
  const roster = atom<RosterEntry[]>('roster', [entry('me'), entry('bob')])
  const peers = atom<RemoteCursor[]>('peers', [peer('bob', { x: 100, y: 50, width: 800, height: 400 })])
  const set = vi.fn()
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  let screen = { x: 0, y: 0, width: 400, height: 400 }
  const canvas = {
    engine: { welcome: { sid: 'me' } },
    collaborators: () => roster.get(),
    presence: { peer: (sid: string) => peers.get().find((p) => p.sid === sid) ?? null },
    viewport: { screenRect: () => screen, set },
    on(event: string, l: (e: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(l)
      listeners.set(event, set)
      return () => set.delete(l)
    },
  } as unknown as LobbyCanvas
  const fire = (event: string, e?: unknown) => {
    for (const l of listeners.get(event) ?? []) l(e)
  }
  return {
    canvas,
    roster,
    peers,
    set,
    fire,
    resize(w: number, h: number) {
      screen = { x: 0, y: 0, width: w, height: h }
      fire('resize', screen)
    },
    /** The board's resize event, sent before the engine has the new size (which it gets a task later). */
    resizeLate(w: number, h: number) {
      const old = screen
      fire('resize', old)
      setTimeout(() => {
        screen = { x: 0, y: 0, width: w, height: h }
      })
    },
  }
}

const part = (canvas: LobbyCanvas) =>
  createFollowPart({ port: {} as never, registries: {} as never, self: () => canvas })

const input = (type: CanvasInputEvent['type']) => ({ type }) as CanvasInputEvent
const tick = () => new Promise((r) => setTimeout(r, 0))
/** Past the follow part's re-fits after a resize. */
const settled = () => new Promise((r) => setTimeout(r, 200))

describe('followCamera', () => {
  it('fits the whole followed view, centred', () => {
    expect(followCamera({ x: 100, y: 50, width: 800, height: 400 }, { width: 400, height: 400 })).toEqual({
      x: 100,
      y: -150,
      zoom: 0.5,
    })
    expect(followCamera({ x: 0, y: 0, width: 0, height: 10 }, { width: 400, height: 400 })).toBeNull()
  })
})

describe('the follow part', () => {
  it('follows a session: current, followChanged, and the camera on their view (and on a resize)', () => {
    const f = fakeCanvas()
    const { follow, onFollowChanged } = part(f.canvas)
    const changed = vi.fn()
    onFollowChanged(changed)
    follow.start('bob')
    expect(follow.current()).toBe('bob')
    expect(changed).toHaveBeenLastCalledWith('bob')
    expect(f.set).toHaveBeenLastCalledWith({ x: 100, y: -150, zoom: 0.5 }, { force: true })
    f.peers.set([peer('bob', { x: 0, y: 0, width: 400, height: 400 })])
    expect(f.set).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 1 }, { force: true })
    f.resize(800, 400)
    expect(f.set).toHaveBeenLastCalledWith({ x: -200, y: 0, zoom: 1 }, { force: true })
    follow.stop()
    expect(follow.current()).toBeNull()
    expect(changed).toHaveBeenLastCalledWith(null)
    f.peers.set([peer('bob', { x: 50, y: 50, width: 100, height: 100 })])
    expect(f.set).toHaveBeenCalledTimes(3)
  })

  it('W5-25: re-fits once the engine has the new size when the resize event comes before it', async () => {
    const f = fakeCanvas()
    const { follow } = part(f.canvas)
    f.peers.set([peer('bob', { x: 0, y: 0, width: 400, height: 400 })])
    follow.start('bob')
    expect(f.set).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 1 }, { force: true })
    // a dock panel closed on this tab: 400 px wide becomes 800, but the event comes before the new size
    f.resizeLate(800, 400)
    expect(f.set).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 1 }, { force: true })
    await settled()
    expect(f.set).toHaveBeenLastCalledWith({ x: -200, y: 0, zoom: 1 }, { force: true })
    // stopped before the late re-fit: nothing more
    f.resizeLate(400, 400)
    follow.stop()
    const calls = f.set.mock.calls.length
    await settled()
    expect(f.set).toHaveBeenCalledTimes(calls)
  })

  it('never follows this tab itself', () => {
    const f = fakeCanvas()
    const { follow } = part(f.canvas)
    follow.start('me')
    expect(follow.current()).toBeNull()
  })

  it('ends when the followed session leaves the board', async () => {
    const f = fakeCanvas()
    const { follow, onFollowChanged } = part(f.canvas)
    const changed = vi.fn()
    onFollowChanged(changed)
    follow.start('bob')
    f.roster.set([entry('me')])
    await tick()
    expect(follow.current()).toBeNull()
    expect(changed).toHaveBeenLastCalledWith(null)
  })

  it('ends when this person moves the camera: wheel, pinch or a press on the canvas', () => {
    for (const type of ['wheel', 'pinch', 'pointer-down'] as const) {
      const f = fakeCanvas()
      const { follow } = part(f.canvas)
      follow.start('bob')
      f.fire('input', input('pointer-move'))
      expect(follow.current()).toBe('bob')
      f.fire('input', input(type))
      expect(follow.current(), type).toBeNull()
    }
  })

  it('switches from one session to another without a stop in between', () => {
    const f = fakeCanvas()
    f.roster.set([entry('me'), entry('bob'), entry('ann')])
    f.peers.set([
      peer('bob', { x: 0, y: 0, width: 400, height: 400 }),
      peer('ann', { x: 1000, y: 0, width: 400, height: 400 }),
    ])
    const { follow, onFollowChanged } = part(f.canvas)
    const changed = vi.fn()
    onFollowChanged(changed)
    follow.start('bob')
    follow.start('ann')
    expect(follow.current()).toBe('ann')
    expect(changed.mock.calls).toEqual([['bob'], ['ann']])
    expect(f.set).toHaveBeenLastCalledWith({ x: 1000, y: 0, zoom: 1 }, { force: true })
  })
})

describe('a follow camera rule (CR-3F-3)', () => {
  const view = { x: 100, y: 50, width: 800, height: 400 }
  const screen = { width: 400, height: 400 }

  it('followerCamera: the rule gets the view, the screen and the fit; null, a broken camera or a throw keep the fit', () => {
    const fit = { x: 100, y: -150, zoom: 0.5 }
    const rule = vi.fn(() => ({ x: 1, y: 2, zoom: 3 }))
    expect(followerCamera(view, screen, { camera: rule })).toEqual({ x: 1, y: 2, zoom: 3 })
    expect(rule).toHaveBeenCalledWith({ leader: view, screen, fit })
    expect(followerCamera(view, screen)).toEqual(fit)
    expect(followerCamera(view, screen, { camera: () => null })).toEqual(fit)
    for (const bad of [
      { x: Number.NaN, y: 0, zoom: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, zoom: 1 },
      { x: 0, y: 0, zoom: 0 },
      { x: 0, y: 0, zoom: -1 },
    ])
      expect(followerCamera(view, screen, { camera: () => bad })).toEqual(fit)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      followerCamera(view, screen, {
        camera: () => {
          throw new Error('boom')
        },
      }),
    ).toEqual(fit)
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
    // an empty view or canvas: nothing to follow, the rule is not asked
    const never = vi.fn(() => ({ x: 0, y: 0, zoom: 1 }))
    expect(followerCamera({ ...view, width: 0 }, screen, { camera: never })).toBeNull()
    expect(never).not.toHaveBeenCalled()
  })

  it('the part places the camera with the rule, on every view and resize', () => {
    const f = fakeCanvas()
    const { follow } = part(f.canvas)
    // the view's centre at zoom 1
    const centred = ({ leader, screen: s }: { leader: typeof view; screen: typeof screen }) => ({
      x: leader.x + leader.width / 2 - s.width / 2,
      y: leader.y + leader.height / 2 - s.height / 2,
      zoom: 1,
    })
    follow.start('bob', { camera: centred })
    expect(f.set).toHaveBeenLastCalledWith({ x: 300, y: 50, zoom: 1 }, { force: true })
    f.peers.set([peer('bob', { x: 0, y: 0, width: 400, height: 400 })])
    expect(f.set).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 1 }, { force: true })
    f.resize(200, 200)
    expect(f.set).toHaveBeenLastCalledWith({ x: 100, y: 100, zoom: 1 }, { force: true })
  })

  it('starting the session already followed replaces the rule and re-applies, with no second followChanged', () => {
    const f = fakeCanvas()
    const { follow, onFollowChanged } = part(f.canvas)
    const changed = vi.fn()
    onFollowChanged(changed)
    follow.start('bob')
    expect(f.set).toHaveBeenLastCalledWith({ x: 100, y: -150, zoom: 0.5 }, { force: true })
    follow.start('bob', { camera: () => ({ x: 7, y: 8, zoom: 2 }) })
    expect(f.set).toHaveBeenLastCalledWith({ x: 7, y: 8, zoom: 2 }, { force: true })
    expect(changed.mock.calls).toEqual([['bob']])
    expect(follow.current()).toBe('bob')
    // and back to the plain fit
    follow.start('bob')
    expect(f.set).toHaveBeenLastCalledWith({ x: 100, y: -150, zoom: 0.5 }, { force: true })
  })

  it('a stop forgets the rule: the next follow fits', () => {
    const f = fakeCanvas()
    const { follow } = part(f.canvas)
    follow.start('bob', { camera: () => ({ x: 7, y: 8, zoom: 2 }) })
    follow.stop()
    follow.start('bob')
    expect(f.set).toHaveBeenLastCalledWith({ x: 100, y: -150, zoom: 0.5 }, { force: true })
  })
})
