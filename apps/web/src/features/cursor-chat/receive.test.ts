// K6-4, wave K integration (the K6 review): someone else's message floats at their cursor, or where they sent it
// when this page has no cursor of theirs; when this page HIDES their cursor (a facilitator hid the cursors, or
// this page presents) it is not placed at all and not read out: a message must not give away where they are.
import { CURSOR_CHAT_EVENT } from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
import { type CanvasFeatureContext, createFeatureRegistries } from '../../canvas/api/index.ts'

const said: string[] = []
vi.mock('../a11y/ported/announcer.ts', () => ({
  announcerFor: () => ({ sayPolitely: (t: string) => void said.push(t) }),
  releaseAnnouncer: () => {},
}))
vi.stubGlobal('requestAnimationFrame', () => 0)

const { CursorChatController } = await import('./ported/index.tsx')

const ME = 'usr_me000000000000000'
const ALICE = 'usr_alice00000000000'

function setup(opts: { hidden: boolean; peers: boolean }) {
  said.length = 0
  const registries = createFeatureRegistries()
  if (opts.hidden) registries.cursorVisible.provide(() => false)
  let handler: ((d: unknown) => void) | null = null
  const ctx = {
    registries,
    canvas: {
      presence: {
        peers: () =>
          opts.peers
            ? [{ sid: `${ALICE}:t1`, uid: ALICE, point: { x: 40, y: 40 }, idle: false, color: '#1d4ed8' }]
            : [],
      },
    },
    board: { id: 'b-0123456789', status: 'active' },
    role: 'editor',
    me: { user: { id: ME, name: 'Me', color: '#0f766e' } },
    events: {
      on: (type: string, fn: (d: unknown) => void) => {
        if (type === CURSOR_CHAT_EVENT) handler = fn
        return () => {}
      },
    },
    notify: vi.fn(),
  } as unknown as CanvasFeatureContext
  const c = new CursorChatController(ctx)
  const unmount = c.mount()
  const receive = (at?: { x: number; y: number }) =>
    handler?.({ userId: ALICE, name: 'Alice', text: 'over here', ...(at ? { at } : {}) })
  return { c, unmount, receive }
}

describe('someone else’s message on this page', () => {
  it('at their cursor when it is shown, and read out', () => {
    const t = setup({ hidden: false, peers: true })
    t.receive({ x: 41, y: 41 })
    expect(t.c.bubbles.get()).toHaveLength(1)
    expect(t.c.bubbles.get()[0]?.sid).toBe(`${ALICE}:t1`)
    expect(said).toEqual(['Alice says: over here'])
    t.unmount()
  })

  it('where they sent it when this page has no cursor of theirs', () => {
    const t = setup({ hidden: false, peers: false })
    t.receive({ x: 41, y: 41 })
    expect(t.c.bubbles.get()[0]).toMatchObject({ sid: null, at: { x: 41, y: 41 } })
    t.unmount()
  })

  it('nowhere, and not read out, when this page hides their cursor', () => {
    const t = setup({ hidden: true, peers: true })
    t.receive({ x: 41, y: 41 })
    // before the fix: a bubble at the sent point (where their hidden cursor was), and the words read out
    expect(t.c.bubbles.get()).toEqual([])
    expect(said).toEqual([])
    t.unmount()
  })
})
