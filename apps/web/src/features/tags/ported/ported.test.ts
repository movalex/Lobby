// The ported tags feature's pure parts (./model.ts, ./search.ts, ./csv.ts, the chip boxes and the veil's
// holes) and its runtime's writes against a fake canvas (doc first, then one transact; an undo that puts
// back a tag whose definition went lists it again). The browser paths are e2e/excalidraw/tags-*.spec.ts.
import { type TagColor, type TagDef, tagKey } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import type { CanvasChange, CanvasElement } from '../../../canvas/api/index.ts'
import { atom } from '../../../lib/signals.ts'
import { chipBoxes } from './Chips.tsx'
import { tagsCsvCells } from './csv.ts'
import { veilHoles } from './Filter.tsx'
import {
  boardTagRows,
  boardTagsOf,
  chipPlacement,
  displayTags,
  elementTags,
  isTaggable,
  planDeleteEverywhere,
  planRecolor,
  planRename,
  planSetTag,
  selectionTagState,
  tagsLodFor,
  tagTokens,
} from './model.ts'
import { TagsRuntime } from './runtime.ts'
import { parseTagQuery, searchElementsWithTags } from './search.ts'
import { thingOf } from './TagPicker.tsx'

const T = (key: string, name: string, color: TagColor = 'blue'): TagDef => ({ key, name, color })
const tagsLobby = (...tags: { key: string; name: string; color: string }[]) =>
  Object.fromEntries(tags.map((t) => [`tag:${t.key}`, { name: t.name, color: t.color }]))

let n = 0
const el = (type: string, lobby: Record<string, unknown> = {}, more: Record<string, unknown> = {}) =>
  ({
    id: `e${++n}`,
    type,
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    angle: 0,
    isDeleted: false,
    locked: false,
    customData: { lobby },
    ...more,
  }) as unknown as CanvasElement

const RESEARCH = T('research', 'Research')
const IDEA = T('idea', 'Idea', 'green')

describe('model: tags on elements and the board list', () => {
  it('taggable kinds and where their chips sit', () => {
    expect(isTaggable(el('stickynote'))).toBe(true)
    expect(isTaggable(el('rectangle'))).toBe(true)
    expect(isTaggable(el('text'))).toBe(true)
    expect(isTaggable(el('text', {}, { containerId: 'x' }))).toBe(false) // a label: its container is
    expect(isTaggable(el('image', { file: { id: 'f', kind: 'document' } }))).toBe(true)
    expect(isTaggable(el('arrow'))).toBe(false)
    expect(isTaggable(el('frame'))).toBe(false)
    expect(isTaggable(el('stickynote', {}, { isDeleted: true }))).toBe(false)
    expect(chipPlacement(el('stickynote'))).toBe('note')
    expect(chipPlacement(el('rectangle'))).toBe('above')
    expect(chipPlacement(el('text'))).toBe('above')
    expect(chipPlacement(el('image', { file: { id: 'f', kind: 'document' } }))).toBe('card')
  })
  it('reads valid tags only, at most 10, key order; the board decides names and colours', () => {
    const note = el('stickynote', {
      ...tagsLobby(IDEA, RESEARCH),
      'tag:bad': { name: '', color: 'blue' },
      alt: 'x',
    })
    expect(elementTags(note).map((t) => t.key)).toEqual(['idea', 'research'])
    expect(elementTags(note)).toBe(elementTags(note)) // parsed once per lobby object
    expect(tagTokens(note)).toBe('idea research')
    const board = boardTagsOf(
      new Map<string, unknown>([
        ['tagDef:idea', { name: 'IDEA', color: 'red' }],
        ['tagDef:x', 'junk'],
        ['other', 1],
      ]),
    )
    expect([...board.keys()]).toEqual(['idea'])
    expect(displayTags(note, board).map((t) => `${t.name}:${t.color}`)).toEqual(['IDEA:red', 'Research:blue'])
    const many = el('stickynote', tagsLobby(...Array.from({ length: 12 }, (_, i) => T(`t${i}`, `T${i}`))))
    expect(elementTags(many)).toHaveLength(10)
  })
  it('rows count carriers and include carried-only tags; selection state', () => {
    const a = el('stickynote', tagsLobby(RESEARCH))
    const b = el('stickynote', tagsLobby(RESEARCH, IDEA))
    const rows = boardTagRows(
      boardTagsOf(
        new Map([
          ['tagDef:research', { name: 'Research', color: 'blue' }],
          ['tagDef:blocked', { name: 'Blocked', color: 'red' }],
        ]),
      ),
      [a, b, el('arrow', tagsLobby(IDEA))],
    )
    expect(rows.map((r) => [r.key, r.count, r.listed])).toEqual([
      ['blocked', 0, true],
      ['idea', 1, false],
      ['research', 2, true],
    ])
    expect(selectionTagState([a, b], 'research')).toBe('all')
    expect(selectionTagState([a, b], 'idea')).toBe('some')
    expect(selectionTagState([a], 'idea')).toBe('none')
  })
})

