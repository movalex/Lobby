import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import {
  boardTagMetaKey,
  parseBoardTags,
  parseShapeTags,
  shapeTagMetaKey,
  type TagDef,
} from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { fullNotice, thingName, usageLabel } from './copy.ts'
import {
  applyBoardChange,
  boardTagMap,
  boardTagRows,
  chipLayout,
  displayTags,
  isShortTagName,
  nextTagColor,
  planDeleteEverywhere,
  planRecolor,
  planRename,
  planSetTag,
  resolveTypedTag,
  type ShapeLike,
  sameBoardTags,
  selectionTagState,
  tagTokens,
} from './model.ts'

const T = (key: string, name: string, color: TagDef['color'] = 'blue'): TagDef => ({ key, name, color })
const RESEARCH = T('research', 'Research', 'blue')
const IDEA = T('idea', 'Idea', 'green')
const BLOCKED = T('blocked', 'Blocked', 'red')

const metaWith = (...tags: TagDef[]) =>
  Object.fromEntries(tags.map((t) => [shapeTagMetaKey(t.key), { name: t.name, color: t.color }]))
const note = (id: string, tags: TagDef[] = [], extra: Record<string, unknown> = {}): ShapeLike => ({
  id,
  type: 'note',
  meta: { ...extra, ...metaWith(...tags) },
})

describe('display', () => {
  it('the board list decides name and colour; a shape’s own copy is the fallback; sorted by name', () => {
    const board = boardTagMap([T('research', 'Research', 'violet')])
    const meta = metaWith(T('research', 'research', 'blue'), T('zeta', 'zeta', 'red'), IDEA)
    expect(displayTags(meta, board)).toEqual([
      IDEA,
      T('research', 'Research', 'violet'),
      T('zeta', 'zeta', 'red'),
    ])
    expect(tagTokens(meta)).toBe('idea research zeta')
    expect(tagTokens({})).toBe('')
  })

  it('names sort case- and accent-insensitively, numbers numerically', () => {
    const meta = metaWith(
      T('sprint-10', 'Sprint 10'),
      T('sprint-9', 'Sprint 9'),
      T('éclair', 'éclair'),
      T('alpha', 'Alpha'),
    )
    expect(displayTags(meta, new Map()).map((t) => t.name)).toEqual([
      'Alpha',
      'éclair',
      'Sprint 9',
      'Sprint 10',
    ])
  })

  it('rows: listed tags plus tags only shapes carry, with counts over notes and file cards', () => {
    const board = boardTagMap([RESEARCH, BLOCKED])
    const shapes: ShapeLike[] = [
      note('a', [RESEARCH, IDEA]),
      note('b', [RESEARCH]),
      { id: 'c', type: FILE_CARD_TYPE, meta: metaWith(IDEA) },
      { id: 'd', type: 'geo', meta: metaWith(RESEARCH) }, // not taggable: ignored
    ]
    expect(boardTagRows(board, shapes)).toEqual([
      { ...BLOCKED, count: 0, listed: true },
      { ...IDEA, count: 2, listed: false },
      { ...RESEARCH, count: 2, listed: true },
    ])
  })

  it('sameBoardTags compares entries, not identity', () => {
    expect(sameBoardTags(boardTagMap([RESEARCH, IDEA]), boardTagMap([IDEA, RESEARCH]))).toBe(true)
    expect(sameBoardTags(boardTagMap([RESEARCH]), boardTagMap([{ ...RESEARCH, color: 'red' }]))).toBe(false)
    expect(sameBoardTags(boardTagMap([RESEARCH]), boardTagMap([RESEARCH, IDEA]))).toBe(false)
  })
})

describe('chips on a shape', () => {
  it('up to three names; beyond that two names and "+N"', () => {
    const tags = ['a', 'b', 'c', 'd', 'e'].map((k) => T(k, k.toUpperCase()))
    expect(chipLayout(tags.slice(0, 3))).toEqual({ shown: tags.slice(0, 3), more: 0 })
    expect(chipLayout(tags.slice(0, 4))).toEqual({ shown: tags.slice(0, 2), more: 2 })
    expect(chipLayout(tags)).toEqual({ shown: tags.slice(0, 2), more: 3 })
  })
  it('short names (8 characters) never shrink', () => {
    expect(isShortTagName('Research')).toBe(true)
    expect(isShortTagName('Customer voice')).toBe(false)
  })
})

