// Wave T (CONTRACTS_REV 14): the planning key specs (planning-keys.ts, custom-data.ts), the per-element rules
// checkElement holds every writer to, `relink-keep`, and the pure model of planning.ts.
import {
  AI_STORYBOARD_ASPECTS,
  AI_STORYBOARD_DUR_MAX_MS,
  AI_STORYBOARD_DUR_MIN_MS,
  STRIP_KEYS_PREFIXES,
} from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { checkLobbyData, lobbyKeySpec, lobbyValueProblem } from './custom-data.ts'
import { checkElement, type WireElement } from './elements.ts'
import { indexKeysBetween, isValidIndexKey } from './engine/fractional.ts'
import { MAX_ALT_CHARS, MAX_LOBBY_CUSTOM_DATA_BYTES, MAX_TAGS_PER_ELEMENT } from './limits.ts'
import {
  addDays,
  bandAt,
  CARD_KEYS,
  type CardFields,
  cardOf,
  dateToX,
  dayNumber,
  formatDuration,
  formatRunningTime,
  isOrderKey,
  isOverdue,
  isPlanningKey,
  kanbanBands,
  kanbanColumns,
  needsRebalance,
  PLANNING_KEY_CLASSES,
  PLANNING_KEYS,
  panelPosBetween,
  panelsInOrder,
  parseDuration,
  planningElementProblem,
  rebalancedPositions,
  relinkKeep,
  SB_ASPECTS,
  SB_DUR_MAX_MS,
  SB_DUR_MIN_MS,
  SB_KEYS,
  shotNumbers,
  snapDate,
  storyboardsOf,
  storyboardTimings,
  timelineTicks,
  xToDate,
} from './planning.ts'
import { KANBAN_MAX_BYTES } from './planning-keys.ts'
import { LOBBY_KEY_ADDITIONS } from './protocol.ts'
import { SAMPLE_ELEMENTS } from './test-samples.ts'

const el = (base: keyof typeof SAMPLE_ELEMENTS, lobby: Record<string, unknown>, id?: string) =>
  ({
    ...SAMPLE_ELEMENTS[base],
    ...(id ? { id } : {}),
    customData: { lobby },
  }) as WireElement

