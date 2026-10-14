import { describe, expect, it } from 'vitest'
import {
  barWidthAt,
  COMPACT_STEPS,
  CONN_TITLE,
  compactValue,
  type DotSave,
  firstFittingLevel,
  hasContent,
  MIN_TITLE_CHARS,
  mayLeaveMenu,
  statusView,
  titleFits,
  titleNeed,
  topBarPlan,
} from './topbar-fit.ts'

describe('compactValue', () => {
  it('lists the first n steps, each level keeping the ones before it', () => {
    expect(compactValue(0)).toBe('')
    expect(compactValue(1)).toBe('link')
    expect(compactValue(2)).toBe('link status')
    expect(compactValue(COMPACT_STEPS.length)).toBe(COMPACT_STEPS.join(' '))
    expect(compactValue(-1)).toBe('')
  })

  it('drops the sharing badge words first and the Present label last', () => {
    expect(COMPACT_STEPS[0]).toBe('link')
    expect(COMPACT_STEPS[COMPACT_STEPS.length - 1]).toBe('present')
  })
})

describe('titleNeed / titleFits', () => {
  const eightPx = (text: string) => Array.from(text).length * 8

  it('a short title must show in full', () => {
    const need = titleNeed('Lobby tour', eightPx, 14)
    expect(need).toBe(Number.POSITIVE_INFINITY)
    expect(titleFits({ client: 94, scroll: 94, need })).toBe(true)
    expect(titleFits({ client: 60, scroll: 94, need })).toBe(false) // "Lobby t…"
  })

  it(`a long title needs ${MIN_TITLE_CHARS} characters and an ellipsis`, () => {
    const title = 'Launch trailer workshop, round two'
    const need = titleNeed(title, eightPx, 14)
    expect(need).toBe((MIN_TITLE_CHARS + 1) * 8 + 14)
    expect(titleFits({ client: need, scroll: 300, need })).toBe(true)
    expect(titleFits({ client: need - 10, scroll: 300, need })).toBe(false)
    expect(titleFits({ client: 300, scroll: 300, need })).toBe(true)
  })

  it('counts characters, not UTF-16 units', () => {
    const title = `${'é'.repeat(MIN_TITLE_CHARS)}🎬 extra`
    expect(titleNeed(title, eightPx, 0)).toBe((MIN_TITLE_CHARS + 1) * 8)
  })

  it('no title element (renaming) fits', () => {
    expect(titleFits(null)).toBe(true)
  })
})

describe('firstFittingLevel', () => {
  it('stops at the first level that fits and applies nothing past it', () => {
    const tried: number[] = []
    expect(
      firstFittingLevel((l) => {
        tried.push(l)
        return l >= 2
      }),
    ).toBe(2)
    expect(tried).toEqual([0, 1, 2])
  })

  it('is null when even the most compact bar is too full (the "⋯" menu)', () => {
    const tried: number[] = []
    expect(
      firstFittingLevel((l) => {
        tried.push(l)
        return false
      }),
    ).toBeNull()
    expect(tried).toEqual(Array.from({ length: COMPACT_STEPS.length + 1 }, (_, i) => i))
  })
})

describe('mayLeaveMenu', () => {
  it('waits for the bar to grow past the width that needed the menu', () => {
    expect(mayLeaveMenu(1000, 1000)).toBe(false)
    expect(mayLeaveMenu(1010, 1000)).toBe(false)
    expect(mayLeaveMenu(1017, 1000)).toBe(true)
  })
})

describe('hasContent (W5-50: the phone "⋯" menu draws no caption over nothing)', () => {
  it('nothing, undefined, false and an empty string draw nothing', () => {
    for (const none of [null, undefined, false, ''] as const) expect(hasContent(none)).toBe(false)
  })

  it('an element, text and a list of them draw something', () => {
    expect(hasContent({ type: 'ul', props: {} })).toBe(true)
    expect(hasContent('3 people')).toBe(true)
    expect(hasContent([{ type: 'li' }])).toBe(true)
    expect(hasContent(0)).toBe(true) // a rendered zero is text
  })
})

// ---- K2-5 (wave K): the calmer bar ------------------------------------------------------------------------------

describe('topBarPlan: the new item list by width (K2-5)', () => {
  it('1440 px: everything in the bar, Feedback first, one status dot, no "⋯" menu', () => {
    const p = topBarPlan(barWidthAt(1440))
    expect(p.bar).toEqual(['feedback', 'live', 'people', 'status', 'features', 'share', 'account'])
    expect(p.menu).toEqual([])
    // one dot for Saved and Live; no separate comment tool (the toolbar has it)
    expect(p.bar.filter((x) => x === 'status')).toHaveLength(1)
    expect(p.bar).not.toContain('comments')
  })

  it('1280 px: the same bar; when even the most compact bar is too full, the feature controls go into "⋯"', () => {
    expect(barWidthAt(1280)).toBe('wide')
    expect(topBarPlan('wide', false)).toEqual(topBarPlan(barWidthAt(1440)))
    const crowded = topBarPlan(barWidthAt(1280), true)
    expect(crowded.bar).toEqual([
      'feedback',
      'live',
      'people',
      'status',
      'pinned',
      'overflow',
      'share',
      'account',
    ])
    expect(crowded.menu).toEqual(['features'])
    // Feedback stays visible (its label goes first: the "feedback" compact step)
    expect(COMPACT_STEPS).toContain('feedback')
    expect(COMPACT_STEPS.indexOf('feedback')).toBeLessThan(COMPACT_STEPS.indexOf('present'))
  })

  it('375 px: the bell, the comment tool, Feedback, the people list and the account move into "⋯"', () => {
    expect(barWidthAt(375)).toBe('phone')
    const p = topBarPlan(barWidthAt(375))
    expect(p.bar).toEqual(['live', 'status', 'pinned', 'overflow', 'share'])
    expect(p.menu).toEqual(['features', 'comments', 'people', 'feedback', 'account'])
  })

  it('the breakpoints are the bar’s own (768 px tablet, 480 px phone)', () => {
    expect([1440, 1280, 769, 768, 481, 480, 375].map(barWidthAt)).toEqual([
      'wide',
      'wide',
      'wide',
      'tablet',
      'tablet',
      'phone',
      'phone',
    ])
    expect(topBarPlan('tablet').menu).toEqual(['features'])
  })
})

