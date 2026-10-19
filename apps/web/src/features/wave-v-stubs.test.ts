// The wave V web side shared by the workstreams (docs/WAVE-V-CONTRACTS.md §6): the switches (all off; a web switch needs
// the api's too), the three wave V features (registered empty), the Facilitate menu's registry (entries after the six
// built-ins, pill parts per board page), the top-centre 'breakout' slot, the recap's sources, the Export section id and
// the /j/:code route. Each workstream pins its own feature in its own tests; this file pins what they share.
import {
  LIVE_SWITCHES_OFF,
  PENDING_PALETTE_COMMAND_IDS,
  WAVE_V_PALETTE_COMMAND_IDS,
} from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasFeatureContext } from '../canvas/api/index.ts'
import { slotOrder, TOP_CENTRE_SLOTS } from '../canvas/overlay/top-centre.ts'
import { matchRoute } from '../lib/routing.ts'
import {
  collectRecapSections,
  RECAP_SECTION_LINES_MAX,
  type RecapSourceSpec,
  recapSources,
  registerRecapSource,
} from './ai/recap/sources.ts'
import { CANVAS_FEATURES } from './canvas-registry.ts'
import {
  LIVE_FLAG_KEYS,
  LIVE_FLAG_SERVER,
  LIVE_FLAGS,
  type LiveFlags,
  liveEnabled,
  liveFlags,
  liveSwitches,
  setLiveSwitches,
} from './live/index.ts'
import { registerExportSection } from './present-export/ported/export-sections.ts'
import { loadWorkshop, workshopKit } from './workshops/ported/ctx-kit.ts'
import {
  type FacilitateEntrySpec,
  facilitateExtras,
  facilitatePillExtras,
  registerFacilitateEntry,
  setFacilitatePill,
} from './workshops/ported/facilitate-entries.ts'
import { facilitatePill, pillText } from './workshops/ported/guest-chrome.ts'
import { FacilitateMenu } from './workshops/ported/WorkshopBar.tsx'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  setLiveSwitches(null)
})

const ALL_ON: LiveFlags = { activities: true, joinCodes: true, breakouts: true, summary: true }
const SERVER_ON = { activities: true, joinCodes: true, breakouts: true }

describe('the wave V switches', () => {
  it('ship off, and a production page ignores any override', () => {
    expect(Object.values(LIVE_FLAGS).every((v) => v === false)).toBe(true)
    expect(Object.keys(LIVE_FLAG_KEYS).sort()).toEqual(Object.keys(LIVE_FLAGS).sort())
    expect(Object.keys(LIVE_FLAG_SERVER).sort()).toEqual(Object.keys(LIVE_FLAGS).sort())
    expect(liveFlags(false, () => '1')).toEqual(LIVE_FLAGS)
  })

  it('a dev-auth page may turn each on or off; a blocked store keeps the shipped value', () => {
    const store: Record<string, string> = { [LIVE_FLAG_KEYS.breakouts]: '1', [LIVE_FLAG_KEYS.summary]: '0' }
    const f = liveFlags(true, (k) => store[k])
    expect(f).toEqual({ activities: false, joinCodes: false, breakouts: true, summary: false })
    expect(
      liveFlags(true, () => {
        throw new Error('blocked')
      }),
    ).toEqual(LIVE_FLAGS)
  })

  it('a feature is offered only with its web switch AND the api switch it needs (the summary needs none)', () => {
    // the api told nothing yet (or is older than wave V): all off
    expect(liveSwitches.get()).toEqual(LIVE_SWITCHES_OFF)
    for (const flag of ['activities', 'joinCodes', 'breakouts'] as const) {
      expect(liveEnabled(flag, ALL_ON), flag).toBe(false)
      expect(liveEnabled(flag, ALL_ON, { ...LIVE_SWITCHES_OFF, [flag]: true }), flag).toBe(true)
      expect(liveEnabled(flag, LIVE_FLAGS, SERVER_ON), flag).toBe(false)
    }
    expect(liveEnabled('summary', ALL_ON, LIVE_SWITCHES_OFF)).toBe(true)
    expect(liveEnabled('summary', LIVE_FLAGS, SERVER_ON)).toBe(false)
    // the session sets what the api said; anything not exactly true is off
    setLiveSwitches({ activities: true, breakouts: 'yes' as unknown as boolean })
    expect(liveSwitches.get()).toEqual({ activities: true, joinCodes: false, breakouts: false })
    expect(liveEnabled('activities', ALL_ON)).toBe(true)
    setLiveSwitches(undefined)
    expect(liveSwitches.get()).toEqual(LIVE_SWITCHES_OFF)
  })

  it('the wave V palette commands are pending (no feature registers them yet)', () => {
    for (const id of WAVE_V_PALETTE_COMMAND_IDS)
      expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
  })
})

