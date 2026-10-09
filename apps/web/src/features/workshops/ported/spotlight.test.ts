// L5-2 spotlight, the web side: which objects a selection names, where the cut-out is (it follows the camera and
// the elements, and notices they are gone), who is looking, the words, the store's state (versioned, per-person
// Esc, notices) and what the layer draws. The api is apps/api/test/features/workshops/spotlight.test.ts; the
// browsers are e2e/excalidraw/l5-spotlight.spec.ts.
import { readFileSync } from 'node:fs'
import { SPOTLIGHT_MAX_REFS, type Spotlight, type WorkshopSpotlightEvent } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { spotlightKey } from '../store.ts'
import { loadWorkshop, ME, workshopKit } from './ctx-kit.ts'
import { SpotlightLayer } from './SpotlightLayer.tsx'
import {
  endedText,
  lookingCount,
  lookingText,
  SPOTLIGHT_PAD_PX,
  spotlightRefsOf,
  spotlightShape,
  spotlightText,
  startRefusedText,
  viewsIntersect,
} from './spotlight.ts'
import { el, fakeCanvas, note } from './test-kit.ts'

const MAYA = 'usr_maya0000000001'
const version = (n: number) => ({ epoch: 'e1', n })
const spotlight = (refs: string[], over: Partial<Spotlight> = {}): Spotlight => ({
  refs,
  bringEveryone: false,
  by: { userId: MAYA, name: 'Maya Rao' },
  startedAt: '2026-10-09T10:00:00.000Z',
  endsAt: '2026-10-09T10:05:00.000Z',
  version: version(1),
  ...over,
})
const event = (s: Spotlight | null, n: number, reason: WorkshopSpotlightEvent['reason'] = null) => ({
  spotlight: s,
  version: version(n),
  reason,
  endedBy: null,
})

describe('which objects a selection names', () => {
  it('a bound label stands for its note; repeats, deleted and collapsed ones are left out; refs are shape:<id>', () => {
    const f = fakeCanvas([
      ...note('n1', 'one'),
      ...note('n2', 'two'),
      el('gone', 'rectangle', { isDeleted: true }),
      el('hid', 'rectangle'),
    ])
    const canvas = { get: f.canvas.get, isHidden: (id: string) => id === 'hid' }
    expect(spotlightRefsOf(canvas, ['n1-label', 'n1', 'n2', 'gone', 'hid', 'nope'])).toEqual({
      refs: ['shape:n1', 'shape:n2'],
      tooMany: false,
    })
  })

  it('ids the api cannot name are left out; more than the api takes is refused whole', () => {
    const many = Array.from({ length: SPOTLIGHT_MAX_REFS + 5 }, (_, i) => el(`r${i}`, 'rectangle'))
    const f = fakeCanvas([...many, el('a.b', 'rectangle')])
    const canvas = { get: f.canvas.get, isHidden: () => false }
    const out = spotlightRefsOf(canvas, [...many.map((m) => m.id), 'a.b'])
    expect(out.tooMany).toBe(true)
    expect(out.refs).toHaveLength(SPOTLIGHT_MAX_REFS)
    expect(out.refs).not.toContain('shape:a.b')
  })
})

