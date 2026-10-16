// WS5 (wave T): the timeline. Layout (ruler, lanes, bars, caps), the drag/resize/nudge maths and their clamps, the
// primitives and the export markup (literal colours, text as <text>, no clip path, rx with ry), the feature's
// registration, the new-timeline command, and the rule that only the acting tab writes: drawing, laying out and
// exporting never call `transact`.

import {
  addDays,
  CARD_DUE_KEY,
  CARD_START_KEY,
  TimelineValue as TimelineSchema,
  type TimelineValue,
} from '@draftroom/canvas-schema/planning'
import { PLANNING_REV } from '@draftroom/canvas-schema/protocol'
import { PENDING_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { CANVAS_FEATURES } from '../canvas-registry.ts'
import { PLANNING_FLAG_KEYS } from '../planning/index.ts'
import { exportOverlayLayers, svgWithOverlays } from '../present-export/ported/badges.ts'
import { rangeAroundToday, rangeProblem, writeTimeline } from './Controls.tsx'
import { timelineCards, titleOf } from './cards.ts'
import { createTimeline, newTimelineValue, TIMELINE_NEW_COMMAND_ID } from './commands.ts'
import { nextUnitStart, shiftMonths, todayOf, unitEnd } from './dates.ts'
import { datePatch, nudgeDates, pointerDates, sameDates } from './drag.ts'
import { TIMELINE_EXPORT_LAYER, timelineSvg } from './export.ts'
import { feature } from './index.tsx'
import { barBox, fitText, layoutTimeline, MAX_BARS, onTimeline, type TimelineCard } from './layout.ts'
import { setMemberNames } from './names.ts'
import { TimelineLayer } from './Overlay.tsx'
import { barPrims, DARK, framePrims, LIGHT, primsSvg } from './paint.ts'

const T: TimelineValue = { start: '2026-10-05', end: '2026-12-27', scale: 'week', lanes: 'none' }
const SIZE = { width: 1400, height: 520 }

const card = (id: string, over: Partial<TimelineCard> = {}): TimelineCard => ({
  id,
  title: id,
  status: 'doing',
  who: null,
  start: null,
  due: '2026-10-20',
  tags: [],
  locked: false,
  ...over,
})
const layout = (cards: TimelineCard[], t: TimelineValue = T, extra: object = {}) =>
  layoutTimeline({ t, size: SIZE, cards, today: '2026-10-14', ...extra })

describe('dates', () => {
  it('moves by units: a week keeps the weekday, a month keeps the day where it can', () => {
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(shiftMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(shiftMonths('2026-03-15', -3)).toBe('2025-12-15')
    expect(nextUnitStart('2026-10-14', 'week')).toBe('2026-10-19')
    expect(unitEnd('2026-10-14', 'week')).toBe('2026-10-18')
    expect(unitEnd('2026-10-14', 'month')).toBe('2026-10-31')
    expect(unitEnd('2026-12-14', 'month')).toBe('2026-12-31')
    expect(unitEnd('2026-10-14', 'day')).toBe('2026-10-14')
  })
  it('today is the viewer’s own calendar day', () => {
    expect(todayOf(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05')
  })
})

describe('layout', () => {
  it('draws a bar from start to due (inclusive) and a card with only a due date as a milestone', () => {
    const l = layout([
      card('bar', { start: '2026-10-12', due: '2026-10-16' }),
      card('ms', { due: '2026-10-20' }),
    ])
    const px = SIZE.width / 84 // 12 weeks
    const bar = l.bars.find((b) => b.id === 'bar')
    expect(bar?.kind).toBe('bar')
    expect(bar?.x).toBeCloseTo(7 * px, 5)
    expect(bar?.w).toBeCloseTo(5 * px, 5)
    const ms = l.bars.find((b) => b.id === 'ms')
    expect(ms?.kind).toBe('milestone')
    // centred on the middle of its due day
    expect((ms?.x ?? 0) + (ms?.w ?? 0) / 2).toBeCloseTo(15.5 * px, 5)
    expect(l.shown).toBe(2)
  })

  it('keeps only cards with a due date in range (and the tag when the timeline names one)', () => {
    const cards = [
      card('in', { due: '2026-11-01' }),
      card('before', { due: '2026-09-30' }),
      card('after', { due: '2026-12-28' }),
      card('none', { due: null }),
      card('edge-start', { due: '2026-10-05' }),
      card('edge-end', { due: '2026-12-27' }),
      card('tagged', { due: '2026-11-02', tags: [{ key: 'launch', name: 'Launch' }] }),
    ]
    expect(
      layout(cards)
        .bars.map((b) => b.id)
        .sort(),
    ).toEqual(['edge-end', 'edge-start', 'in', 'tagged'])
    const tagged = layout(cards, { ...T, tag: 'launch' })
    expect(tagged.bars.map((b) => b.id)).toEqual(['tagged'])
    expect(onTimeline(T, card('x', { due: '2026-10-05' }))).toBe(true)
  })

  it('a bar that starts before the range is clipped to its left edge and says so', () => {
    const l = layout([card('long', { start: '2026-09-01', due: '2026-10-09' })])
    expect(l.bars[0]?.x).toBe(0)
    expect(l.bars[0]?.clippedLeft).toBe(true)
    expect(barBox(T, l.axis, '2026-09-01', '2026-10-09').clippedLeft).toBe(true)
  })

  it('packs overlapping bars into rows and keeps the cards in due order', () => {
    const l = layout([
      card('a', { start: '2026-10-06', due: '2026-10-20' }),
      card('b', { start: '2026-10-08', due: '2026-10-12' }),
      card('c', { start: '2026-10-22', due: '2026-10-25' }),
    ])
    const rowOf = (id: string) => l.bars.find((b) => b.id === id)?.row
    expect(rowOf('a')).not.toBe(rowOf('b'))
    expect(rowOf('c')).toBe(rowOf('b'))
    // the lane is as tall as its rows need
    expect(l.lanes).toHaveLength(1)
  })

  it('lanes by status in the status order, only the ones in use; an empty board shows a hint and no lanes', () => {
    const l = layout(
      [card('d', { status: 'done' }), card('t', { status: 'todo' }), card('d2', { status: 'doing' })],
      { ...T, lanes: 'status' },
    )
    expect(l.lanes.map((x) => x.label)).toEqual(['To do', 'In progress', 'Done'])
    expect(l.axis.x).toBeGreaterThan(0)
    const empty = layout([], { ...T, lanes: 'status' })
    expect(empty.lanes).toEqual([])
    expect(primsSvg(framePrims(empty, LIGHT))).toContain('No cards with a due date in this range')
  })

  it('lanes by assignee: by name, "No assignee" last, "Assigned" until the members are known, a missing member named so', () => {
    const cards = [
      card('a', { who: 'u-b' }),
      card('b', { who: 'u-a' }),
      card('c', { who: null }),
      card('d', { who: 'u-gone' }),
    ]
    const t: TimelineValue = { ...T, lanes: 'assignee' }
    const names = new Map([
      ['u-a', 'Ada'],
      ['u-b', 'Bo'],
    ])
    expect(layout(cards, t, { names }).lanes.map((x) => x.label)).toEqual([
      'Ada',
      'Bo',
      'No longer on this board',
      'No assignee',
    ])
    expect(layout(cards, t, { names: null }).lanes.map((x) => x.label)).toEqual([
      'Assigned',
      'Assigned',
      'Assigned',
      'No assignee',
    ])
  })

  it('lanes by tag: a card goes to its first tag, the rest to "Untagged"', () => {
    const l = layout(
      [
        card('a', { tags: [{ key: 'b', name: 'Beta' }] }),
        card('b', {
          tags: [
            { key: 'a', name: 'Alpha' },
            { key: 'b', name: 'Beta' },
          ],
        }),
        card('c'),
      ],
      { ...T, lanes: 'tag' },
    )
    expect(l.lanes.map((x) => x.label)).toEqual(['Alpha', 'Beta', 'Untagged'])
  })

  it('caps the bars at 500 and says how many it left out', () => {
    const many = Array.from({ length: 812 }, (_, i) =>
      card(`c${String(i).padStart(4, '0')}`, { due: '2026-11-01' }),
    )
    const big = layoutTimeline({
      t: T,
      size: { width: 1400, height: 100_000 },
      cards: many,
      today: '2026-10-14',
    })
    expect(MAX_BARS).toBe(500)
    expect(big.inRange).toBe(812)
    expect(big.capped).toBe(312)
    expect(big.shown).toBe(500)
    expect(primsSvg(framePrims(big, LIGHT))).toContain('Showing 500 of 812')
  })

  it('cards under the frame’s bottom edge are counted, not drawn outside it', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      card(`c${i}`, { start: '2026-10-06', due: '2026-12-01' }),
    )
    const l = layout(many)
    expect(l.below).toBeGreaterThan(0)
    expect(l.shown + l.below).toBe(60)
    for (const b of l.bars) expect(b.y + b.h).toBeLessThanOrEqual(SIZE.height)
    expect(primsSvg(framePrims(l, LIGHT))).toContain('Make the frame taller')
  })

  it('marks overdue bars (a due date before today, not done) and the today line inside the range only', () => {
    const l = layout([
      card('late', { due: '2026-10-08' }),
      card('done', { due: '2026-10-08', status: 'done' }),
      card('ahead', { due: '2026-11-08' }),
    ])
    expect(l.bars.filter((b) => b.overdue).map((b) => b.id)).toEqual(['late'])
    expect(l.todayX).not.toBeNull()
    expect(layout([], T, { today: '2027-03-01' }).todayX).toBeNull()
    expect(layoutTimeline({ t: T, size: SIZE, cards: [], today: '2026-09-01' }).todayX).toBeNull()
  })

  it('the ruler: month names over the days, a tick per week with a label that fits, majors on month starts', () => {
    const l = layout([])
    expect(l.months.map((m) => m.label)).toEqual(['October 2026', 'November 2026', 'December 2026'])
    expect(l.ticks.length).toBe(12) // one per week, the first Monday (the range start) included
    expect(l.ticks[0]?.label).toMatch(/^\d+ [A-Z][a-z]{2}$/)
    const months: TimelineValue = { start: '2026-01-01', end: '2026-12-31', scale: 'month', lanes: 'none' }
    const m = layout([], months)
    expect(m.months.map((x) => x.label)).toEqual(['2026'])
    expect(m.ticks.map((x) => x.label).slice(0, 3)).toEqual(['Jan', 'Feb', 'Mar'])
    const days: TimelineValue = { start: '2026-10-05', end: '2026-10-25', scale: 'day', lanes: 'none' }
    expect(layout([], days).ticks.map((x) => x.label)[0]).toBe('5')
  })

  it('cuts a long label to fit and gives a narrow bar its label outside', () => {
    expect(fitText('A very long card title indeed', 60, 12)).toMatch(/…$/)
    expect(fitText('Hi', 60, 12)).toBe('Hi')
    expect(fitText('Anything', 10, 12)).toBe('')
    const l = layout([
      card('wide', { title: 'Write the launch brief', start: '2026-10-06', due: '2026-10-30' }),
      card('narrow', { title: 'Sign-off', start: '2026-11-02', due: '2026-11-02' }),
    ])
    expect(l.bars.find((b) => b.id === 'wide')?.labelInside).toBe(true)
    expect(l.bars.find((b) => b.id === 'narrow')?.labelInside).toBe(false)
  })
})

describe('dragging, resizing and nudging', () => {
  const axis = { x: 0, w: 1400 }
  const px = 1400 / 84
  const xOfDay = (n: number) => (n + 0.5) * px // the middle of day n of the range
  const bar = { start: '2026-10-12', due: '2026-10-16' }

  it('moves both dates by whole weeks on a week scale (the weekday stays)', () => {
    const next = pointerDates({ t: T, axis, orig: bar, mode: 'move', grabX: xOfDay(8), curX: xOfDay(8 + 15) })
    expect(next).toEqual({ start: '2026-10-26', due: '2026-10-30' })
    // less than half a week: no move
    expect(
      sameDates(
        pointerDates({ t: T, axis, orig: bar, mode: 'move', grabX: xOfDay(8), curX: xOfDay(10) }),
        bar,
      ),
    ).toBe(true)
  })

  it('moves by days on a day scale and by months on a month scale', () => {
    const day: TimelineValue = { ...T, scale: 'day' }
    expect(
      pointerDates({ t: day, axis, orig: bar, mode: 'move', grabX: xOfDay(8), curX: xOfDay(11) }),
    ).toEqual({
      start: '2026-10-15',
      due: '2026-10-19',
    })
    const month: TimelineValue = { start: '2026-01-01', end: '2026-12-31', scale: 'month', lanes: 'none' }
    const ppx = 1400 / 365
    const out = pointerDates({
      t: month,
      axis,
      orig: { start: '2026-03-10', due: '2026-03-20' },
      mode: 'move',
      grabX: 70 * ppx,
      curX: 101 * ppx,
    })
    expect(out).toEqual({ start: '2026-04-10', due: '2026-04-20' })
  })

  it('an edge snaps to the unit: the start to its Monday, the end to its Sunday, never past the other edge', () => {
    expect(pointerDates({ t: T, axis, orig: bar, mode: 'start', grabX: 0, curX: xOfDay(2) })).toEqual({
      start: '2026-10-05',
      due: '2026-10-16',
    })
    expect(pointerDates({ t: T, axis, orig: bar, mode: 'end', grabX: 0, curX: xOfDay(18) })).toEqual({
      start: '2026-10-12',
      due: '2026-10-25',
    })
    // dragging the start edge past the due date stops at the due date
    expect(pointerDates({ t: T, axis, orig: bar, mode: 'start', grabX: 0, curX: xOfDay(40) }).start).toBe(
      '2026-10-16',
    )
    // and the end edge before the start stops at the start
    expect(pointerDates({ t: T, axis, orig: bar, mode: 'end', grabX: 0, curX: xOfDay(1) }).due).toBe(
      '2026-10-12',
    )
  })

  it('a milestone moves its due date; the due date never leaves the range', () => {
    const ms = { start: null, due: '2026-10-20' }
    expect(
      pointerDates({ t: T, axis, orig: ms, mode: 'move', grabX: xOfDay(15), curX: xOfDay(15 + 14) }),
    ).toEqual({
      start: null,
      due: '2026-11-03',
    })
    // far past the end: held at the last whole step inside the range
    const far = pointerDates({ t: T, axis, orig: ms, mode: 'move', grabX: xOfDay(15), curX: 10_000 })
    expect(far.due <= T.end).toBe(true)
    expect(far.due > ms.due).toBe(true)
    // a start edge on a milestone is a move (it has no edges)
    expect(
      pointerDates({ t: T, axis, orig: ms, mode: 'start', grabX: xOfDay(15), curX: xOfDay(22) }).due,
    ).toBe('2026-10-27')
  })

  it('arrow keys: one unit; Shift moves the end edge only', () => {
    expect(nudgeDates(T, bar, 'move', 1)).toEqual({ start: '2026-10-19', due: '2026-10-23' })
    expect(nudgeDates(T, bar, 'move', -1)).toEqual({ start: '2026-10-05', due: '2026-10-09' })
    expect(nudgeDates(T, bar, 'end', 1)).toEqual({ start: '2026-10-12', due: '2026-10-23' })
    // the end edge cannot cross the start
    expect(nudgeDates(T, { start: '2026-10-12', due: '2026-10-14' }, 'end', -1)).toEqual({
      start: '2026-10-12',
      due: '2026-10-12',
    })
    const m: TimelineValue = { start: '2026-01-01', end: '2026-12-31', scale: 'month', lanes: 'none' }
    expect(nudgeDates(m, { start: '2026-03-10', due: '2026-03-31' }, 'end', 1)).toEqual({
      start: '2026-03-10',
      due: '2026-04-30',
    })
    // a milestone's Shift press moves it
    expect(nudgeDates(T, { start: null, due: '2026-10-20' }, 'end', 1)).toEqual({
      start: null,
      due: '2026-10-27',
    })
    // nothing moves out of the range
    expect(
      sameDates(nudgeDates(T, { start: null, due: '2026-12-27' }, 'move', 1), {
        start: null,
        due: '2026-12-27',
      }),
    ).toBe(true)
  })

  it('writes only the keys that changed', () => {
    expect(datePatch(bar, { start: '2026-10-19', due: '2026-10-23' })).toEqual({
      [CARD_START_KEY]: '2026-10-19',
      [CARD_DUE_KEY]: '2026-10-23',
    })
    expect(datePatch(bar, { start: '2026-10-12', due: '2026-10-23' })).toEqual({
      [CARD_DUE_KEY]: '2026-10-23',
    })
    expect(datePatch({ start: null, due: '2026-10-20' }, { start: null, due: '2026-10-27' })).toEqual({
      [CARD_DUE_KEY]: '2026-10-27',
    })
    expect(datePatch(bar, bar)).toEqual({})
  })

  it('every result satisfies the server’s rule: start <= due', () => {
    for (const mode of ['move', 'start', 'end'] as const)
      for (let x = -200; x <= 1700; x += 37) {
        const out = pointerDates({ t: T, axis, orig: bar, mode, grabX: xOfDay(9), curX: x })
        if (out.start !== null) expect(out.start <= out.due).toBe(true)
      }
  })
})

describe('what is drawn', () => {
  const l = layout(
    [
      card('a', {
        title: 'Write <the> brief & more',
        start: '2026-10-06',
        due: '2026-10-30',
        status: 'review',
        who: 'u1',
      }),
      card('b', { title: 'Done thing', due: '2026-11-10', status: 'done' }),
      card('c', { title: 'Stuck', start: '2026-11-02', due: '2026-11-05', status: 'blocked' }),
      card('d', { title: 'Plan', start: '2026-11-09', due: '2026-11-13', status: 'todo' }),
      card('e', { title: 'Build', start: '2026-11-16', due: '2026-11-27', status: 'doing' }),
    ],
    { ...T, lanes: 'status' },
  )

  const all = (palette = LIGHT) =>
    primsSvg([...framePrims(l, palette), ...l.bars.flatMap((b) => barPrims(b, palette))])

  it('uses literal colours, text as <text>, no clip path, no variable, no external reference, no author', () => {
    const svg = all()
    expect(svg).toContain('<text')
    expect(svg).toContain('Write &lt;the&gt; brief &amp; more')
    expect(svg).not.toMatch(/var\(|clip-path|clipPath|<image|<use|href=|url\(|<style|<filter|<mask/)
    expect(svg).not.toContain('u1')
  })

  it('a rect with a corner radius carries both rx and ry (the vector PDF page reads only matched pairs)', () => {
    for (const m of all().matchAll(/<rect [^>]*>/g)) {
      const tag = m[0]
      expect(/ rx=/.test(tag)).toBe(/ ry=/.test(tag))
    }
  })

  it('shows every status by a marker shape as well as a colour, and the dark palette differs only in colour', () => {
    for (const status of ['todo', 'doing', 'review', 'blocked', 'done'] as const) {
      const prims = barPrims(
        {
          ...(l.bars[0] as (typeof l.bars)[number]),
          card: { ...(l.bars[0] as (typeof l.bars)[number]).card, status },
        },
        LIGHT,
      )
      expect(prims.filter((p) => p.t === 'path').length, status).toBeGreaterThan(0)
    }
    expect(all(DARK).replace(/#[0-9a-f]{6}/gi, '#')).toBe(all(LIGHT).replace(/#[0-9a-f]{6}/gi, '#'))
  })

  it('the export markup is the same layout, placed by the export’s origin', () => {
    const els: Record<string, unknown>[] = [
      frameEl('tl', 1000, 500, T),
      cardEl('c1', 'Brief', { 'card:status': 'doing', 'card:start': '2026-10-06', 'card:due': '2026-10-09' }),
    ]
    const canvas = fakeCanvas(els)
    const svg = timelineSvg(canvas, 'tl', { x: 900, y: 450 }, '2026-10-14')
    expect(svg).toContain('transform="translate(100 50)"')
    expect(svg).toContain('data-dr-timeline-bar="c1"')
    expect(svg).toContain('>Brief<')
    expect(svg).toContain('>Today<')
  })
})

describe('registration', () => {
  it('the feature contributes a scene layer that takes no clicks, a palette command and an export layer', () => {
    expect(feature.id).toBe('timeline')
    expect(CANVAS_FEATURES.find((f) => f.id === 'timeline')).toBe(feature)
    expect(feature.overlays).toHaveLength(1)
    expect(feature.overlays?.[0]).toMatchObject({ layer: 'scene', pointer: 'none' })
    expect(feature.commands?.map((c) => c.id)).toEqual([TIMELINE_NEW_COMMAND_ID])
    expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).not.toContain(TIMELINE_NEW_COMMAND_ID)
    expect(TIMELINE_EXPORT_LAYER).toMatchObject({ id: 'timeline', order: 40 })
  })

  it('the export layer is registered on mount and taken out with it; the command follows the switch', () => {
    const off = feature.onMount?.({} as CanvasFeatureContext)
    expect(exportOverlayLayers().map((x) => x.id)).toContain('timeline')
    if (typeof off === 'function') off()
    expect(exportOverlayLayers().map((x) => x.id)).not.toContain('timeline')
    const cmd = feature.commands?.[0]
    // shipped on since the wave T integration; a dev-auth page that turns the switch off has no command
    expect(cmd?.available?.({} as CanvasFeatureContext)).toBe(true)
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === PLANNING_FLAG_KEYS.timeline ? '0' : null),
    })
    try {
      expect(cmd?.available?.({} as CanvasFeatureContext)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('switch on', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === PLANNING_FLAG_KEYS.timeline ? '1' : null),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('the command is offered; it needs a rev-14 room and an editor', () => {
    const cmd = feature.commands?.[0]
    const ctxOf = (rev: number | null, readOnly = false) =>
      ({ canvas: fakeCanvas([], { rev, readOnly }) }) as unknown as CanvasFeatureContext
    expect(cmd?.available?.(ctxOf(PLANNING_REV))).toBe(true)
    expect(cmd?.enabled?.(ctxOf(PLANNING_REV))).toBe(true)
    expect(cmd?.enabled?.(ctxOf(13))).toBe(false)
    expect(cmd?.enabled?.(ctxOf(null))).toBe(false)
    expect(cmd?.enabled?.(ctxOf(PLANNING_REV, true))).toBe(false)
  })

  it('makes one frame with the timeline key in one transaction, clear of the content, and selects it', () => {
    const canvas = fakeCanvas([cardEl('c0', 'x', { 'card:status': 'todo' })])
    const id = createTimeline({ canvas } as unknown as CanvasFeatureContext, '2026-10-14')
    expect(id).toBe('new-1')
    expect(canvas.log.transacts).toEqual(['New timeline'])
    const made = canvas.log.created[0] as Record<string, unknown>
    expect(made).toMatchObject({ width: 1400, height: 520, name: 'Timeline' })
    const value = (made.customData as { lobby: { timeline: unknown } }).lobby.timeline
    expect(TimelineSchema.safeParse(value).success).toBe(true)
    expect(value).toEqual({ start: '2026-10-12', end: '2027-01-03', scale: 'week', lanes: 'status' })
    expect(canvas.log.selected).toEqual([['new-1']])
    expect(newTimelineValue('2026-10-14')).toEqual(value)
  })

  it('makes nothing in a room that does not take planning keys', () => {
    const canvas = fakeCanvas([], { rev: 13 })
    expect(createTimeline({ canvas } as unknown as CanvasFeatureContext)).toBeNull()
    expect(canvas.log.transacts).toEqual([])
  })

  it('exports each timeline in the export, and none that is not in it', () => {
    const els = [frameEl('tl', 100, 80, T), frameEl('other', 900, 80, T)]
    const canvas = fakeCanvas(els)
    expect(TIMELINE_EXPORT_LAYER.active(canvas)).toBe(true)
    const unregister = feature.onMount?.({} as CanvasFeatureContext)
    const svg = svgWithOverlays('<svg viewBox="0 0 600 300"></svg>', {
      canvas,
      exported: new Set(['tl']),
      origin: { x: 0, y: 0 },
    })
    if (typeof unregister === 'function') unregister()
    expect(svg).toContain('data-dr-timeline="tl"')
    expect(svg).not.toContain('data-dr-timeline="other"')
    expect(TIMELINE_EXPORT_LAYER.active(fakeCanvas([]))).toBe(false)
  })
})

describe('the layer', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === PLANNING_FLAG_KEYS.timeline ? '1' : null),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const html = (els: Record<string, unknown>[], o: { rev?: number | null; readOnly?: boolean } = {}) => {
    const canvas = fakeCanvas(els, o)
    const ctx = {
      canvas,
      api: { listMembers: async () => [] },
      board: { id: 'b1' },
    } as unknown as CanvasFeatureContext
    return { canvas, out: renderToStaticMarkup(createElement(TimelineLayer, { ctx })) }
  }
  const els = () => [
    frameEl('tl', 40, 60, T),
    cardEl('c1', 'Write the brief', {
      'card:status': 'doing',
      'card:start': '2026-10-12',
      'card:due': '2026-10-16',
    }),
    cardEl('c2', 'Launch', { 'card:status': 'todo', 'card:due': '2026-11-02' }),
    cardEl('c3', 'Out of range', { 'card:status': 'todo', 'card:due': '2027-05-02' }),
    cardEl('c4', 'No date', { 'card:status': 'todo' }),
  ]

  it('draws an svg over the frame with a focusable bar per card in range, and writes nothing', () => {
    const { canvas, out } = html(els())
    expect(out).toContain('data-testid="timeline"')
    expect(out.match(/data-testid="timeline-bar"/g)).toHaveLength(2)
    expect(out).toContain('data-card-id="c1"')
    expect(out).toContain('data-kind="milestone"')
    expect(out).not.toContain('data-card-id="c3"')
    expect(out).not.toContain('group)')
    expect(out).toContain('role="button"')
    expect(out).toContain('tabindex="0"')
    expect(out).toContain('aria-label="Write the brief, In progress, 2026-10-12 to 2026-10-16"')
    expect(out).toContain('data-editable="true"')
    expect(canvas.log.transacts).toEqual([])
  })

  it('a read-only page and an older room draw the bars without drag', () => {
    expect(html(els(), { readOnly: true }).out).not.toContain('data-editable')
    expect(html(els(), { rev: 13 }).out).not.toContain('data-editable')
    expect(html(els(), { readOnly: true }).out).toContain('data-testid="timeline-bar"')
  })

  it('draws nothing with the switch off, or with no timeline', () => {
    expect(html([cardEl('c1', 'x', { 'card:status': 'todo', 'card:due': '2026-10-12' })]).out).toBe('')
    // the switch turned off (shipped on since the wave T integration)
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === PLANNING_FLAG_KEYS.timeline ? '0' : null),
    })
    expect(html(els()).out).toBe('')
  })
})

describe('only the person who acts writes', () => {
  it('reading, laying out and exporting call no write (a receiving client pushes nothing)', () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === PLANNING_FLAG_KEYS.timeline ? '1' : null),
    })
    try {
      const canvas = fakeCanvas([
        frameEl('tl', 0, 0, { ...T, lanes: 'assignee' }),
        cardEl('c1', 'One', { 'card:status': 'todo', 'card:due': '2026-10-20', 'card:who': 'u1' }),
      ])
      setMemberNames(canvas, new Map([['u1', 'Ada']]))
      const cards = timelineCards(canvas)
      expect(cards.map((c) => c.id)).toEqual(['c1'])
      expect(
        layout(cards, { ...T, lanes: 'assignee' }, { names: new Map([['u1', 'Ada']]) }).lanes[0]?.label,
      ).toBe('Ada')
      expect(timelineSvg(canvas, 'tl', { x: 0, y: 0 })).toContain('Ada')
      expect(canvas.log.transacts).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the strip writes the frame’s one key, validated, in one transaction; a bad range writes nothing', () => {
    const canvas = fakeCanvas([frameEl('tl', 0, 0, T)])
    const ctx = { canvas } as unknown as CanvasFeatureContext
    expect(writeTimeline(ctx, 'tl', { ...T, scale: 'month' })).toBe(true)
    expect(canvas.log.updates).toEqual([
      ['tl', { customData: { lobby: { timeline: { ...T, scale: 'month' } } } }],
    ])
    expect(writeTimeline(ctx, 'tl', { ...T, end: '2030-01-01' })).toBe(false)
    expect(writeTimeline(ctx, 'tl', { ...T, scale: 'year' })).toBe(false)
    expect(canvas.log.transacts).toEqual(['Change timeline'])
    expect(rangeProblem('2026-10-05', '2026-10-01')).toMatch(/on or after/)
    expect(rangeProblem('2026-01-01', '2028-06-01')).toMatch(/two years/)
    expect(rangeProblem('2026-01-01', '2026-06-01')).toBeNull()
    expect(rangeProblem('', '2026-06-01')).toMatch(/Pick/)
  })

  it('"Go to today" keeps the length and puts today a quarter of the way in', () => {
    const r = rangeAroundToday(T, '2026-10-14')
    expect(r).not.toBeNull()
    expect(rangeProblem(r?.start ?? '', r?.end ?? '')).toBeNull()
    expect(addDays(r?.start ?? '', 83)).toBe(r?.end)
    expect(r?.start).toBe('2026-09-21') // 21 days before, on a Monday
  })

  it('titles are the first line of the card’s text', () => {
    expect(titleOf('\n  Launch plan \nsecond line')).toBe('Launch plan')
    expect(titleOf('')).toBe('')
  })
})