describe('adding and removing on a selection', () => {
  it('adds to every note and card without it, skips locked ones and full ones, lists a new tag once', () => {
    const ten = Array.from({ length: 10 }, (_, i) => T(`t${i}`, `T${i}`))
    const shapes: ShapeLike[] = [
      note('a'),
      note('b', [RESEARCH]),
      { ...note('c'), isLocked: true },
      note('d', ten),
      { id: 'e', type: 'geo', meta: {} },
      { id: 'f', type: FILE_CARD_TYPE, meta: {} },
    ]
    const plan = planSetTag(shapes, RESEARCH, true, false)
    expect(plan.shapes.map((s) => s.id)).toEqual(['a', 'f'])
    expect(plan.full).toBe(1)
    expect(plan.board).toEqual({ set: [RESEARCH], remove: [] })
    expect(parseShapeTags(plan.shapes[0]?.meta)).toEqual([RESEARCH])
    // already listed: no board change
    expect(planSetTag(shapes, RESEARCH, true, true).board).toEqual({ set: [], remove: [] })
  })

  it('adding keeps other meta keys (other features’ included) and other tags', () => {
    const plan = planSetTag([note('a', [IDEA], { drMindmap: { rootId: 'x' } })], RESEARCH, true, true)
    expect(plan.shapes[0]?.meta).toEqual({ drMindmap: { rootId: 'x' }, ...metaWith(IDEA, RESEARCH) })
  })

  it('removing deletes the tag’s meta key (not an empty value) and touches only shapes that carry it', () => {
    const plan = planSetTag([note('a', [RESEARCH, IDEA]), note('b', [IDEA])], RESEARCH, false, true)
    expect(plan.shapes).toHaveLength(1)
    expect(plan.shapes[0]?.meta).toEqual(metaWith(IDEA))
    expect(shapeTagMetaKey('research') in (plan.shapes[0]?.meta ?? {})).toBe(false)
    expect(plan.board).toEqual({ set: [], remove: [] })
  })

  it('selection state: all / some / none over taggable shapes', () => {
    const shapes = [note('a', [RESEARCH]), note('b', [RESEARCH]), { id: 'g', type: 'geo', meta: {} }]
    expect(selectionTagState(shapes, 'research')).toBe('all')
    expect(selectionTagState([...shapes, note('c')], 'research')).toBe('some')
    expect(selectionTagState(shapes, 'idea')).toBe('none')
    expect(selectionTagState([], 'idea')).toBe('none')
  })
})

describe('typed names', () => {
  const rows = boardTagRows(boardTagMap([RESEARCH]), [note('a', [IDEA])])
  it('finds the existing tag by key (listed or only carried), whatever the case or #', () => {
    expect(resolveTypedTag(rows, ' #research ')).toEqual({
      ok: true,
      value: { tag: RESEARCH, created: false },
    })
    expect(resolveTypedTag(rows, 'IDEA')).toEqual({ ok: true, value: { tag: IDEA, created: false } })
  })
  it('makes a new one with the next free colour', () => {
    const res = resolveTypedTag(rows, 'Needs review')
    expect(res).toEqual({
      ok: true,
      value: { tag: { key: 'needs-review', name: 'Needs review', color: 'orange' }, created: true },
    })
  })
  it('refuses empty or long names', () => {
    expect(resolveTypedTag(rows, '  # ')).toMatchObject({ ok: false })
    expect(resolveTypedTag(rows, 'x'.repeat(25))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/24/),
    })
  })
  it('refuses a 201st tag', () => {
    const many = boardTagRows(boardTagMap(Array.from({ length: 200 }, (_, i) => T(`t${i}`, `T${i}`))), [])
    expect(resolveTypedTag(many, 'One more')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/200/),
    })
    expect(resolveTypedTag(many, 'T5')).toMatchObject({ ok: true }) // existing ones still resolve
  })
  it('colours rotate through the palette, distinct first', () => {
    expect(nextTagColor([])).toBe('blue')
    expect(nextTagColor([{ color: 'blue' }, { color: 'green' }])).toBe('orange')
  })
})