describe('the planning key specs', () => {
  it('every planning key has an exact spec; unknown suffixes of the two prefix classes have none', () => {
    for (const k of PLANNING_KEYS) {
      expect(lobbyKeySpec(k)?.name, k).toBe(k)
      expect(isPlanningKey(k), k).toBe(true)
    }
    for (const k of ['card:', 'card:title', 'sb:', 'sb:number', 'kanbanx', 'timelines'])
      expect(lobbyKeySpec(k), k).toBeNull()
    expect(isPlanningKey('card:anything')).toBe(true)
    for (const k of ['tag:x', 'present', 'kind', 'cards']) expect(isPlanningKey(k), k).toBe(false)
    expect([...CARD_KEYS, ...SB_KEYS]).toHaveLength(8)
  })

  it('values: statuses, uids, real dates in 2000..2100, order keys, durations, the head, Kanban and timeline', () => {
    const ok: [string, unknown][] = [
      ['card:status', 'blocked'],
      ['card:who', 'usr_0123456789'],
      ['card:start', '2000-01-01'],
      ['card:due', '2100-12-31'],
      ['card:due', '2028-02-29'],
      ['sb:of', 'text-1'],
      ['sb:pos', 'a0'],
      ['sb:pos', 'a0V'],
      ['sb:dur', 100],
      ['sb:dur', 600_000],
      ['sb:head', { aspect: '2.39:1' }],
      [
        'sb:head',
        { aspect: '16:9', fps: 25, defaultMs: 1500, perRow: 12, audio: 'v-1', audioOffsetMs: -60_000 },
      ],
      ['kanban', {}],
      ['kanban', { labels: { todo: 'Backlog' }, hidden: ['blocked', 'review'], wip: { doing: 99 } }],
      ['timeline', { start: '2026-01-01', end: '2027-12-31', scale: 'month', lanes: 'tag', tag: 'launch' }],
    ]
    for (const [k, v] of ok) expect(lobbyValueProblem(k, v), `${k} ${JSON.stringify(v)}`).toBeNull()
    const bad: [string, unknown][] = [
      ['card:status', 'in-progress'],
      ['card:who', ''],
      ['card:who', 'u'.repeat(61)],
      ['card:due', '2027-02-29'],
      ['card:due', '1999-12-31'],
      ['card:due', '2101-01-01'],
      ['card:start', '2026-1-01'],
      ['sb:of', 'has space'],
      ['sb:pos', ''],
      ['sb:pos', 'a'],
      ['sb:pos', `a${'0'.repeat(64)}`],
      ['sb:dur', 99],
      ['sb:dur', 600_001],
      ['sb:dur', 2.5],
      ['sb:head', { aspect: '4:3' }],
      ['sb:head', { aspect: '16:9', fps: 23 }],
      ['sb:head', { aspect: '16:9', title: 'x' }],
      ['kanban', { hidden: ['todo', 'doing', 'review', 'blocked', 'done'] }],
      ['kanban', { hidden: ['todo', 'todo'] }],
      ['kanban', { labels: { todo: 'x'.repeat(41) } }],
      ['kanban', { wip: { doing: 0 } }],
      ['kanban', { columns: [] }],
      ['timeline', { start: '2026-02-01', end: '2026-01-01', scale: 'day', lanes: 'none' }],
      ['timeline', { start: '2026-01-01', end: '2028-01-02', scale: 'day', lanes: 'none' }],
      ['timeline', { start: '2026-01-01', end: '2026-02-01', scale: 'year', lanes: 'none' }],
    ]
    for (const [k, v] of bad) expect(lobbyValueProblem(k, v), `${k} ${JSON.stringify(v)}`).not.toBeNull()
  })

  it('a Kanban with five 40-character CJK column names, WIP limits and hidden columns fits its cap (1.25 KiB)', () => {
    const cjk = '進行中の作業項目'.repeat(5) // 40 characters, 120 UTF-8 bytes
    expect(cjk).toHaveLength(40)
    const labels = { todo: cjk, doing: cjk, review: cjk, blocked: cjk, done: cjk }
    const value = {
      labels,
      hidden: ['blocked'],
      wip: { todo: 99, doing: 99, review: 99, blocked: 99, done: 99 },
    }
    expect(lobbyValueProblem('kanban', value)).toBeNull()
    expect(lobbyKeySpec('kanban')?.maxBytes).toBe(KANBAN_MAX_BYTES)
    expect(KANBAN_MAX_BYTES).toBe(1280)
  })

  it('a card with every field and the most tags fits the 8 KiB budget', () => {
    const lobby: Record<string, unknown> = {
      'card:status': 'review',
      'card:who': 'u'.repeat(60),
      'card:start': '2026-10-01',
      'card:due': '2026-10-31',
      kind: 'piece-card',
      alt: 'x'.repeat(MAX_ALT_CHARS),
    }
    // the longest tags: 24-character names
    for (let i = 0; i < MAX_TAGS_PER_ELEMENT; i++) {
      const name = `${'t'.repeat(22)}${String(i).padStart(2, '0')}`
      lobby[`tag:${name}`] = { name, color: 'light-violet' }
    }
    expect(JSON.stringify(lobby).length).toBeLessThan(MAX_LOBBY_CUSTOM_DATA_BYTES)
    expect(checkLobbyData(lobby)).toEqual({ ok: true })
  })
})