describe('the cut-out follows the viewport and the elements', () => {
  const board = () =>
    fakeCanvas([
      el('a', 'stickynote', { x: 100, y: 200, width: 200, height: 200 }),
      el('b', 'stickynote', { x: 500, y: 200, width: 200, height: 200 }),
    ])

  it('is the objects’ union in overlay pixels plus the pad, and it moves with the camera', () => {
    const f = board()
    const refs = ['shape:a', 'shape:b']
    const s = spotlightShape(f.canvas, refs)
    expect(s.found).toBe(2)
    expect(s.scene).toEqual({ x: 100, y: 200, width: 600, height: 200 })
    expect(s.rect).toEqual({
      x: 100 - SPOTLIGHT_PAD_PX,
      y: 200 - SPOTLIGHT_PAD_PX,
      w: 600 + 2 * SPOTLIGHT_PAD_PX,
      h: 200 + 2 * SPOTLIGHT_PAD_PX,
    })
    // panned 50 px right and 20 px down: the same objects, 50 px left and 20 px up on screen
    f.viewport = { ...f.viewport, x: 50, y: 20 }
    expect(spotlightShape(f.canvas, refs).rect).toMatchObject({
      x: 50 - SPOTLIGHT_PAD_PX,
      y: 180 - SPOTLIGHT_PAD_PX,
    })
    // zoomed to 50%: the objects take half the screen space (the pad stays 24 px)
    f.viewport = { x: 0, y: 0, width: 2000, height: 1600, zoom: 0.5 }
    expect(spotlightShape(f.canvas, refs).rect).toEqual({
      x: 50 - SPOTLIGHT_PAD_PX,
      y: 100 - SPOTLIGHT_PAD_PX,
      w: 300 + 2 * SPOTLIGHT_PAD_PX,
      h: 100 + 2 * SPOTLIGHT_PAD_PX,
    })
  })

  it('follows an element that moves and one that is resized', () => {
    const f = board()
    const refs = ['shape:a']
    f.canvas.transact('move', (tx) => tx.update('a', { x: 1000, y: 0, width: 300 }))
    expect(spotlightShape(f.canvas, refs).scene).toEqual({ x: 1000, y: 0, width: 300, height: 200 })
  })

  it('counts what is left: deleted objects drop out, and with none left there is no cut-out to draw', () => {
    const f = board()
    const refs = ['shape:a', 'shape:b']
    f.canvas.transact('delete', (tx) => tx.delete('b'))
    const half = spotlightShape(f.canvas, refs)
    expect(half).toMatchObject({ found: 1, total: 2 })
    expect(half.scene).toEqual({ x: 100, y: 200, width: 200, height: 200 })
    f.canvas.transact('delete', (tx) => tx.delete('a'))
    expect(spotlightShape(f.canvas, refs)).toEqual({ scene: null, rect: null, found: 0, total: 2 })
  })

  it('views meet bounds only where they share area', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    expect(viewsIntersect(a, { x: 99, y: 99, width: 50, height: 50 })).toBe(true)
    expect(viewsIntersect(a, { x: 100, y: 0, width: 50, height: 50 })).toBe(false)
    expect(viewsIntersect(a, { x: -500, y: -500, width: 50, height: 50 })).toBe(false)
  })
})

describe('"N of M looking"', () => {
  const scene = { x: 0, y: 0, width: 400, height: 300 }
  const view = (x: number, y: number) => ({ x, y, width: 1000, height: 700 })
  it('counts the other people whose view meets the objects, each person once however many tabs', () => {
    const peers = [
      { uid: 'usr_a', view: view(-100, -100) }, // on it
      { uid: 'usr_a', view: view(5000, 5000) }, // a second tab of hers, away: still one person
      { uid: 'usr_b', view: view(5000, 5000) }, // away
      { uid: 'usr_c', view: null }, // not streamed
      { uid: ME, view: view(0, 0) }, // me: never counted
    ]
    const c = lookingCount({ peers, roster: ['usr_a', 'usr_b', 'usr_c', 'usr_d', ME], me: ME, scene })
    expect(c).toEqual({ looking: 1, total: 4 })
    expect(lookingText(c)).toBe('1 of 4 looking')
  })

  it('is nobody when the objects are gone, and ignores a view of someone who left the roster', () => {
    expect(lookingCount({ peers: [], roster: ['usr_a', ME], me: ME, scene: null })).toEqual({
      looking: 0,
      total: 1,
    })
    expect(
      lookingCount({ peers: [{ uid: 'usr_left', view: view(0, 0) }], roster: [ME], me: ME, scene }),
    ).toEqual({ looking: 0, total: 0 })
  })
})

