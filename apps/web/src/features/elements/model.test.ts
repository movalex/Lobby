// Wave Q (WS3): the Elements panel's model in Node: one search over icons (through the icons port, here the dev test
// double), shapes and library items; Favourites and Recents from mark keys (a stale icon version, an unknown piece, a
// gone item hidden); the grid's keys across sections; tags and names; and the panel's small rules (access, options,
// the dev override).
import { DEFAULT_INSERT_OPTIONS, libraryMarkKey, parseElementDrag } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { elementsAccess } from './access.ts'
import { elementsPanelOverride } from './flags.ts'
import * as double from './icons-double.ts'
import { adapt } from './icons-port.ts'
import {
  countLabel,
  gridKey,
  itemNameOrNull,
  otherMatches,
  parseTags,
  rowMove,
  searchAll,
  type Tile,
  tileDrag,
  tileMarkKey,
  tilesOfMarks,
} from './model.ts'
import { INSERT_OPTIONS_KEY, loadInsertOptions, parseInsertOptions, saveInsertOptions } from './options.ts'
import { summary } from './test-kit.ts'

const api = adapt(double, 'double')
if (!api) throw new Error('the double has the four exports')
const index = await api.loadIndex()
const icons = { api, index }

const search = (query: string, items = [summary()]) =>
  searchAll({ query, icons, iconSet: 'all', shapeCategory: 'all', items })

describe('one search over the three sources', () => {
  it('"arrow" finds the arrow icons first, and its tab counts tell the other sources apart', () => {
    const r = search('arrow')
    expect(r.icons.map((t) => t.id).slice(0, 3)).toEqual([
      'lucide:arrow-left',
      'lucide:arrow-right',
      'lucide:arrow-up',
    ])
    expect(r.icons.every((t) => t.source === 'icon')).toBe(true)
    // the library item is not about arrows
    expect(r.library).toEqual([])
  })

  it('finds shapes by name and library items by name or tag; an empty search lists everything', () => {
    expect(search('dec').shapes[0]?.id).toBe('decision')
    expect(search('flow').library.map((t) => t.id)).toEqual([summary().id])
    expect(search('FLOW st').library).toHaveLength(1)
    expect(search('').icons.length).toBe(index.icons.length)
    expect(search('').shapes.length).toBeGreaterThan(20)
    const r = search('decision')
    expect(otherMatches(r, 'icons', ['icons', 'shapes', 'library'])).toEqual([{ tab: 'shapes', count: 1 }])
  })

  it('narrows icons to a set, and a tile drags as the panel’s payload', () => {
    const r = searchAll({ query: '', icons, iconSet: 'tabler', shapeCategory: 'all', items: [] })
    expect(r.icons.length).toBeGreaterThan(0)
    expect(r.icons.every((t) => t.source === 'icon' && t.set === 'tabler')).toBe(true)
    const t = r.icons[0] as Tile
    expect(parseElementDrag(tileDrag(t))).toEqual({ source: 'icon', id: t.id })
    expect(countLabel(5)).toBe('5')
    expect(countLabel(1000)).toBe('99+')
  })
})

describe('favourites and recents', () => {
  const item = summary()
  const look = { index, items: new Map([[item.id, item]]), library: true }

  it('shows each mark that still names something, once, in order', () => {
    const arrow = search('arrow-right').icons[0] as Tile
    const keys = [
      tileMarkKey(arrow),
      'piece:decision',
      `item:${item.id}`,
      tileMarkKey(arrow),
      'icon:lucide:arrow-right@1.0.0',
      'piece:nope',
      'item:lbi_gone0123456789',
      'not a key',
    ]
    expect(tilesOfMarks(keys, look).map((t) => `${t.source}:${t.id}`)).toEqual([
      'icon:lucide:arrow-right',
      'piece:decision',
      `item:${item.id}`,
    ])
  })

  it('hides item marks without the library, and deleted items', () => {
    expect(tilesOfMarks([`item:${item.id}`], { ...look, library: false })).toEqual([])
    const gone = summary({ deletedAt: '2026-10-15T01:00:00.000Z' })
    expect(tilesOfMarks([`item:${gone.id}`], { ...look, items: new Map([[gone.id, gone]]) })).toEqual([])
    expect(libraryMarkKey({ source: 'piece', id: 'decision' })).toBe('piece:decision')
  })
})