// ---- a fake canvas ----------------------------------------------------------------------------------------------

function frameEl(id: string, x: number, y: number, value: TimelineValue): Record<string, unknown> {
  return {
    id,
    type: 'frame',
    isDeleted: false,
    frameId: null,
    x,
    y,
    width: SIZE.width,
    height: SIZE.height,
    angle: 0,
    groupIds: [],
    locked: false,
    name: 'Timeline',
    customData: { lobby: { timeline: value } },
  }
}
function cardEl(id: string, text: string, lobby: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    type: 'rectangle',
    isDeleted: false,
    frameId: null,
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    angle: 0,
    groupIds: [],
    locked: false,
    text,
    customData: { lobby },
  }
}

function fakeCanvas(
  elements: Record<string, unknown>[],
  o: { rev?: number | null; readOnly?: boolean } = {},
) {
  const els = elements as unknown as CanvasElement[]
  const log = {
    transacts: [] as string[],
    updates: [] as [string, unknown][],
    created: [] as unknown[],
    selected: [] as string[][],
  }
  let n = 0
  const canvas = {
    index: {
      withLobbyKey: (key: string) => els.filter((e) => key in (e.customData?.lobby ?? {})),
      byFrame: (id: string) => els.filter((e) => e.frameId === id),
    },
    items: () => els,
    get: (id: string) => els.find((e) => e.id === id),
    bounds: (id: string) => {
      const e = els.find((x) => x.id === id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    isLocked: () => false,
    isHidden: () => false,
    theme: () => 'light',
    selection: [] as string[],
    sceneToOverlay: (p: { x: number; y: number }) => p,
    readOnly: () => o.readOnly === true,
    room: { contractsRev: () => (o.rev === undefined ? PLANNING_REV : o.rev) },
    doc: { entries: () => new Map() },
    text: {
      of: (id: string) => String((els.find((e) => e.id === id) as { text?: string } | undefined)?.text ?? ''),
    },
    viewport: {
      get: () => ({ x: 0, y: 0, width: 1600, height: 900, zoom: 0.5 }),
      ensureVisible: () => {},
      screenRect: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
    },
    select: (ids: string[]) => log.selected.push(ids),
    transact: (label: string, fn: (tx: unknown) => unknown) => {
      log.transacts.push(label)
      return fn({
        create: (_kind: string, props: unknown) => {
          log.created.push(props)
          return `new-${++n}`
        },
        update: (id: string, patch: unknown) => log.updates.push([id, patch]),
      })
    },
    log,
  }
  return canvas as unknown as LobbyCanvas & { log: typeof log }
}
