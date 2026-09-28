// The live controller's rule (reconcile): what this tab does follows from the api's state, this tab's
// id and this person's choice. A fake presenter stands in for present-session.ts (no editor, no DOM).
import type { LivePresentation, PresentLiveState } from '@draftroom/contracts'
import { atom, type Editor } from 'tldraw'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FeatureContext } from '../../types.ts'
import type {
  Presenter,
  PresentLeader,
  PresentRole,
  PresentState,
  StartOptions,
  StopInfo,
  StopOptions,
} from '../present-session.ts'
import { getLive, mountLive } from './controller.ts'
import { presenterTabId } from './tab.ts'

const ME = 'usr_meeeeeeeeeeee'
const ANN = 'usr_annnnnnnnnnnn'
const ID = 'prs_AAAAAAAAAAAAAAAAAAAA'
const OTHER_TAB = 'tab_otherotherotherother'

// The controller listens for the tab coming to the front; node has no document.
const g = globalThis as { document?: unknown }
const hadDocument = 'document' in g
beforeAll(() => {
  if (!hadDocument)
    g.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
})
afterAll(() => {
  if (!hadDocument) delete g.document
})

function fakePresenter() {
  const state = atom<PresentState | null>('fake-present', null)
  const listeners = new Set<(i: StopInfo) => void>()
  const log: string[] = []
  const slides = ['shape:f0', 'shape:f1', 'shape:f2']
  const presenter = {
    state,
    slides: () => [],
    order: () => [],
    current: () => {
      const s = state.get()
      return s
        ? { index: s.index, slide: { id: s.slideId, name: '', bounds: { x: 0, y: 0, w: 1, h: 1 } }, count: 3 }
        : { index: -1, slide: null, count: 3 }
    },
    isPresenting: () => state.get() !== null,
    start(opts: StartOptions = {}) {
      if (state.get()) return { ok: false, reason: 'already' }
      const role = opts.role ?? 'presenter'
      log.push(
        `start ${role} ${opts.slideId ?? '-'} fullscreen=${String(opts.fullscreen ?? role === 'presenter')}`,
      )
      const index = opts.slideId ? Math.max(0, slides.indexOf(opts.slideId)) : 0
      state.set({
        slideId: (opts.slideId ?? slides[0]) as never,
        index,
        mode: 'window',
        gridOpen: false,
        saved: {} as never,
        role,
        leader: opts.leader ?? null,
      })
      return { ok: true }
    },
    stop(opts: StopOptions = {}) {
      const s = state.get()
      if (!s) return
      log.push(`stop ${opts.reason ?? 'local'} ${opts.view ?? 'restore'}`)
      state.set(null)
      for (const l of listeners) l({ role: s.role, reason: opts.reason ?? 'local' })
    },
    go() {},
    goTo(i: number) {
      const s = state.get()
      if (s && s.role === 'presenter') state.set({ ...s, index: i, slideId: slides[i] as never })
    },
    role: () => state.get()?.role ?? null,
    setRole(role: PresentRole, leader: PresentLeader | null = null) {
      const s = state.get()
      if (!s || (s.role === role && s.leader?.name === leader?.name)) return
      log.push(`role ${role}${leader ? ` ${leader.name}` : ''}`)
      state.set({ ...s, role, leader })
    },
    follow(slideId: string | null) {
      const s = state.get()
      if (s?.role !== 'follower' || s.slideId === slideId) return
      log.push(`follow ${slideId}`)
      state.set({ ...s, slideId: slideId as never, index: Math.max(0, slides.indexOf(slideId ?? '')) })
    },
    onStop(l: (i: StopInfo) => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    setGridOpen() {},
    settle() {},
    setOverlayElement() {},
  }
  return { presenter: presenter as unknown as Presenter, log }
}

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | undefined
  resolve(v: unknown): void
  reject(e: unknown): void
}