describe('planning: element patches plus the doc keys, so a new tag travels with its definition', () => {
  const a = el('stickynote')
  const b = el('stickynote', tagsLobby(RESEARCH))
  const locked = el('stickynote', {}, { locked: true })
  it('adding lists an unlisted tag in the same plan; locked and full elements are left out', () => {
    const full = el('stickynote', tagsLobby(...Array.from({ length: 10 }, (_, i) => T(`t${i}`, `T${i}`))))
    const plan = planSetTag([a, b, locked, full], RESEARCH, true, false)
    expect(plan.elements).toEqual([
      { id: a.id, lobby: { 'tag:research': { name: 'Research', color: 'blue' } } },
    ])
    expect(plan.doc).toEqual({ 'tagDef:research': { name: 'Research', color: 'blue' } })
    expect(plan.full).toBe(1)
    expect(planSetTag([a], RESEARCH, true, true).doc).toEqual({})
    expect(planSetTag([b], RESEARCH, false, true).elements).toEqual([
      { id: b.id, lobby: { 'tag:research': null } },
    ])
  })
  it('rename moves the key everywhere (or refuses a clash); recolour keeps copies in step; delete everywhere', () => {
    const rows = boardTagRows(
      boardTagsOf(
        new Map([
          ['tagDef:research', { name: 'Research', color: 'blue' }],
          ['tagDef:idea', { name: 'Idea', color: 'green' }],
        ]),
      ),
      [b],
    )
    const clash = planRename(rows, [b], 'research', 'IDEA')
    expect(clash.ok).toBe(false)
    const plan = planRename(rows, [a, b], 'research', 'User research')
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.value.elements).toEqual([
      {
        id: b.id,
        lobby: { 'tag:user-research': { name: 'User research', color: 'blue' }, 'tag:research': null },
      },
    ])
    expect(plan.value.doc).toEqual({
      'tagDef:user-research': { name: 'User research', color: 'blue' },
      'tagDef:research': null,
    })
    const recolor = planRecolor(rows, [b], 'research', 'red')
    if (!recolor.ok) throw new Error(recolor.error)
    expect(recolor.value.elements[0]?.lobby).toEqual({ 'tag:research': { name: 'Research', color: 'red' } })
    expect(planRecolor(rows, [b], 'research', 'plaid' as never).ok).toBe(false)
    expect(
      planDeleteEverywhere([a, b, { ...b, id: 'lockedcopy', locked: true } as CanvasElement], 'research'),
    ).toEqual({
      elements: [
        { id: b.id, lobby: { 'tag:research': null } },
        { id: 'lockedcopy', lobby: { 'tag:research': null } },
      ],
      doc: { 'tagDef:research': null },
    })
  })
  it('the level of detail follows the zoom', () => {
    expect([tagsLodFor(1), tagsLodFor(0.6), tagsLodFor(0.4), tagsLodFor(0.25), tagsLodFor(0.2)]).toEqual([
      'full',
      'full',
      'dots',
      'dots',
      'off',
    ])
  })
})