describe('board-wide changes', () => {
  const board = boardTagMap([RESEARCH, IDEA])
  const shapes = [
    note('a', [RESEARCH, IDEA]),
    note('b', [RESEARCH]),
    { ...note('c', [RESEARCH]), isLocked: true },
    note('d', [IDEA]),
  ]
  const rows = boardTagRows(board, shapes)

  it('rename: new key on the board and on every shape carrying it (locked too), old key gone', () => {
    const plan = planRename(rows, shapes, 'research', 'User research')
    if (!plan.ok) throw new Error(plan.error)
    const renamed = T('user-research', 'User research', 'blue')
    expect(plan.value.tag).toEqual(renamed)
    expect(plan.value.board).toEqual({ set: [renamed], remove: ['research'] })
    expect(plan.value.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    for (const s of plan.value.shapes) {
      expect(shapeTagMetaKey('research') in s.meta).toBe(false)
      expect(parseShapeTags(s.meta).map((t) => t.key)).toContain('user-research')
    }
    expect(parseShapeTags(plan.value.shapes[0]?.meta)).toEqual([IDEA, renamed])
  })

  it('rename that only changes case keeps the key', () => {
    const plan = planRename(rows, shapes, 'research', 'RESEARCH')
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.value.board).toEqual({ set: [T('research', 'RESEARCH', 'blue')], remove: [] })
    expect(parseShapeTags(plan.value.shapes[1]?.meta)).toEqual([T('research', 'RESEARCH', 'blue')])
  })

  it('rename onto another tag’s name is refused (no silent merge); a missing tag too', () => {
    expect(planRename(rows, shapes, 'research', ' idea ')).toEqual({
      ok: false,
      error: 'There is already a tag called “Idea”.',
    })
    expect(planRename(rows, shapes, 'gone', 'X')).toMatchObject({ ok: false })
  })

  it('recolour: the board entry and every shape copy that differs', () => {
    const stale = [...shapes, note('e', [T('research', 'Research', 'violet')])]
    const plan = planRecolor(boardTagRows(board, stale), stale, 'idea', 'red')
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.value.board).toEqual({ set: [T('idea', 'Idea', 'red')], remove: [] })
    expect(plan.value.shapes.map((s) => s.id)).toEqual(['a', 'd'])
    expect(planRecolor(rows, shapes, 'idea', 'mauve' as never)).toMatchObject({ ok: false })
  })

  it('delete everywhere: off the list and off every carrier, locked ones included; nothing else touched', () => {
    const plan = planDeleteEverywhere(shapes, 'research')
    expect(plan.board).toEqual({ set: [], remove: ['research'] })
    expect(plan.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(parseShapeTags(plan.shapes[0]?.meta)).toEqual([IDEA])
  })

  it('applyBoardChange keeps other document settings', () => {
    const doc = {
      drWorkshop: { hideNoteAuthors: true },
      drStartView: { x: 1 },
      [boardTagMetaKey('research')]: { name: 'Research', color: 'blue' },
    }
    const next = applyBoardChange(doc, { set: [IDEA], remove: ['research'] })
    expect(next).toEqual({
      drWorkshop: { hideNoteAuthors: true },
      drStartView: { x: 1 },
      [boardTagMetaKey('idea')]: { name: 'Idea', color: 'green' },
    })
    expect(parseBoardTags(next)).toEqual([IDEA])
  })
})

describe('copy', () => {
  it('names what is selected and explains the 10-tag limit', () => {
    expect(thingName({ notes: 2, cards: 0 })).toEqual({ one: 'note', many: 'notes' })
    expect(thingName({ notes: 0, cards: 1 })).toEqual({ one: 'card', many: 'cards' })
    expect(thingName({ notes: 1, cards: 1 })).toEqual({ one: 'item', many: 'items' })
    expect(fullNotice(0, { one: 'note', many: 'notes' })).toBeNull()
    expect(fullNotice(1, { one: 'note', many: 'notes' })).toBe(
      '1 note already has 10 tags, so it was left out.',
    )
    expect(fullNotice(2, { one: 'card', many: 'cards' })).toBe(
      '2 cards already have 10 tags, so they were left out.',
    )
    expect(usageLabel(0)).toBe('Not used yet')
    expect(usageLabel(3)).toBe('On 3 items')
  })
})
