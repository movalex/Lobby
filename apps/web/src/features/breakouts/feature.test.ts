// Wave V (WS4): the 'breakouts' feature on a board page (Node, react-dom/server): off, it does nothing at all; on (its
// web switch AND the api's), it reads the state, offers the Facilitate entry and the panel, draws the chip and the pill,
// takes the camera to this person's frame, shows the facilitator's messages and follows a summon of its own group.
import { BREAKOUT_EVENTS, type BreakoutState } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NoticeInput } from '../../board/board-context.ts'
import type { CanvasElement, CanvasFeatureContext } from '../../canvas/api/index.ts'
import { LIVE_FLAG_KEYS, setLiveSwitches } from '../live/index.ts'
import { facilitateExtras, facilitatePillExtras } from '../workshops/ported/facilitate-entries.ts'
import { el, fakeCanvas } from '../workshops/ported/test-kit.ts'
import { BreakoutChip } from './Chip.tsx'
import { groupsFromFrames, makeFrames, selectedFrames } from './frames.ts'
import { BREAKOUTS_PANEL, breakoutsCommandHeld, feature } from './index.tsx'
import { BreakoutsPanel } from './Panel.tsx'
import { breakoutStoreOf } from './store.ts'
import { ME, OTHER, STARTER, sample } from './test-kit.ts'

class Events {
  readonly listeners = new Map<string, Set<(d: unknown) => void>>()
  on(type: string, l: (d: unknown) => void) {
    const s = this.listeners.get(type) ?? new Set()
    s.add(l)
    this.listeners.set(type, s)
    return () => void s.delete(l)
  }
  onResync() {
    return () => {}
  }
  emit(type: string, data: unknown) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(data)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
/** The tag of the element with this test id (attributes in any order). */
const tagOf = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''

function page(
  opts: { role?: string; state?: BreakoutState; elements?: CanvasElement[]; guest?: boolean } = {},
) {
  const fake = fakeCanvas(
    opts.elements ?? [
      el('f1', 'frame', { x: 0, y: 0, width: 400, height: 300, name: 'Red' }),
      el('f2', 'frame', { x: 600, y: 0, width: 400, height: 300, name: 'Blue' }),
    ],
  )
  const roster = [
    { uid: ME, sid: 'sid-me', name: 'Me', color: '#000', guest: false, role: opts.role ?? 'owner' },
    { uid: OTHER, sid: 'sid-o', name: 'Other', color: '#000', guest: false, role: 'editor' },
    { uid: STARTER, sid: 'sid-s', name: 'Ada', color: '#000', guest: false, role: 'owner' },
  ]
  const canvas = Object.assign(fake.canvas, {
    collaborators: () => roster,
    presence: { peers: () => [], peer: () => null },
    on: () => () => {},
    focus: () => {},
  })
  const calls: { method: string; path: string; body?: unknown }[] = []
  let state = opts.state ?? sample()
  const request = async (method: string, path: string, o: { body?: unknown; schema: unknown }) => {
    calls.push({ method, path, body: o.body })
    const schema = o.schema as { parse(v: unknown): unknown } | null
    if (method === 'GET' && path.endsWith('/breakouts')) return schema?.parse(state)
    if (method === 'POST' && path.endsWith('/breakouts')) {
      state = sample({ canManage: true, myGroupId: null, members: [] })
      return schema?.parse(state)
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  const notices: NoticeInput[] = []
  const panels: (string | null)[] = []
  const providers: ((sid: string) => boolean)[] = []
  const events = new Events()
  const ctx = {
    board: { id: 'b-0123456789', title: 'Board', status: 'active' },
    role: opts.role ?? 'owner',
    me: { user: { id: ME, name: 'Me', color: '#000' } },
    workspace: { id: 'ws', name: 'W' },
    api: { request },
    events,
    canvas,
    registries: {
      cursorVisible: {
        provide: (fn: (sid: string) => boolean) => {
          providers.push(fn)
          return () => providers.splice(providers.indexOf(fn), 1)
        },
      },
    },
    notify: (n: NoticeInput) => notices.push(n),
    dismiss: () => {},
    openPanel: (id: string | null) => panels.push(id),
    activePanel: null,
  } as unknown as CanvasFeatureContext
  return { ctx, fake, calls, notices, panels, providers, events, setState: (s: BreakoutState) => (state = s) }
}

let flags: Record<string, string> = {}
const cleanups: (() => void)[] = []
beforeEach(() => {
  flags = {}
  ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => flags[k] ?? null }
})
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  setLiveSwitches(null)
  delete (globalThis as { localStorage?: unknown }).localStorage
})

const switchOn = () => {
  flags[LIVE_FLAG_KEYS.breakouts] = '1'
  setLiveSwitches({ breakouts: true })
}