describe('the grid’s keys', () => {
  const base = { active: 0, sections: [3, 10], columns: 4, query: '', inSearch: true }

  it('Up and Down move a row, keeping the column, across sections', () => {
    // section 0: [0 1 2]; section 1: [3 4 5 6] [7 8 9 10] [11 12]
    expect(rowMove([3, 10], 1, 4, 1)).toBe(4)
    expect(rowMove([3, 10], 4, 4, 1)).toBe(8)
    expect(rowMove([3, 10], 10, 4, 1)).toBe(12)
    expect(rowMove([3, 10], 12, 4, 1)).toBe(12)
    expect(rowMove([3, 10], 6, 4, -1)).toBe(2)
    expect(rowMove([0, 5], 2, 4, -1)).toBe(2)
    expect(gridKey('ArrowDown', { ...base, active: 2 }).active).toBe(5)
  })

  it('Left, Right, Home and End move tiles with nothing typed, and the caret with a query', () => {
    expect(gridKey('ArrowRight', base)).toEqual({ active: 1, handled: true })
    expect(gridKey('End', base).active).toBe(12)
    expect(gridKey('ArrowRight', { ...base, query: 'a' }).handled).toBe(false)
    expect(gridKey('Home', { ...base, query: 'a' }).handled).toBe(false)
    // in the grid itself the arrows always move
    expect(gridKey('ArrowLeft', { ...base, active: 4, query: 'a', inSearch: false }).active).toBe(3)
  })

  it('Enter inserts, the context-menu key and Shift+F10 open the actions, Escape clears then closes', () => {
    expect(gridKey('Enter', base).insert).toBe(true)
    expect(gridKey('Enter', { ...base, sections: [] }).insert).toBeUndefined()
    expect(gridKey('ContextMenu', base).actions).toBe(true)
    expect(gridKey('F10', { ...base, shift: true }).actions).toBe(true)
    expect(gridKey('F10', base).handled).toBe(false)
    expect(gridKey('Escape', { ...base, query: 'x' }).clear).toBe(true)
    expect(gridKey('Escape', base).close).toBe(true)
    expect(gridKey('a', base).handled).toBe(false)
  })
})

describe('names, tags and options', () => {
  it('tags: commas, folded case, each once, the library’s rule and limit', () => {
    expect(parseTags('Flow, chart , flow,,')).toEqual({ tags: ['flow', 'chart'], problem: null })
    expect(parseTags('!bad').problem).toMatch(/can’t be a tag/)
    expect(parseTags('a,b,c,d,e,f,g,h,i,j,k').problem).toBe('At most 10 tags.')
    expect(itemNameOrNull('  Flow   start ')).toBe('Flow start')
    expect(itemNameOrNull('   ')).toBeNull()
    expect(itemNameOrNull('x'.repeat(81))).toBeNull()
  })

  it('options: remembered, each bad field back to its default, no storage is no error', () => {
    const stored = { color: 'blue', size: 'L', keepTogether: false, lock: true, extra: 1 }
    expect(parseInsertOptions(stored)).toEqual({ color: 'blue', size: 'L', keepTogether: false, lock: true })
    expect(parseInsertOptions({ color: 'mauve', size: 'XL', lock: 'yes' })).toEqual(DEFAULT_INSERT_OPTIONS)
    expect(parseInsertOptions('nonsense')).toEqual(DEFAULT_INSERT_OPTIONS)
    const mem = new Map<string, string>()
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    }
    saveInsertOptions({ ...DEFAULT_INSERT_OPTIONS, size: 'S' }, store)
    expect(mem.has(INSERT_OPTIONS_KEY)).toBe(true)
    expect(loadInsertOptions(store).size).toBe('S')
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(loadInsertOptions(broken)).toEqual(DEFAULT_INSERT_OPTIONS)
    expect(() => saveInsertOptions(DEFAULT_INSERT_OPTIONS, broken)).not.toThrow()
    expect(loadInsertOptions(null)).toEqual(DEFAULT_INSERT_OPTIONS)
  })

  it('the dev override: dev-auth builds only, "1" or "0", unreadable is none', () => {
    expect(elementsPanelOverride(true, () => '1')).toBe(true)
    expect(elementsPanelOverride(true, () => '0')).toBe(false)
    expect(elementsPanelOverride(true, () => null)).toBeNull()
    expect(elementsPanelOverride(false, () => '1')).toBeNull()
    expect(
      elementsPanelOverride(true, () => {
        throw new Error('blocked')
      }),
    ).toBeNull()
  })
})

describe('who sees the library', () => {
  const facts = {
    nameOnlyGuest: false,
    workspaceRole: 'member' as const,
    access: { creator: true },
    libraryOnApi: true,
  }

  it('members with an account; never guests, workspace guests, strangers, or an api without the library', () => {
    expect(elementsAccess(facts)).toEqual({ library: true, workspaceSave: true, workspaceSaveReason: null })
    for (const role of ['owner', 'admin'] as const)
      expect(elementsAccess({ ...facts, workspaceRole: role }).library).toBe(true)
    expect(elementsAccess({ ...facts, nameOnlyGuest: true }).library).toBe(false)
    expect(elementsAccess({ ...facts, workspaceRole: 'guest' }).library).toBe(false)
    expect(elementsAccess({ ...facts, workspaceRole: null }).library).toBe(false)
    expect(elementsAccess({ ...facts, libraryOnApi: false }).library).toBe(false)
  })

  it('an outsider (not a creator) has the library but saves to their own, and is told why', () => {
    const a = elementsAccess({ ...facts, access: { creator: false } })
    expect(a.library).toBe(true)
    expect(a.workspaceSave).toBe(false)
    expect(a.workspaceSaveReason).toMatch(/work address/)
  })
})