function setup() {
  const calls: Call[] = []
  const notices: string[] = []
  const listeners: ((d: unknown) => void)[] = []
  const resyncs: (() => void)[] = []
  const editor = {} as Editor
  const ctx = {
    editor,
    board: { id: 'b-board000001', status: 'active', title: 'Board' },
    role: 'editor',
    me: { user: { id: ME, name: 'Me' } },
    api: {
      request: (method: string, path: string, o: { body?: Record<string, unknown> }) =>
        new Promise((resolve, reject) => calls.push({ method, path, body: o.body, resolve, reject })),
    },
    events: {
      on: (_t: string, fn: (d: unknown) => void) => {
        listeners.push(fn)
        return () => {}
      },
      onResync: (fn: () => void) => {
        resyncs.push(fn)
        return () => {}
      },
    },
    notify: (n: { text: string }) => void notices.push(n.text),
  } as unknown as FeatureContext
  const { presenter, log } = fakePresenter()
  const unmount = mountLive(ctx, presenter)
  const live = getLive(editor)
  if (!live) throw new Error('not mounted')
  const tab = presenterTabId()
  let n = 0
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  /** The api's state as an event (what every browser on the board receives). */
  const event = async (presentation: LivePresentation | null, kind = 'slide', by: string | null = null) => {
    for (const l of listeners)
      l({
        presentation,
        change: {
          kind,
          reason: kind === 'ended' ? 'stopped' : null,
          byUserId: by,
          byName: by ? 'Ann' : null,
        },
        version: { epoch: 'e1', n: ++n },
      })
    await settle()
  }
  const respond = async (call: Call | undefined, presentation: LivePresentation | null, epoch = 'e1') => {
    const s: PresentLiveState = { presentation, version: { epoch, n: ++n }, serverNow: '' }
    call?.resolve(s)
    await settle()
  }
  const pres = (over: Partial<LivePresentation> = {}): LivePresentation => ({
    id: ID,
    presenter: { userId: ME, name: 'Me' },
    tab,
    slideId: 'shape:f0',
    index: 0,
    count: 3,
    startedAt: '',
    presenterOnline: true,
    followers: [],
    followerCount: 0,
    ...over,
  })
  const annPres = (over: Partial<LivePresentation> = {}) =>
    pres({ presenter: { userId: ANN, name: 'Ann' }, tab: 'tab_annannannannannann', ...over })
  return {
    live,
    presenter,
    log,
    calls,
    notices,
    event,
    respond,
    settle,
    pres,
    annPres,
    tab,
    unmount,
    resyncs,
  }
}

const posts = (calls: Call[], suffix: string) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith(`/presentation${suffix}`))

