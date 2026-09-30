// 3c's follow part (./follow.ts) on a fake canvas: the camera fits the followed session's view, and
// following ends on stop(), when they leave, and when this person moves the camera.
import { describe, expect, it, vi } from 'vitest'
import { atom } from '../../../lib/signals.ts'
import type { CanvasInputEvent, LobbyCanvas, RemoteCursor, RosterEntry } from '../lobby-canvas.ts'
import { createFollowPart, followCamera } from './follow.ts'

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
  }
}

const part = (canvas: LobbyCanvas) =>
  createFollowPart({ port: {} as never, registries: {} as never, self: () => canvas })

const input = (type: CanvasInputEvent['type']) => ({ type }) as CanvasInputEvent
const tick = () => new Promise((r) => setTimeout(r, 0))

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