describe('statusView: one dot for Saved and Live (K2-5)', () => {
  const save = (state: DotSave['state'], extra: Partial<DotSave> = {}): DotSave => ({
    state,
    rejection: null,
    readonly: false,
    ...extra,
  })

  it('saved and live: the dot alone; the tooltip and the screen-reader text say both', () => {
    const v = statusView(save('saved'), 'online')
    expect(v.tone).toBe('ok')
    expect(v.label).toBeNull()
    expect(v.saveText).toBe('Saved')
    expect(v.connText).toBe('Live')
    expect(v.title).toMatch(/^Saved: /)
    expect(v.title).toMatch(/Connected: your changes are sent to everyone/)
  })

  it('never says Saved before sync is live', () => {
    for (const conn of ['connecting', 'offline', 'error'] as const) {
      const v = statusView(save('saved'), conn)
      expect(v.saveText, conn).toBe('')
      expect(v.label ?? '', conn).not.toMatch(/Saved/)
      expect(v.title, conn).not.toMatch(/Saved/)
    }
    const connecting = statusView(save('connecting'), 'connecting')
    expect(connecting.tone).toBe('busy')
    expect(connecting.label).toBe('Connecting…')
    expect(connecting.title).not.toMatch(/Saved/)
  })

  it('offline: amber words beside the dot, from the engine’s own line when it has one', () => {
    const v = statusView(save('offline-pending', { label: 'Offline — 3 changes on this device' }), 'offline')
    expect(v.tone).toBe('warn')
    expect(v.label).toBe('Offline — 3 changes on this device')
    expect(v.saveText).toBe('Offline — 3 changes on this device')
    expect(v.connText).toBe('Offline')
    expect(v.title).toMatch(/^Offline: changes are kept in this tab only/)
    const quiet = statusView(save('offline'), 'offline')
    expect(quiet.label).toBe('Offline')
  })

  it('a refused change or an ended connection is red, with its words', () => {
    expect(statusView(save('rejected'), 'online')).toMatchObject({
      tone: 'danger',
      label: 'Change not saved',
    })
    expect(statusView(save('error'), 'error')).toMatchObject({
      tone: 'danger',
      label: 'Not saved — connection ended',
    })
  })

  it('"Saving…" of every edit is the dot alone (a busy dot), so the bar does not flicker words', () => {
    expect(statusView(save('saving'), 'online')).toMatchObject({
      tone: 'busy',
      label: null,
      saveText: 'Saving…',
    })
  })

  it('N1: a board showing this device’s last copy says so beside the dot, not just “Connecting…” (the canvas pill’s words)', () => {
    const v = statusView(save('cached', { label: 'Showing your last copy · connecting' }), 'connecting')
    expect(v.tone).toBe('busy')
    expect(v.label).toBe('Showing your last copy · connecting')
    expect(v.saveText).toBe('Showing your last copy · connecting')
    // without the engine's own line, the indicator's words for the state
    expect(statusView(save('cached'), 'connecting').label).toBe('Showing your last copy · connecting')
    // a plain connect (no copy shown) still says Connecting…
    expect(statusView(save('connecting'), 'connecting').label).toBe('Connecting…')
  })

  it('a viewer with the role pill: the connection alone', () => {
    const v = statusView(save('readonly', { readonly: true }), 'online', true)
    expect(v).toMatchObject({ tone: 'ok', label: null, saveText: '', connText: 'Live' })
    expect(v.title).toBe(`${CONN_TITLE.online}.`)
  })
})

describe('topBarPlan: Feedback is for the team (P-023)', () => {
  it('without it, no width has Feedback in the bar or in the menu; the rest is as it was', () => {
    for (const width of ['wide', 'tablet', 'phone'] as const)
      for (const crowded of [false, true]) {
        const plan = topBarPlan(width, crowded, false)
        const same = topBarPlan(width, crowded)
        expect(plan.bar).not.toContain('feedback')
        expect(plan.menu).not.toContain('feedback')
        expect(plan.bar).toEqual(same.bar.filter((p) => p !== 'feedback'))
        expect(plan.menu).toEqual(same.menu.filter((p) => p !== 'feedback'))
      }
  })
})