async function mounted(p: ReturnType<typeof page>) {
  const off = feature.onMount?.(p.ctx)
  if (off) cleanups.push(off)
  await tick()
  return off
}

describe('switched off', () => {
  it('the web switch off: no request, no panel, no entry, no chip (the board as before wave V)', async () => {
    setLiveSwitches({ breakouts: true })
    const p = page()
    expect(await mounted(p)).toBeUndefined()
    expect(p.calls).toEqual([])
    expect(BREAKOUTS_PANEL.visible?.(p.ctx)).toBe(false)
    expect(facilitateExtras({ ctx: p.ctx, guest: false, facilitator: true })).toEqual([])
    expect(breakoutStoreOf(p.ctx.canvas)).toBeNull()
  })

  it('the api switch off: no request either, until the api says on', async () => {
    flags[LIVE_FLAG_KEYS.breakouts] = '1'
    const p = page()
    await mounted(p)
    expect(p.calls).toEqual([])
    setLiveSwitches({ breakouts: true })
    await tick()
    expect(p.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/boards/b-0123456789/breakouts'])
    setLiveSwitches(null)
    expect(breakoutStoreOf(p.ctx.canvas)).toBeNull()
  })

  it('the palette command is held while the contracts list it pending', () => {
    expect(breakoutsCommandHeld(['breakouts.start'])).toBe(true)
    expect(breakoutsCommandHeld([])).toBe(false)
    expect(feature.commands?.map((c) => c.id) ?? []).toEqual(
      breakoutsCommandHeld() ? [] : ['breakouts.start'],
    )
  })
})

describe('switched on', () => {
  it('a member: the chip, the pill, the camera to their frame and a toast; the entry opens the panel', async () => {
    switchOn()
    const p = page({ role: 'editor' })
    await mounted(p)
    const store = breakoutStoreOf(p.ctx.canvas)
    expect(store?.state.get()?.myGroupId).toBe('g2')
    // the camera went to Group 2's frame (f2), and the person was told
    expect(p.fake.moves.length).toBeGreaterThan(0)
    expect(p.notices.map((n) => n.testId)).toContain('breakout-group-toast')
    expect(facilitatePillExtras(p.ctx.canvas)[0]?.text).toMatch(/^Group 2 · \d+:\d\d/)
    const extras = facilitateExtras({ ctx: p.ctx, guest: false, facilitator: false })
    expect(extras.map((e) => e.id)).toEqual(['breakouts'])
    if (!store) throw new Error('no store')
    const chip = renderToStaticMarkup(createElement(BreakoutChip, { ctx: p.ctx, store }))
    expect(chip).toContain('data-testid="breakout-chip"')
    expect(chip).toContain('data-kind="member"')
    expect(chip).toContain('Group 2')
    expect(chip).toContain('data-testid="breakout-go"')
    expect(BREAKOUTS_PANEL.visible?.(p.ctx)).toBe(true)
  })

  it('a message shows as a toast; a summon of the own group follows (or says it cannot), of another group does nothing', async () => {
    switchOn()
    const p = page({ role: 'editor' })
    await mounted(p)
    const session = sample().session?.id
    p.events.emit(BREAKOUT_EVENTS.broadcast, {
      sessionId: session,
      text: 'Five minutes left',
      from: { userId: STARTER, name: 'Ada' },
      groupId: 'g2',
      at: new Date().toISOString(),
    })
    expect(p.notices.find((n) => n.testId === 'breakout-broadcast-toast')?.text).toBe(
      'Ada to Group 2: Five minutes left',
    )
    p.events.emit(BREAKOUT_EVENTS.summon, { sessionId: session, userId: STARTER, name: 'Ada', groupId: 'g1' })
    await new Promise((r) => setTimeout(r, 50))
    expect(p.notices.some((n) => n.testId === 'breakout-summon-toast')).toBe(false)
    // the own group's summon: Ada is in the roster, the in-memory canvas has no follow (so it says it is not available)
    p.events.emit(BREAKOUT_EVENTS.summon, { sessionId: session, userId: STARTER, name: 'Ada', groupId: 'g2' })
    expect(p.notices.find((n) => n.testId === 'breakout-summon-toast')?.text).toMatch(/^Ada asked your group/)
  })

  it('"Only show my group cursors" provides a cursor filter while on', async () => {
    switchOn()
    const p = page({ role: 'editor' })
    await mounted(p)
    const { onlyMyGroupOf } = await import('./cursors.ts')
    onlyMyGroupOf(p.ctx.canvas).set(true)
    expect(p.providers).toHaveLength(1)
    onlyMyGroupOf(p.ctx.canvas).set(false)
    expect(p.providers).toHaveLength(0)
  })

  it('the facilitator with nothing running: the panel is the setup, Split everyone now and 10 min by default', async () => {
    switchOn()
    const p = page({ state: sample({ session: null, members: [], myGroupId: null }) })
    await mounted(p)
    expect(BREAKOUTS_PANEL.visible?.(p.ctx)).toBe(true)
    const html = renderToStaticMarkup(createElement(BreakoutsPanel, { ctx: p.ctx, close: () => {} }))
    expect(html).toContain('data-testid="breakouts-setup"')
    expect(tagOf(html, 'breakouts-mode-auto')).toContain('checked')
    expect(html).toContain('<option value="600000" selected="">10 min</option>')
    expect(html).toContain('Groups are a guide: everyone can still edit the whole board.')
    // no frames selected: "Make new frames" is the choice
    expect(tagOf(html, 'breakouts-src-selected')).toContain('disabled')
  })

  it('a manager while it runs: the groups with their people, the message box, +5 min and End', async () => {
    switchOn()
    const p = page({
      state: sample({
        canManage: true,
        myGroupId: null,
        members: [{ userId: OTHER, name: 'Other', groupId: 'g1' }],
      }),
    })
    await mounted(p)
    const html = renderToStaticMarkup(createElement(BreakoutsPanel, { ctx: p.ctx, close: () => {} }))
    for (const id of [
      'breakouts-manage',
      'breakouts-extend',
      'breakouts-end',
      'breakouts-shuffle',
      'breakouts-broadcast-text',
      'breakouts-group-g1',
      'breakouts-group-g2',
      `breakouts-move-${OTHER}`,
      'breakouts-summon-g1',
      'breakouts-unassigned',
    ])
      expect(html, id).toContain(`data-testid="${id}"`)
    // the people on the board in no group are listed to be placed (me and Ada here)
    expect(html).toContain(`data-testid="breakouts-person-${ME}"`)
    expect(html).toContain(`data-testid="breakouts-person-${STARTER}"`)
    // an empty group cannot be brought here
    expect(tagOf(html, 'breakouts-summon-g2')).toContain('disabled')
    expect(tagOf(html, 'breakouts-summon-g1')).not.toContain('disabled')
  })

  it('choose mode for a participant: the groups to join, a full one disabled', async () => {
    switchOn()
    const p = page({
      role: 'viewer',
      state: sample(
        { myGroupId: null, members: [{ userId: OTHER, name: 'Other', groupId: 'g1' }] },
        { mode: 'choose', groupCap: 1 },
      ),
    })
    await mounted(p)
    const html = renderToStaticMarkup(createElement(BreakoutsPanel, { ctx: p.ctx, close: () => {} }))
    expect(html).toContain('data-testid="breakouts-choose"')
    expect(html).toContain('aria-label="Group 1 is full"')
    expect(html).toContain('aria-label="Join Group 2"')
    expect(html).not.toContain('data-testid="breakouts-manage"')
  })
})

describe('the frames', () => {
  it('Make N frames: N named frames in one undo step, tagged breakout-frame, as the groups', () => {
    const fake = fakeCanvas([el('n1', 'stickynote', { x: 0, y: 0, width: 200, height: 200 })])
    const groups = makeFrames(fake.canvas, 3)
    expect(fake.steps).toEqual(['breakout frames'])
    const made = fake.elements.filter((e) => e.type === 'frame')
    expect(made).toHaveLength(3)
    expect(made.map((f) => (f as { name?: string }).name)).toEqual(['Group 1', 'Group 2', 'Group 3'])
    for (const f of made) expect(f.customData?.lobby?.kind).toBe('breakout-frame')
    expect(groups).toEqual(made.map((f, i) => ({ name: `Group ${i + 1}`, frameId: `shape:${f.id}` })))
    // clear of what was there
    for (const f of made)
      expect(f.x >= 200 || f.y >= 200 || f.x + f.width <= 0 || f.y + f.height <= 0).toBe(true)
  })

  it('selected frames become groups top-left first, named after the frames', () => {
    const fake = fakeCanvas([
      el('b', 'frame', { x: 500, y: 0, name: 'Blue' }),
      el('a', 'frame', { x: 0, y: 0, name: '' }),
      el('c', 'frame', { x: 0, y: 400, name: 'Green' }),
      el('n', 'stickynote'),
    ])
    fake.canvas.select(['c', 'b', 'a', 'n'])
    const frames = selectedFrames(fake.canvas)
    expect(frames.map((f) => f.id)).toEqual(['a', 'b', 'c'])
    expect(groupsFromFrames(frames)).toEqual([
      { name: 'Group 1', frameId: 'shape:a' },
      { name: 'Blue', frameId: 'shape:b' },
      { name: 'Green', frameId: 'shape:c' },
    ])
  })
})