describe('isOrderKey: the engine order-key rule, restated without the engine', () => {
  it('agrees with engine/fractional.ts isValidIndexKey on generated keys and on hand-made ones', () => {
    const keys = [
      ...indexKeysBetween(null, null, 200),
      ...indexKeysBetween('a0', 'a1', 50),
      ...indexKeysBetween('Zz', 'a0', 20),
      'a0',
      'a',
      'b0',
      'b00',
      'a10',
      'Zz',
      'Z',
      'A00000000000000000000000000',
      'A000000000000000000000000001',
      'zzzzzzzzzzzzzzzzzzzzzzzzzzz',
      'zzzzzzzzzzzzzzzzzzzzzzzzzz',
      '0a',
      'aV',
      'a0V',
      'a0V0',
    ]
    for (const k of keys) expect(isOrderKey(k), k).toBe(isValidIndexKey(k))
    expect(keys.filter((k) => isOrderKey(k)).length).toBeGreaterThan(270)
    // and the length cap of sb:pos
    expect(isOrderKey(`a0${'V'.repeat(62)}`)).toBe(true)
    expect(isOrderKey(`a0${'V'.repeat(63)}`)).toBe(false)
    expect(isOrderKey('a-')).toBe(false)
  })
})

describe('planningElementProblem (checkElement): types and cross-key rules', () => {
  it('cards go on rectangles and sticky notes, always with a status, and start <= due', () => {
    for (const base of ['rectangle', 'stickynote'] as const)
      expect(checkElement(el(base, { 'card:status': 'todo', 'card:due': '2026-10-01' })).ok, base).toBe(true)
    for (const base of ['ellipse', 'frame', 'text', 'image'] as const)
      expect(checkElement(el(base, { 'card:status': 'todo' })).ok, base).toBe(false)
    expect(planningElementProblem('stickynote', null, { 'card:due': '2026-10-01' })).toMatch(/card:status/)
    expect(
      planningElementProblem('stickynote', null, {
        'card:status': 'todo',
        'card:start': '2026-10-02',
        'card:due': '2026-10-01',
      }),
    ).toMatch(/after/)
    expect(
      planningElementProblem('stickynote', null, {
        'card:status': 'todo',
        'card:start': '2026-10-01',
        'card:due': '2026-10-01',
      }),
    ).toBeNull()
  })

  it('panels, Kanbans and timelines are frames; a panel names its storyboard and place; a head is a free text', () => {
    expect(checkElement(el('frame', { 'sb:of': 'text-1', 'sb:pos': 'a0', 'sb:dur': 2000 })).ok).toBe(true)
    expect(checkElement(el('rectangle', { 'sb:of': 'text-1', 'sb:pos': 'a0' })).ok).toBe(false)
    expect(planningElementProblem('frame', null, { 'sb:dur': 2000 })).toMatch(/sb:of and sb:pos/)
    expect(planningElementProblem('frame', null, { 'sb:of': 'h' })).toMatch(/sb:of and sb:pos/)
    expect(checkElement(el('frame', { kanban: {} })).ok).toBe(true)
    expect(checkElement(el('stickynote', { kanban: {} })).ok).toBe(false)
    const tl = { start: '2026-01-01', end: '2026-03-01', scale: 'week', lanes: 'status' }
    expect(checkElement(el('frame', { timeline: tl })).ok).toBe(true)
    expect(checkElement(el('frame', { timeline: tl, kanban: {} })).ok).toBe(false)
    expect(checkElement(el('text', { 'sb:head': { aspect: '16:9' } })).ok).toBe(true)
    // a bound label (SAMPLE_ELEMENTS.label has a containerId) is no head
    expect(checkElement(el('label', { 'sb:head': { aspect: '16:9' } })).ok).toBe(false)
    expect(checkElement(el('frame', { 'sb:head': { aspect: '16:9' } })).ok).toBe(false)
    // a panel may also be a review frame, a slide and carry tags (no planning rule touches other keys)
    expect(
      checkElement(
        el('frame', {
          'sb:of': 'h',
          'sb:pos': 'a0',
          present: { index: 1 },
          'tag:x': { name: 'x', color: 'red' },
        }),
      ).ok,
    ).toBe(true)
  })
})

describe('relink-keep (a copy of a panel or a head)', () => {
  const idMap = new Map([
    ['head-1', 'head-2'],
    ['audio-1', 'audio-2'],
  ])
  it('points refs at the copies the set has, keeps every other one', () => {
    expect(relinkKeep('sb:of', 'head-1', idMap)).toBe('head-2')
    expect(relinkKeep('sb:of', 'head-9', idMap)).toBe('head-9')
    expect(relinkKeep('sb:head', { aspect: '16:9', audio: 'audio-1' }, idMap)).toEqual({
      aspect: '16:9',
      audio: 'audio-2',
    })
    const noAudio = { aspect: '16:9' }
    expect(relinkKeep('sb:head', noAudio, idMap)).toBe(noAudio)
    const other = { aspect: '16:9', audio: 'audio-9' }
    expect(relinkKeep('sb:head', other, idMap)).toBe(other)
  })
})