describe('the words', () => {
  it('says who spotlights what', () => {
    const s = spotlight(['shape:a'])
    expect(spotlightText(s, ME)).toBe('Maya Rao is spotlighting this')
    expect(spotlightText(spotlight(['shape:a', 'shape:b', 'shape:c']), ME)).toBe(
      'Maya Rao is spotlighting 3 items',
    )
    expect(spotlightText(spotlight(['shape:a'], { by: { userId: ME, name: 'Fay' } }), ME)).toBe(
      'You are spotlighting this',
    )
  })

  it('says why it ended, and what a refusal means', () => {
    expect(endedText({ reason: 'ended', starterName: 'Maya', byName: 'Maya' })).toBe(
      'Maya ended the spotlight.',
    )
    expect(endedText({ reason: 'ended-by-owner', starterName: 'Maya', byName: 'Ada' })).toBe(
      'Ada ended Maya’s spotlight.',
    )
    expect(endedText({ reason: 'expired', starterName: 'Maya', byName: null })).toMatch(/five minutes/)
    expect(endedText({ reason: 'starter-left', starterName: 'Maya', byName: null })).toMatch(/Maya left/)
    expect(startRefusedText('GUEST_ACCOUNT_REQUIRED', 'x')).toMatch(/Sign in with an account/)
    expect(startRefusedText('RATE_LIMITED', 'x')).toMatch(/Wait a moment/)
    expect(startRefusedText('BAD_REQUEST', 'one of the objects is gone')).toBe('one of the objects is gone')
  })
})

describe('the store keeps the spotlight (versioned, per person, with a notice when it ends)', () => {
  it('takes the state from a refetch and from events; an older state never replaces a newer one', async () => {
    const kit = workshopKit({})
    await loadWorkshop(kit, {
      timer: null,
      vote: null,
      spotlight: spotlight(['shape:a']),
      spotlightVersion: version(1),
      serverNow: new Date().toISOString(),
    })
    expect(kit.store.getSnapshot().spotlight?.by.name).toBe('Maya Rao')
    // a newer state by event
    kit.events.emit('workshop.spotlight', event(spotlight(['shape:b'], { version: version(2) }), 2))
    expect(kit.store.getSnapshot().spotlight?.refs).toEqual(['shape:b'])
    // an older event (or response) arriving late changes nothing
    kit.events.emit('workshop.spotlight', event(spotlight(['shape:a']), 1))
    expect(kit.store.getSnapshot().spotlight?.refs).toEqual(['shape:b'])
    // it ended
    kit.events.emit('workshop.spotlight', event(null, 3, 'ended'))
    expect(kit.store.getSnapshot().spotlight).toBeNull()
    expect(kit.store.getSnapshot().spotlightEnded).toMatchObject({ reason: 'ended', starterName: 'Maya Rao' })
  })

  it('an api from before wave L (no spotlight, no version) means none; garbage events are ignored', async () => {
    const kit = workshopKit({})
    await loadWorkshop(kit, { timer: null, vote: null, serverNow: new Date().toISOString() })
    expect(kit.store.getSnapshot().spotlight).toBeNull()
    kit.events.emit('workshop.spotlight', { spotlight: 'nope' })
    kit.events.emit('workshop.spotlight', null)
    expect(kit.store.getSnapshot().spotlight).toBeNull()
  })

  it('an api restart (another epoch) with no spotlight clears it, with no "ended" notice', async () => {
    const kit = workshopKit({})
    kit.events.emit('workshop.spotlight', event(spotlight(['shape:a']), 5))
    expect(kit.store.getSnapshot().spotlight).not.toBeNull()
    await loadWorkshop(kit, {
      timer: null,
      vote: null,
      spotlight: null,
      spotlightVersion: { epoch: 'e2-restarted', n: 0 },
      serverNow: new Date().toISOString(),
    })
    expect(kit.store.getSnapshot().spotlight).toBeNull()
    expect(kit.store.getSnapshot().spotlightEnded).toBeNull()
  })

  it('Esc hides it for this person only, until a NEW spotlight starts; Show brings it back', () => {
    const kit = workshopKit({})
    const s1 = spotlight(['shape:a'], { version: version(1) })
    kit.events.emit('workshop.spotlight', event(s1, 1))
    expect(kit.store.getSnapshot()).toMatchObject({ spotlightHidden: false })
    kit.store.hideSpotlight()
    expect(kit.store.getSnapshot().spotlightHidden).toBe(true)
    expect(kit.store.getSnapshot().spotlight).not.toBeNull() // still the board's spotlight, for everyone else
    // the same spotlight with its refs changed (an update of the same state) stays hidden
    kit.events.emit('workshop.spotlight', event(s1, 2))
    expect(kit.store.getSnapshot().spotlightHidden).toBe(true)
    // a new one shows again
    const s2 = spotlight(['shape:b'], { version: version(3) })
    kit.events.emit('workshop.spotlight', event(s2, 3))
    expect(kit.store.getSnapshot().spotlightHidden).toBe(false)
    expect(spotlightKey(s1)).not.toBe(spotlightKey(s2))
    kit.store.hideSpotlight()
    kit.store.showSpotlight()
    expect(kit.store.getSnapshot().spotlightHidden).toBe(false)
  })

  it('starts and ends through the api, taking the answer as the new state', async () => {
    const kit = workshopKit({})
    const mine = spotlight(['shape:a', 'shape:b'], { by: { userId: ME, name: 'Fay' }, version: version(4) })
    kit.next(
      (m, p) => m === 'POST' && p.endsWith('/spotlight'),
      () => ({ spotlight: mine, version: version(4), serverNow: new Date().toISOString() }),
    )
    expect(await kit.store.startSpotlight(['shape:a', 'shape:b'], true)).toEqual({ ok: true })
    const call = kit.calls.find((c) => c.path.endsWith('/spotlight'))
    expect(call?.body).toEqual({ refs: ['shape:a', 'shape:b'], bringEveryone: true })
    expect(kit.store.getSnapshot().spotlight?.refs).toEqual(['shape:a', 'shape:b'])
    kit.next(
      (m, p) => m === 'POST' && p.endsWith('/spotlight/end'),
      () => ({ spotlight: null, version: version(5), serverNow: new Date().toISOString() }),
    )
    expect(await kit.store.endSpotlight()).toEqual({ ok: true })
    expect(kit.store.getSnapshot().spotlight).toBeNull()
    // a refusal comes back as words, not a throw
    kit.next(
      (m, p) => m === 'POST' && p.endsWith('/spotlight'),
      () => {
        throw Object.assign(new Error('Everyone was just shown something.'), { code: 'RATE_LIMITED' })
      },
    )
    expect(await kit.store.startSpotlight(['shape:a'])).toMatchObject({ ok: false, code: 'RATE_LIMITED' })
  })
})

