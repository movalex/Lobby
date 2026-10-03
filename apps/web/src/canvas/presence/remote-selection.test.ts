// W5-28 (wave A, A2): other people's selection outlines follow a remote drag's preview. The hub tells
// the overlay (canvas/board/chrome.tsx RemoteSelections) where a remote drag shows an element right now,
// and stops once the committed position has arrived (as the render offset does), so an outline is never
// moved twice in the moment between the commit and the drag's end.
import type { ServerMessage } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import { PresenceHub } from './hub.ts'

function setup() {
  type Event = { kind: string; message?: ServerMessage; ids?: string[] }
  const listeners = new Set<(e: Event) => void>()
  const core = {
    sid: 'usr_me:t' as string | null,
    on(l: (e: Event) => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    roster: () => new Map(),
    sendPresence: () => {},
  }
  const emit = (e: Event) => {
    for (const l of [...listeners]) l(e)
  }
  const cleared: string[][] = []
  const hub = new PresenceHub({
    core: core as unknown as LobbyEngineCore,
    overrides: { setDrag: () => {}, clearDragFor: (ids) => void cleared.push([...ids]) },
    elements: () => [],
    view: () => null,
    readOnly: () => false,
  })
  const drags = (ds: unknown[]) =>
    emit({ kind: 'message', message: { type: 'presence', peers: [], drags: ds } as ServerMessage })
  return { hub, emit, drags, cleared }
}

describe('the remote drag offset the selection outlines use (W5-28)', () => {
  it('follows the deltas, stops at the commit, and ends with the drag', () => {
    const { hub, emit, drags, cleared } = setup()
    expect(hub.dragOffsetOf('n1')).toBeNull()
    drags([{ sid: 'usr_bob:t', d: 1, ids: ['n1', 'n2'], dx: 5, dy: 6 }])
    expect(hub.dragOffsetOf('n1')).toEqual({ x: 5, y: 6 })
    expect(hub.dragOffsetOf('n3')).toBeNull()
    drags([{ sid: 'usr_bob:t', d: 1, dx: 120.5, dy: -4 }])
    expect(hub.dragOffsetOf('n2')).toEqual({ x: 120.5, y: -4 })
    // bob's pointer-up: the committed positions arrive before the drag's end (presence is 10 Hz)
    const before = hub.revision
    emit({ kind: 'applied', ids: ['n1'] })
    expect(cleared).toEqual([['n1']])
    expect(hub.revision).toBeGreaterThan(before) // the overlay re-reads
    expect(hub.dragOffsetOf('n1')).toBeNull()
    expect(hub.dragOffsetOf('n2')).toEqual({ x: 120.5, y: -4 })
    drags([{ sid: 'usr_bob:t', d: 1, end: true }])
    expect(hub.dragOffsetOf('n2')).toBeNull()
    // a new drag of the same note moves its outline again
    drags([{ sid: 'usr_bob:t', d: 2, ids: ['n1'], dx: 1, dy: 1 }])
    expect(hub.dragOffsetOf('n1')).toEqual({ x: 1, y: 1 })
    hub.dispose()
    expect(hub.dragOffsetOf('n1')).toBeNull()
  })
})