describe('the planning model', () => {
  const head = el('text', { 'sb:head': { aspect: '16:9', defaultMs: 1500 } }, 'h1')
  const panel = (id: string, pos: string, dur?: number) =>
    el('frame', { 'sb:of': 'h1', 'sb:pos': pos, ...(dur ? { 'sb:dur': dur } : {}) }, id)

  it('storyboards: panels grouped by head, in order by key then id, numbered 1..N whatever the input order', () => {
    const panels = [panel('p3', 'a2'), panel('p1', 'a0', 3000), panel('p2b', 'a1'), panel('p2a', 'a1')]
    for (const shuffled of [panels, [...panels].reverse(), [panels[2], panels[0], panels[3], panels[1]]]) {
      const sbs = storyboardsOf([head, ...(shuffled as WireElement[])])
      const sb = sbs.get('h1')
      expect(sb?.head?.id).toBe('h1')
      expect(sb?.panels.map((p) => p.id)).toEqual(['p1', 'p2a', 'p2b', 'p3'])
      expect([...shotNumbers(sb?.panels ?? [])]).toEqual([
        ['p1', 1],
        ['p2a', 2],
        ['p2b', 3],
        ['p3', 4],
      ])
    }
    // a storyboard whose head was deleted still plays
    const orphan = storyboardsOf([panel('q1', 'a0'), { ...head, isDeleted: true }]).get('h1')
    expect(orphan?.head).toBeNull()
    expect(orphan?.panels.map((p) => p.id)).toEqual(['q1'])
  })

  it('timings: each panel’s duration (its own, else the head’s default), starts and the running time', () => {
    const sb = storyboardsOf([head, panel('p1', 'a0', 3000), panel('p2', 'a1')]).get('h1')
    expect(storyboardTimings(sb as never)).toEqual({
      panels: [
        { id: 'p1', number: 1, startMs: 0, durationMs: 3000 },
        { id: 'p2', number: 2, startMs: 3000, durationMs: 1500 },
      ],
      totalMs: 4500,
    })
  })

  it('order keys: between neighbours, rebalanced when long', () => {
    const k = panelPosBetween('a0', 'a1')
    expect(k > 'a0' && k < 'a1').toBe(true)
    let lo = 'a0'
    let hi = 'a1'
    while (hi.length <= 48) hi = panelPosBetween(lo, hi)
    expect(needsRebalance([panel('x', hi)])).toBe(true)
    expect(needsRebalance([panel('x', 'a0'), panel('y', 'a1')])).toBe(false)
    const fresh = rebalancedPositions(40)
    expect(fresh).toHaveLength(40)
    expect([...fresh].sort()).toEqual(fresh)
    lo = fresh[0] as string
    expect(lo.length).toBeLessThanOrEqual(4)
    expect(panelsInOrder(fresh.map((p, i) => panel(`p${i}`, p))).map((p) => p.id)).toEqual(
      fresh.map((_, i) => `p${i}`),
    )
  })

  it('durations both ways', () => {
    expect(parseDuration('2.5')).toBe(2500)
    expect(parseDuration('2.5 s')).toBe(2500)
    expect(parseDuration('3s')).toBe(3000)
    expect(parseDuration('0:03')).toBe(3000)
    expect(parseDuration('1:02.5')).toBe(62_500)
    expect(parseDuration('36f')).toBe(1500)
    expect(parseDuration('36f', 24)).toBe(1500)
    expect(parseDuration('25f', 25)).toBe(1000)
    for (const bad of ['', 'abc', '0', '0.05', '11:00', '1:60', '-2', '2 min'])
      expect(parseDuration(bad), bad).toBeNull()
    expect(formatDuration(2500)).toBe('2.5 s')
    expect(formatDuration(12_000)).toBe('12 s')
    expect(formatRunningTime(62_400)).toBe('1:02')
    expect(formatRunningTime(3_725_000)).toBe('1:02:05')
  })

  it('cards: fields, overdue, dates', () => {
    const card = el('stickynote', { 'card:status': 'doing', 'card:due': '2026-10-15', 'card:who': 'usr_1' })
    expect(cardOf(card)).toEqual({ status: 'doing', who: 'usr_1', start: null, due: '2026-10-15' })
    expect(cardOf(el('stickynote', { 'card:due': '2026-10-15' }))).toBeNull()
    const fields = cardOf(card) as CardFields
    expect(isOverdue(fields, '2026-10-16')).toBe(true)
    expect(isOverdue(fields, '2026-10-15')).toBe(false)
    expect(isOverdue({ ...fields, status: 'done' }, '2026-10-16')).toBe(false)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2100-12-31', 1)).toBeNull()
    expect(dayNumber('1970-01-01')).toBeNull()
    expect(dayNumber('2000-01-01')).toBe(10_957)
  })

  it('Kanban columns and bands', () => {
    const k = { labels: { doing: 'Now' }, hidden: ['blocked' as const], wip: { doing: 2 } }
    expect(kanbanColumns(k).map((c) => [c.status, c.label, c.wip])).toEqual([
      ['todo', 'To do', null],
      ['doing', 'Now', 2],
      ['review', 'In review', null],
      ['done', 'Done', null],
    ])
    const bands = kanbanBands({ x: 100, width: 800 }, k)
    expect(bands.map((b) => [b.status, b.x, b.width])).toEqual([
      ['todo', 100, 200],
      ['doing', 300, 200],
      ['review', 500, 200],
      ['done', 700, 200],
    ])
    expect(bandAt(bands, 50)?.status).toBe('todo')
    expect(bandAt(bands, 350)?.status).toBe('doing')
    expect(bandAt(bands, 5000)?.status).toBe('done')
  })

  it('timeline maths: snapping, x <-> date, ticks', () => {
    expect(snapDate('2026-10-16', 'week')).toBe('2026-10-12') // a Friday → its Monday
    expect(snapDate('2026-10-12', 'week')).toBe('2026-10-12')
    expect(snapDate('2026-10-16', 'month')).toBe('2026-10-01')
    const t = { start: '2026-10-01', end: '2026-10-10', scale: 'day' as const, lanes: 'none' as const }
    const frame = { x: 0, width: 1000 }
    expect(dateToX(t, frame, '2026-10-01')).toBe(0)
    expect(dateToX(t, frame, '2026-10-06')).toBe(500)
    expect(dateToX(t, frame, '2027-01-01')).toBe(1000)
    expect(xToDate(t, frame, 550)).toBe('2026-10-06')
    expect(xToDate(t, frame, -10)).toBe('2026-10-01')
    expect(xToDate(t, frame, 5000)).toBe('2026-10-10')
    expect(timelineTicks(t)).toHaveLength(10)
    const months = { start: '2026-01-15', end: '2026-06-30', scale: 'month' as const, lanes: 'none' as const }
    expect(timelineTicks(months)).toEqual([
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
    ])
  })
})

describe('the contracts that mirror the planning keys (packages/contracts cannot import canvas-schema)', () => {
  it('strip-keys takes every key class LOBBY_KEY_ADDITIONS names; the AI breakdown uses the storyboard aspects and durations', () => {
    expect([...STRIP_KEYS_PREFIXES]).toEqual(LOBBY_KEY_ADDITIONS.map((a) => a.prefix))
    for (const p of PLANNING_KEY_CLASSES) expect(STRIP_KEYS_PREFIXES as readonly string[]).toContain(p)
    expect([...AI_STORYBOARD_ASPECTS]).toEqual([...SB_ASPECTS])
    expect([AI_STORYBOARD_DUR_MIN_MS, AI_STORYBOARD_DUR_MAX_MS]).toEqual([SB_DUR_MIN_MS, SB_DUR_MAX_MS])
  })
})