describe('what the layer draws', () => {
  const html = (kit: ReturnType<typeof workshopKit>) =>
    renderToStaticMarkup(createElement(SpotlightLayer, { ctx: kit.ctx }))
  const withNotes = (others: { uid: string; name: string }[] = []) =>
    workshopKit({
      others,
      elements: [...note('n1', 'Weekly demo'), ...note('n2', 'Retro')].map((e) =>
        e.id === 'n1' ? { ...e, x: 100, y: 100 } : e,
      ),
    })

  it('nothing while there is no spotlight', () => {
    const h = html(withNotes())
    expect(h).not.toContain('spotlight-mask')
    expect(h).not.toContain('spotlight-bar')
    expect(h).toContain('data-active="false"')
  })

  it('a spotlight: the mask with its cut-out, the ring, who spotlights, and Hide; an owner may end it', () => {
    const kit = withNotes()
    kit.events.emit('workshop.spotlight', event(spotlight(['shape:n1']), 1))
    const h = html(kit)
    expect(h).toContain('data-testid="spotlight-mask"')
    expect(h).toMatch(/data-rect="76,76,248,248"/) // 100 - 24, 100 - 24, 200 + 48
    expect(h).toContain('data-testid="spotlight-ring"')
    expect(h).toContain('Maya Rao is spotlighting this')
    expect(h).toContain('data-testid="spotlight-hide"')
    expect(h).toContain('data-testid="spotlight-end"') // the kit's person is the board owner
    expect(h).not.toContain('spotlight-looking') // that count is the starter's
    expect(h).toContain('data-active="true"')
  })

  it('the starter sees "N of M looking" from the presence views', () => {
    const kit = withNotes([{ uid: 'usr_ben0000000001', name: 'Ben' }])
    const canvas = kit.ctx.canvas as unknown as { presence: { peers(): unknown[] } }
    canvas.presence.peers = () => [
      { uid: 'usr_ben0000000001', sid: 's1', view: { x: 0, y: 0, width: 800, height: 600 } },
    ]
    kit.events.emit(
      'workshop.spotlight',
      event(spotlight(['shape:n1'], { by: { userId: ME, name: 'Fay' } }), 1),
    )
    expect(html(kit)).toMatch(/data-testid="spotlight-looking"[^>]*>1 of 1 looking</)
    canvas.presence.peers = () => [
      { uid: 'usr_ben0000000001', sid: 's1', view: { x: 9000, y: 9000, width: 800, height: 600 } },
    ]
    expect(html(kit)).toMatch(/data-testid="spotlight-looking"[^>]*>0 of 1 looking</)
  })

  it('Esc (Hide) takes the dimming away for this person and leaves a way back', () => {
    const kit = withNotes()
    kit.events.emit('workshop.spotlight', event(spotlight(['shape:n1']), 1))
    kit.store.hideSpotlight()
    const h = html(kit)
    expect(h).not.toContain('spotlight-mask')
    expect(h).not.toContain('spotlight-bar')
    expect(h).toContain('data-testid="spotlight-show"')
    expect(h).toContain('data-active="false"')
  })

  it('when the spotlit objects are gone: no dimming, and "The spotlit items were removed"', () => {
    const kit = withNotes()
    kit.events.emit('workshop.spotlight', event(spotlight(['shape:n1']), 1))
    kit.ctx.canvas.transact('delete', (tx) => tx.delete('n1'))
    const h = html(kit)
    expect(h).not.toContain('spotlight-mask')
    expect(h).toContain('The spotlit items were removed')
    expect(h).toContain('data-testid="spotlight-hide"')
  })

  it('objects out of view are not dimmed around nothing: the bar offers "Show me"', () => {
    const kit = withNotes()
    kit.events.emit('workshop.spotlight', event(spotlight(['shape:n1']), 1))
    const f = kit.ctx.canvas as unknown as { viewport: { get(): unknown; set(v: object): void } }
    f.viewport.set({ x: 50_000, y: 50_000 })
    const h = html(kit)
    expect(h).not.toContain('spotlight-mask')
    expect(h).toContain('data-testid="spotlight-go"')
  })

  it('adds no live region over the canvas (the one board announcer speaks; the a11y audit allows only known ones)', () => {
    const kit = withNotes()
    kit.events.emit('workshop.spotlight', event(spotlight(['shape:n1']), 1))
    for (const h of [html(kit), html(withNotes())]) {
      expect(h).not.toContain('aria-live')
      expect(h).not.toMatch(/role="(status|alert)"/)
    }
    kit.store.hideSpotlight()
    expect(html(kit)).not.toContain('aria-live')
  })

  it('the stylesheet keeps the ring still and the dimming steady under reduced motion', () => {
    const css = readFileSync(new URL('./workshops-ported.css', import.meta.url), 'utf8')
    const block =
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.dr-wk-spot__dim \{[^}]*\}[\s\S]*?\n\}/.exec(css)?.[0]
    expect(block).toBeTruthy()
    expect(block).toMatch(/animation: none/)
    expect(block).toMatch(/\.dr-wk-spot\[data-motion="pulse"\] \.dr-wk-spot__ring::after/)
    // and the pulse only ever exists in the layer's "pulse" motion
    expect(css).toMatch(
      /\.dr-wk-spot\[data-motion="pulse"\] \.dr-wk-spot__ring::after \{[^}]*animation: dr-wk-spot-pulse/,
    )
  })
})