describe('chips and the "Show only" veil', () => {
  it('a box per visible tagged element; holes for the carriers (raised above shapes for their chips)', () => {
    const note = el('stickynote', tagsLobby(RESEARCH), { x: 10, y: 20 })
    const shape = el('rectangle', tagsLobby(RESEARCH, IDEA), {
      x: 300,
      y: 0,
      width: 100,
      height: 50,
      angle: Math.PI / 2,
    })
    const hidden = el('stickynote', tagsLobby(RESEARCH))
    const plain = el('stickynote')
    const boxes = chipBoxes([note, shape, hidden, plain], new Map(), (id) => id === hidden.id)
    expect(boxes.map((b) => [b.id, b.placement, b.tokens])).toEqual([
      [note.id, 'note', 'research'],
      [shape.id, 'above', 'idea research'],
    ])
    const holes = veilHoles(boxes, 'idea')
    expect(holes).toEqual([{ id: shape.id, x: 296, y: -28, w: 108, h: 82, deg: 90 }])
    expect(veilHoles(boxes, 'research').map((h) => h.id)).toEqual([note.id, shape.id])
  })
})

describe('search with tags and the CSV column', () => {
  const n1 = el('stickynote', tagsLobby(RESEARCH), { id: 'n1', x: 0, y: 0 })
  const n2 = el('stickynote', tagsLobby(RESEARCH, IDEA), {
    id: 'n2',
    x: 260,
    y: 0,
    boundElements: [{ id: 'l2', type: 'text' }],
  })
  const l2 = el(
    'text',
    {},
    { id: 'l2', containerId: 'n2', text: 'Search finds nothing', originalText: 'Search finds nothing' },
  )
  const plain = el(
    'stickynote',
    {},
    { id: 'plain', x: 0, y: 300, boundElements: [{ id: 'lp', type: 'text' }] },
  )
  const lp = el(
    'text',
    {},
    { id: 'lp', containerId: 'plain', text: 'Research budget', originalText: 'Research budget' },
  )
  const all = [n1, n2, l2, plain, lp]
  const board = boardTagsOf(
    new Map([
      ['tagDef:research', { name: 'Research', color: 'blue' }],
      ['tagDef:idea', { name: 'Idea', color: 'green' }],
    ]),
  )
  const ids = (q: string, tag: string | null = null) =>
    searchElementsWithTags(all, q, { limit: 50, tag, board }).map((h) => h.id)
  it('# terms match tag names only; the tag filter lists carriers in reading order; words find tag names too', () => {
    expect(parseTagQuery('#res  plan #')).toEqual({ text: 'plan', tagTerms: ['res'] })
    expect(ids('#res')).toEqual(['n1', 'n2'])
    expect(ids('', 'idea')).toEqual(['n2'])
    expect(ids('#idea search')).toEqual(['n2'])
    const research = ids('research')
    expect(research[0]).toBe('plain')
    expect(research.sort()).toEqual(['n1', 'n2', 'plain'])
    expect(ids('')).toEqual([])
    expect(searchElementsWithTags(all, '#nothing', { limit: 50, tag: null, board })).toEqual([])
  })
  it('the tags cell: board names, sorted, quoted like text; empty for untagged and untaggable', () => {
    const formula = el('stickynote', tagsLobby(T(tagKey('=SUM(A1)'), '=SUM(A1)')), { id: 'f' })
    const cell = tagsCsvCells([...all, formula, el('arrow', tagsLobby(IDEA), { id: 'a' })], board)
    expect(cell('n2')).toBe('Idea; Research')
    expect(cell('plain')).toBe('')
    expect(cell('a')).toBe('')
    expect(cell('f')).toBe("'=SUM(A1)")
  })
  it('what the picker calls a selection', () => {
    expect(thingOf([el('stickynote'), el('stickynote')]).one).toBe('note')
    expect(thingOf([el('rectangle')]).one).toBe('shape')
    expect(thingOf([el('stickynote'), el('rectangle')]).one).toBe('item')
  })
})