describe('the wave V features', () => {
  it('are registered empty, after the wave T ones and before the Elements panel (still the last)', () => {
    const ids = CANVAS_FEATURES.map((f) => f.id)
    const at = (id: string) => ids.indexOf(id)
    for (const id of ['live-activities', 'join', 'breakouts']) {
      const f = CANVAS_FEATURES.find((x) => x.id === id)
      expect(f, id).toBeDefined()
      expect(Object.keys(f ?? {}), id).toEqual(['id'])
      expect(at(id), id).toBeGreaterThan(at('timeline'))
      expect(at(id), id).toBeLessThan(at('elements'))
    }
    expect(ids.at(-1)).toBe('elements')
  })

  it('the top-centre stack has the breakouts chip right under the session timer', () => {
    expect(slotOrder('breakout')).toBe(slotOrder('timer') + 1)
    expect(TOP_CENTRE_SLOTS.indexOf('spotlight')).toBe(slotOrder('breakout') + 1)
  })

  it('/j/:code is the join page route', () => {
    expect(matchRoute('/j/ABCD-2345')).toEqual({ name: 'join', code: 'ABCD-2345' })
  })

  it('the Export dialog takes a session-csv section (an id of ExportSectionId: this compiles)', () => {
    const off = registerExportSection({
      id: 'session-csv',
      order: 50,
      offered: () => false,
      Section: () => null,
    })
    expect(typeof off).toBe('function')
    off()
  })
})

describe('the Facilitate menu registry', () => {
  const Item =
    (id: string) =>
    ({ close }: { close(refocus: boolean): void }) =>
      createElement(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'dr-wk-menu__item',
          'data-testid': `extra-${id}`,
          onClick: () => close(true),
        },
        id,
      )
  const spec = (over: Partial<FacilitateEntrySpec>): FacilitateEntrySpec => ({
    id: 'activities',
    order: 100,
    shown: () => true,
    Item: Item(over.id ?? 'activities'),
    ...over,
  })

  it('shows registered entries in order, only when they say so; a throwing shown() is left out; removal works', async () => {
    const kit = workshopKit()
    const input = { ctx: kit.ctx as CanvasFeatureContext, guest: false, facilitator: true }
    cleanups.push(registerFacilitateEntry(spec({ id: 'breakouts', order: 300 })))
    cleanups.push(
      registerFacilitateEntry(spec({ id: 'activities', order: 100, shown: (i) => i.facilitator })),
    )
    const remove = registerFacilitateEntry(
      spec({
        id: 'join-code',
        order: 200,
        shown: () => {
          throw new Error('broken')
        },
      }),
    )
    expect(facilitateExtras(input).map((e) => e.id)).toEqual(['activities', 'breakouts'])
    expect(facilitateExtras({ ...input, facilitator: false }).map((e) => e.id)).toEqual(['breakouts'])
    remove()
    cleanups.push(registerFacilitateEntry(spec({ id: 'join-code', order: 50 })))
    expect(facilitateExtras(input).map((e) => e.id)).toEqual(['join-code', 'activities', 'breakouts'])
  })

  it('renders the entries after the built-ins, which keep their order and test ids', async () => {
    const kit = workshopKit()
    await loadWorkshop(kit, { timer: null, vote: null, serverNow: new Date().toISOString() })
    cleanups.push(registerFacilitateEntry(spec({ id: 'breakouts', order: 300 })))
    cleanups.push(registerFacilitateEntry(spec({ id: 'activities', order: 100 })))
    const extras = facilitateExtras({ ctx: kit.ctx as CanvasFeatureContext, guest: false, facilitator: true })
    const html = renderToStaticMarkup(
      createElement(FacilitateMenu, {
        id: 'm',
        ctx: kit.ctx,
        store: kit.store,
        snap: kit.store.getSnapshot(),
        entries: ['timer', 'reactions', 'voting'],
        extras,
        facilitator: true,
        timer: { display: 'idle', remaining: 0 },
        onShow: () => {},
        onClose: () => {},
      }),
    )
    const ids = [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1])
    expect(ids).toEqual([
      'facilitate-menu',
      'timer-pill',
      'reactions-button',
      'vote-chip',
      'extra-activities',
      'extra-breakouts',
    ])
    expect(html.match(/role="menuitem"/g)).toHaveLength(5)
  })

  it('pill parts are per board page, in entry order, after the built-in parts', () => {
    const a = {}
    const b = {}
    setFacilitatePill(a, 'breakouts', { text: 'Group 2 · 8:30', spoken: 'breakouts, group 2' })
    setFacilitatePill(a, 'activities', { text: 'Poll', spoken: 'a poll is open' })
    expect(facilitatePillExtras(a).map((p) => p.id)).toEqual(['activities', 'breakouts'])
    expect(facilitatePillExtras(b)).toEqual([])
    setFacilitatePill(a, 'activities', { text: 'x'.repeat(40), spoken: 'long' })
    expect(facilitatePillExtras(a)[0]?.text).toHaveLength(24)
    setFacilitatePill(a, 'activities', null)
    expect(facilitatePillExtras(a).map((p) => p.id)).toEqual(['breakouts'])
    const parts = facilitatePill({
      timer: 'running',
      clock: '4:58',
      voteOpen: true,
      brainstormOpen: false,
      hands: 0,
      extras: facilitatePillExtras(a),
    })
    expect(pillText(parts)).toBe('4:58 · Vote · Group 2 · 8:30')
    // without extras the pill is as before wave V
    expect(
      pillText(
        facilitatePill({ timer: 'idle', clock: '0:00', voteOpen: false, brainstormOpen: false, hands: 0 }),
      ),
    ).toBe('')
  })
})