describe('present-live controller', () => {
  it('presenter: Invite everyone, slides go to the api, Exit ends it for everyone', async () => {
    const t = setup()
    t.presenter.start()
    // (its request is answered below)
    const invite = t.live.inviteEveryone()
    await t.settle()
    const start = posts(t.calls, '')[0]
    expect(start?.body).toMatchObject({ tab: t.tab, slideId: 'shape:f0', index: 0, count: 3 })
    await t.respond(start, t.pres())
    await invite
    expect(t.live.presentingLive.get()).toBe(true)
    t.presenter.goTo(2)
    await t.settle()
    expect(posts(t.calls, '/slide')[0]?.body).toMatchObject({
      id: ID,
      tab: t.tab,
      slideId: 'shape:f2',
      index: 2,
    })
    t.presenter.stop()
    await t.settle()
    expect(posts(t.calls, '/stop')[0]?.body).toEqual({ id: ID })
    expect(t.live.presentingLive.get()).toBe(false)
    t.unmount()
  })

  it('follower: the invitation waits for a choice; Join follows the slides; the end brings them back', async () => {
    const t = setup()
    await t.event(t.annPres(), 'started', ANN)
    expect(t.presenter.isPresenting()).toBe(false) // nobody is pulled in without saying yes
    t.live.join()
    await t.settle()
    expect(posts(t.calls, '/follow')[0]?.body).toEqual({ id: ID, following: true })
    expect(t.log).toContain('start follower shape:f0 fullscreen=false')
    expect(t.presenter.state.get()?.leader).toEqual({ userId: ANN, name: 'Ann' })
    await t.event(t.annPres({ slideId: 'shape:f2', index: 2 }))
    expect(t.log).toContain('follow shape:f2')
    await t.event(null, 'ended', ANN)
    expect(t.log.at(-1)).toBe('stop remote here')
    expect(t.notices.at(-1)).toBe('Ann ended the presentation.')
    t.unmount()
  })

  it('follower: Stop following (Esc) steps out and remembers "not now"; the chip rejoins', async () => {
    const t = setup()
    await t.event(t.annPres(), 'started', ANN)
    t.live.join()
    await t.settle()
    t.live.stepOut()
    await t.settle()
    expect(t.log.at(-1)).toBe('stop local here')
    expect(t.live.store.intentFor(ID)).toBe('declined')
    expect(posts(t.calls, '/follow').map((c) => c.body?.following)).toEqual([true, false])
    // A new slide does not pull them back in.
    await t.event(t.annPres({ slideId: 'shape:f1', index: 1 }))
    expect(t.presenter.isPresenting()).toBe(false)
    t.live.join()
    await t.settle()
    expect(t.presenter.role()).toBe('follower')
    t.unmount()
  })

  it('hand-off to me while following: this tab takes it and turns into the presenter', async () => {
    const t = setup()
    await t.event(t.annPres({ slideId: 'shape:f1', index: 1 }), 'started', ANN)
    t.live.join()
    await t.settle()
    await t.event(t.pres({ tab: null, slideId: 'shape:f1', index: 1 }), 'handoff', ANN)
    const claim = posts(t.calls, '')[0]
    expect(claim?.body).toMatchObject({ tab: t.tab, slideId: 'shape:f1', index: 1 })
    await t.respond(claim, t.pres({ slideId: 'shape:f1', index: 1 }))
    expect(t.log).toContain('role presenter')
    expect(t.live.presentingLive.get()).toBe(true)
    expect(t.live.flash.get()?.text).toBe('Ann handed the presentation to you. Use ← and → to change slides.')
    t.unmount()
  })

  it('hand-off away from me: I keep watching as a follower', async () => {
    const t = setup()
    t.presenter.start()
    await t.event(t.pres(), 'started', ME)
    expect(t.live.presentingLive.get()).toBe(true)
    await t.event(t.annPres({ tab: null }), 'handoff', ME)
    expect(t.log).toContain('role follower Ann')
    expect(t.live.store.intentFor(ID)).toBe('following')
    expect(posts(t.calls, '/stop')).toHaveLength(0)
    t.unmount()
  })

  it('a reload of the presenting tab goes back to presenting at the current slide (no full screen)', async () => {
    const t = setup()
    await t.event(t.pres({ slideId: 'shape:f2', index: 2 }), 'slide', ME)
    expect(t.log).toContain('start presenter shape:f2 fullscreen=false')
    expect(t.live.presentingLive.get()).toBe(true)
    t.unmount()
  })

  it('another tab of mine presents: this one does not, and offers "Present here"', async () => {
    const t = setup()
    t.presenter.start()
    await t.event(t.pres(), 'started', ME)
    await t.event(t.pres({ tab: OTHER_TAB }), 'claimed', ME)
    expect(t.log.at(-1)).toBe('stop remote restore')
    expect(t.notices.at(-1)).toBe('You are presenting from another tab now.')
    t.unmount()
  })

  it('stepping out while the api restarts stays stepped out when the presentation comes back', async () => {
    const t = setup()
    await t.event(t.annPres(), 'started', ANN)
    t.live.join()
    await t.settle()
    await t.respond(
      posts(t.calls, '/follow')[0],
      t.annPres({ followers: [{ userId: ME, name: 'Me', guest: false }], followerCount: 1 }),
    )
    // The api restarts: it has no presentation until Ann's tab puts it back.
    for (const f of t.resyncs) f()
    await t.settle()
    await t.respond(
      t.calls.find((c) => c.method === 'GET'),
      null,
      'e2',
    )
    expect(t.presenter.role()).toBe('follower') // "Reconnecting to the presentation…"
    t.live.stepOut()
    await t.settle()
    expect(t.presenter.isPresenting()).toBe(false)
    const followsBefore = posts(t.calls, '/follow').length
    // Ann's tab puts the same presentation back: this person said no, so they are not pulled back in.
    await t.event(t.annPres({ slideId: 'shape:f1', index: 1 }), 'resumed', ANN)
    expect(t.presenter.isPresenting()).toBe(false)
    expect(t.live.store.intentFor(ID)).toBe('declined')
    expect(posts(t.calls, '/follow')).toHaveLength(followsBefore)
    t.unmount()
  })

  it('an api restart: the presenting tab puts the same presentation back', async () => {
    const t = setup()
    t.presenter.start()
    await t.event(t.pres({ slideId: 'shape:f1', index: 1 }), 'started', ME)
    for (const f of t.resyncs) f()
    await t.settle()
    const get = t.calls.find((c) => c.method === 'GET')
    await t.respond(get, null, 'e2')
    const resume = posts(t.calls, '')[0]
    expect(resume?.body).toMatchObject({ resumeId: ID, tab: t.tab })
    t.unmount()
  })
})