describe('runtime writes (a fake canvas)', () => {
  function fake(elements: CanvasElement[], doc: Record<string, unknown> = {}) {
    const store = new Map(elements.map((e) => [e.id, e]))
    const docMap = new Map(Object.entries(doc))
    const docVersion = atom('fake.doc', 0)
    const log: string[] = []
    let onChange: ((c: CanvasChange) => void) | null = null
    let selection: string[] = []
    const canvas = {
      get: (id: string) => store.get(id),
      items: () => [...store.values()],
      readOnly: () => false,
      isHidden: () => false,
      isLocked: (id: string) => !!store.get(id)?.locked,
      get selection() {
        return selection
      },
      doc: {
        get: (k: string) => docMap.get(k),
        entries: (prefix?: string) => {
          docVersion.get()
          return new Map([...docMap].filter(([k]) => !prefix || k.startsWith(prefix)))
        },
        set(e: Record<string, unknown>) {
          log.push(`doc ${Object.keys(e).join(',')}`)
          for (const [k, v] of Object.entries(e)) {
            if (v === null) docMap.delete(k)
            else docMap.set(k, v)
          }
          docVersion.set(docVersion.get() + 1)
        },
      },
      transact(label: string, fn: (tx: { update(id: string, p: Record<string, unknown>): void }) => void) {
        const ids: string[] = []
        fn({
          update(id, p) {
            ids.push(id)
            const cur = store.get(id) as unknown as Record<string, unknown>
            const lobby = { ...((cur.customData as { lobby?: object })?.lobby ?? {}) } as Record<
              string,
              unknown
            >
            for (const [k, v] of Object.entries((p.customData as { lobby: Record<string, unknown> }).lobby)) {
              if (v === null) delete lobby[k]
              else lobby[k] = v
            }
            store.set(id, { ...cur, customData: { lobby } } as unknown as CanvasElement)
          },
        })
        log.push(`tx ${label} ${ids.join(',')}`)
      },
      on(_e: string, l: (c: CanvasChange) => void) {
        onChange = l
        return () => {
          onChange = null
        }
      },
    }
    return {
      canvas,
      log,
      store,
      select: (ids: string[]) => {
        selection = ids
      },
      emit: (c: Partial<CanvasChange>) =>
        onChange?.({ created: [], updated: [], deleted: [], source: 'local', ...c } as CanvasChange),
    }
  }
  it('a new tag from the picker: its definition first, then every element in one transact', () => {
    const a = el('stickynote', {}, { id: 'a' })
    const b = el('stickynote', {}, { id: 'b' })
    const f = fake([a, b])
    const rt = new TagsRuntime(f.canvas as never)
    f.select(['a', 'b'])
    const res = rt.addTypedTagToSelection('#Research')
    expect(res.ok && res.value).toMatchObject({
      changed: 2,
      created: true,
      tag: { key: 'research', name: 'Research' },
    })
    expect(f.log).toEqual(['doc tagDef:research', 'tx add tag a,b'])
    // the same tag again: already listed, nothing to write
    f.log.length = 0
    rt.addTypedTagToSelection('research')
    expect(f.log).toEqual([])
  })
  it('an undo that puts a tag back after "delete everywhere" lists it again from the element copy', () => {
    const a = el('stickynote', tagsLobby(IDEA), { id: 'a' })
    const f = fake([a], { 'tagDef:idea': { name: 'Idea', color: 'green' } })
    const rt = new TagsRuntime(f.canvas as never)
    const off = rt.install()
    expect(rt.deleteTagEverywhere('idea')).toBe(1)
    expect(f.log).toEqual(['doc tagDef:idea', 'tx delete tag a'])
    // the undo (history) restores the element's copy
    f.store.set('a', a)
    f.log.length = 0
    f.emit({ updated: ['a'], source: 'history' } as never)
    expect(f.log).toEqual(['doc tagDef:idea'])
    expect(rt.board.get().get('idea')).toEqual({ key: 'idea', name: 'Idea', color: 'green' })
    // a local change never does
    f.log.length = 0
    f.emit({ updated: ['a'], source: 'local' } as never)
    expect(f.log).toEqual([])
    // a recolour taken back: the list follows the copy the undo restored
    const recolor = rt.recolorTag('idea', 'red')
    expect(recolor.ok && recolor.value).toBe(1)
    expect(rt.board.get().get('idea')?.color).toBe('red')
    f.store.set('a', a)
    f.log.length = 0
    f.emit({ updated: ['a'], source: 'history' } as never)
    expect(f.log).toEqual(['doc tagDef:idea'])
    expect(rt.board.get().get('idea')?.color).toBe('green')
    // nothing to do when the list already agrees
    f.log.length = 0
    f.emit({ updated: ['a'], source: 'history' } as never)
    expect(f.log).toEqual([])
    off()
  })
})