describe('the recap sources', () => {
  const input = () => ({
    ctx: {} as CanvasFeatureContext,
    scope: 'session' as const,
    since: null,
    now: Date.now(),
  })
  const src = (over: Partial<RecapSourceSpec> & Pick<RecapSourceSpec, 'id'>): RecapSourceSpec => ({
    order: 10,
    collect: async () => ({ id: over.id, title: over.id, lines: [{ text: 'one' }] }),
    ...over,
  })

  it('every source is asked; failing, late, empty, null or mislabelled sections are left out; lines are capped', async () => {
    cleanups.push(
      registerRecapSource(
        src({
          id: 'breakouts',
          order: 30,
          collect: async () => ({
            id: 'breakouts',
            title: 'Breakouts',
            lines: Array.from({ length: 15 }, (_, i) => ({ text: `Group ${i + 1}` })),
          }),
        }),
      ),
    )
    cleanups.push(registerRecapSource(src({ id: 'activities', order: 10 })))
    cleanups.push(
      registerRecapSource(
        src({
          id: 'word-clouds',
          order: 20,
          collect: async () => {
            throw new Error('down')
          },
        }),
      ),
    )
    expect(recapSources().map((s) => s.id)).toEqual(['activities', 'word-clouds', 'breakouts'])
    const sections = await collectRecapSections(input(), 200)
    expect(sections.map((s) => s.id)).toEqual(['activities', 'breakouts'])
    expect(sections[1]?.lines).toHaveLength(RECAP_SECTION_LINES_MAX)

    for (const collect of [
      () => new Promise<never>(() => {}), // never answers: the timeout
      async () => null,
      async () => ({ id: 'activities' as const, title: 'x', lines: [{ text: '  ' }] }),
      async () => ({ id: 'activities' as const, title: 'x', lines: [{ text: 'mislabelled' }] }),
    ]) {
      cleanups.push(registerRecapSource(src({ id: 'word-clouds', order: 20, collect })))
      const got = await collectRecapSections(input(), 50)
      expect(got.map((s) => s.id)).toEqual(['activities', 'breakouts'])
    }
  })

  it('an aborted recap collects nothing', async () => {
    cleanups.push(registerRecapSource(src({ id: 'activities' })))
    const ctl = new AbortController()
    ctl.abort()
    expect(await collectRecapSections({ ...input(), signal: ctl.signal }, 50)).toEqual([])
  })
})
