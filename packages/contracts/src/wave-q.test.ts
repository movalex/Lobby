// The wave Q foundation's contracts (OWNER: WS2 after the foundation): the element library, the built-in icons' index
// and shard formats, the Elements panel's drag payloads and insert options, the guard-list keys, the new usage events.
import { describe, expect, it } from 'vitest'
import {
  CreateLibraryItemInput,
  DEFAULT_INSERT_OPTIONS,
  ELEMENT_DRAG_PREFIX,
  ELEMENTS_OPEN_COMMAND_ID,
  ELEMENTS_PANEL_ID,
  elementDragPayload,
  ICON_ASSET_PREFIX,
  ICON_INDEX_FILE_PATTERN,
  ICON_MAX_PRIMITIVES,
  ICON_SHARD_COUNT,
  ICON_SHARD_FILE_PATTERN,
  ICON_SIZE_PRESETS,
  IconGeometry,
  IconIndex,
  IconShard,
  ImportLibraryInput,
  InsertOptions,
  iconAltText,
  iconKey,
  isUsageEvent,
  LIBRARY_CODES,
  LIBRARY_CREATOR_IN_ROUTE_KEYS,
  LIBRARY_GUEST_ROUTE_KEYS,
  LIBRARY_LIMITS,
  LIBRARY_ROUTE_KEYS,
  LIBRARY_ROUTES,
  LibraryItem,
  LibraryItemSummary,
  LibraryMarkKey,
  ListLibraryMarksResponse,
  ListLibraryQuery,
  libraryFolderPath,
  libraryItemPath,
  libraryListPath,
  libraryMarkKey,
  libraryPlacePath,
  libraryThumbPath,
  PALETTE_COMMAND_IDS,
  PatchLibraryFolderInput,
  PatchLibraryItemInput,
  PENDING_PALETTE_COMMAND_IDS,
  PlaceLibraryItemResponse,
  PutLibraryMarkInput,
  parseElementDrag,
  parseIconKey,
  parseLibraryMarkKey,
  USAGE_EVENT_PATTERN,
} from './index.ts'

const ITEM = 'lbi_0123456789abcdefghij'
const FOLDER = 'lbf_0123456789abcdefghij'
const W = 'wsp_0123456789abcdefghij'
const VER = 'ver_0123456789abcdefghij'
const AST = 'ast_0123456789abcdefghij'
const EL = { id: 'a1', type: 'rectangle', x: 0, y: 0 }

const summary = {
  id: ITEM,
  scope: 'workspace',
  folderId: null,
  name: 'Approval flow',
  tags: ['flow'],
  elementCount: 3,
  imageCount: 0,
  width: 400,
  height: 200,
  internalOnly: false,
  revision: 1,
  sourceKind: 'board',
  createdBy: { id: 'usr_0123456789abcdefghij', name: 'Alice' },
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
  deletedAt: null,
  canEdit: true,
}

describe('the library routes and their guard keys (WS2)', () => {
  it('15 routes, keyed METHOD pattern; a guest is refused all of them; 8 writes are creator-gated in the route', () => {
    expect(LIBRARY_ROUTE_KEYS).toHaveLength(15)
    expect(new Set(LIBRARY_ROUTE_KEYS).size).toBe(15)
    for (const k of LIBRARY_ROUTE_KEYS)
      expect(k).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\/(workspaces\/:wid|boards\/:bid)\/library\b/)
    expect([...LIBRARY_GUEST_ROUTE_KEYS].sort()).toEqual([...LIBRARY_ROUTE_KEYS].sort())
    expect(LIBRARY_CREATOR_IN_ROUTE_KEYS).toHaveLength(8)
    // no read and no personal-only action needs a creator: lists, details, thumbs, marks, place
    for (const k of LIBRARY_CREATOR_IN_ROUTE_KEYS) {
      expect(LIBRARY_ROUTE_KEYS as readonly string[]).toContain(k)
      expect(k).not.toMatch(/^GET |\/marks$|\/place$/)
    }
    expect(LIBRARY_ROUTES.place).toBe('/api/boards/:bid/library/items/:id/place')
  })

  it('the path builders fill the patterns and encode what they are given', () => {
    expect(libraryItemPath(W, ITEM)).toBe(`/api/workspaces/${W}/library/items/${ITEM}`)
    expect(libraryFolderPath(W, FOLDER)).toBe(`/api/workspaces/${W}/library/folders/${FOLDER}`)
    expect(libraryPlacePath('b-board01', ITEM)).toBe(`/api/boards/b-board01/library/items/${ITEM}/place`)
    expect(libraryThumbPath(W, ITEM, VER)).toBe(
      `/api/workspaces/${W}/library/items/${ITEM}/files/${VER}/thumb`,
    )
    expect(libraryListPath(W)).toBe(`/api/workspaces/${W}/library`)
    expect(libraryListPath(W, { scope: 'personal', q: 'a b&c', tag: undefined })).toBe(
      `/api/workspaces/${W}/library?scope=personal&q=a%20b%26c`,
    )
    expect(libraryItemPath(W, '../x')).toBe(`/api/workspaces/${W}/library/items/..%2Fx`)
  })

  it('every refusal code is distinct and none is a generic one', () => {
    const codes = Object.values(LIBRARY_CODES)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of codes) expect(c).toMatch(/^LIBRARY_[A-Z_]+$/)
  })
})

describe('the library schemas (WS2, WS3)', () => {
  it('limits: an item fits one push (500 ops, 256 KiB of a 512 KiB push)', () => {
    expect(LIBRARY_LIMITS.itemElements).toBe(500)
    expect(LIBRARY_LIMITS.itemBytes).toBe(256 * 1024)
    expect(LIBRARY_LIMITS.importBytes).toBe(5 * 1024 * 1024)
    expect(LIBRARY_LIMITS.recents).toBe(12)
  })

  it('a create: strict, tags trimmed, lowercased and deduped, defaults for tags and folder', () => {
    const ok = CreateLibraryItemInput.parse({
      scope: 'workspace',
      name: '  Approval flow ',
      tags: [' Flow', 'flow', 'Sign Off'],
      sourceBoardId: 'b-board01',
      elements: [EL],
    })
    expect(ok).toEqual({
      scope: 'workspace',
      name: 'Approval flow',
      tags: ['flow', 'sign off'],
      folderId: null,
      sourceBoardId: 'b-board01',
      elements: [EL],
    })
    const base = { scope: 'personal', name: 'x', sourceBoardId: 'b-board01', elements: [EL] }
    expect(CreateLibraryItemInput.safeParse({ ...base, extra: 1 }).success).toBe(false)
    expect(CreateLibraryItemInput.safeParse({ ...base, elements: [] }).success).toBe(false)
    expect(CreateLibraryItemInput.safeParse({ ...base, elements: Array(501).fill(EL) }).success).toBe(false)
    expect(CreateLibraryItemInput.safeParse({ ...base, name: 'x'.repeat(81) }).success).toBe(false)
    expect(CreateLibraryItemInput.safeParse({ ...base, tags: Array(11).fill('a') }).success).toBe(false)
    expect(CreateLibraryItemInput.safeParse({ ...base, tags: ['#hash'] }).success).toBe(false)
    expect(CreateLibraryItemInput.safeParse({ ...base, scope: 'everyone' }).success).toBe(false)
    expect(CreateLibraryItemInput.safeParse({ ...base, folderId: 'lbf_x' }).success).toBe(false)
  })

  it('a patch names its revision and changes something; new elements name the board to check them against', () => {
    expect(PatchLibraryItemInput.safeParse({ revision: 2, name: 'New' }).success).toBe(true)
    expect(PatchLibraryItemInput.safeParse({ revision: 2, folderId: null }).success).toBe(true)
    expect(PatchLibraryItemInput.safeParse({ revision: 2 }).success).toBe(false)
    expect(PatchLibraryItemInput.safeParse({ name: 'New' }).success).toBe(false)
    expect(PatchLibraryItemInput.safeParse({ revision: 0, name: 'New' }).success).toBe(false)
    expect(PatchLibraryItemInput.safeParse({ revision: 2, elements: [EL] }).success).toBe(false)
    expect(
      PatchLibraryItemInput.safeParse({ revision: 2, elements: [EL], sourceBoardId: 'b-board01' }).success,
    ).toBe(true)
    expect(PatchLibraryItemInput.safeParse({ revision: 2, sourceBoardId: 'b-board01' }).success).toBe(false)
    expect(PatchLibraryFolderInput.safeParse({}).success).toBe(false)
    expect(PatchLibraryFolderInput.safeParse({ position: 3 }).success).toBe(true)
  })

  it('an import: the default licence note, at most 500 items, each a name and elements', () => {
    const ok = ImportLibraryInput.parse({
      scope: 'personal',
      fileName: 'arrows.excalidrawlib',
      items: [{ name: 'A', elements: [EL] }],
    })
    expect(ok.licence).toMatch(/check its licence/)
    expect(ok.author).toBeNull()
    const many = Array.from({ length: 501 }, () => ({ name: 'A', elements: [EL] }))
    expect(ImportLibraryInput.safeParse({ scope: 'personal', fileName: 'x', items: many }).success).toBe(
      false,
    )
    expect(ImportLibraryInput.safeParse({ scope: 'personal', fileName: 'x', items: [] }).success).toBe(false)
  })

  it('summaries, details and the place answer parse; a detail carries elements, files and its source', () => {
    expect(LibraryItemSummary.safeParse(summary).success).toBe(true)
    expect(LibraryItemSummary.safeParse({ ...summary, elementCount: 0 }).success).toBe(false)
    const detail = {
      ...summary,
      elements: [EL],
      files: [{ assetId: AST, versionId: VER }],
      source: { kind: 'excalidrawlib', fileName: 'a.excalidrawlib', licence: 'MIT', author: null },
    }
    expect(LibraryItem.safeParse(detail).success).toBe(true)
    const files = [{ assetId: AST, versionId: 'data:x' }]
    expect(LibraryItem.safeParse({ ...detail, files }).success).toBe(false)
    const source = { kind: 'url', url: 'https://x' }
    expect(LibraryItem.safeParse({ ...detail, source }).success).toBe(false)
    // a board's id only to those who may still view it
    for (const boardId of ['b-board01', null])
      expect(LibraryItem.safeParse({ ...detail, source: { kind: 'board', boardId } }).success).toBe(true)
    const placed = {
      item: { id: ITEM, name: 'A', revision: 3 },
      elements: [EL],
      files: [
        { assetId: AST, versionId: VER, kind: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 10 },
      ],
    }
    expect(PlaceLibraryItemResponse.safeParse(placed).success).toBe(true)
  })

  it('the list query: workspace by default, a folder or none, deleted only as 1', () => {
    expect(ListLibraryQuery.parse({})).toEqual({ scope: 'workspace' })
    expect(ListLibraryQuery.safeParse({ folder: 'none' }).success).toBe(true)
    expect(ListLibraryQuery.safeParse({ folder: FOLDER }).success).toBe(true)
    expect(ListLibraryQuery.safeParse({ deleted: 'true' }).success).toBe(false)
    expect(ListLibraryQuery.safeParse({ q: 'x'.repeat(81) }).success).toBe(false)
  })
})

describe('mark keys: favourites and recents of every source', () => {
  it('builds and parses icon, piece and item keys; anything else is not one', () => {
    const icon = libraryMarkKey({ source: 'icon', set: 'lucide', name: 'arrow-right', version: '1.49.0' })
    expect(icon).toBe('icon:lucide:arrow-right@1.49.0')
    expect(parseLibraryMarkKey(icon)).toEqual({
      source: 'icon',
      set: 'lucide',
      name: 'arrow-right',
      version: '1.49.0',
    })
    expect(parseLibraryMarkKey('piece:decision')).toEqual({ source: 'piece', id: 'decision' })
    expect(parseLibraryMarkKey(`item:${ITEM}`)).toEqual({ source: 'item', id: ITEM })
    for (const bad of [
      'icon:lucide:arrow-right',
      'icon:feather:x@1.0.0',
      'icon:lucide:Arrow@1.0.0',
      'piece:Decision',
      'piece:',
      'item:lbi_short',
      'board:b-board01',
      `item:${ITEM} `,
      7,
    ])
      expect(parseLibraryMarkKey(bad), String(bad)).toBeNull()
    expect(LibraryMarkKey.safeParse(icon).success).toBe(true)
    expect(PutLibraryMarkInput.safeParse({ key: icon, favourite: true }).success).toBe(true)
    expect(PutLibraryMarkInput.safeParse({ key: icon, used: true }).success).toBe(true)
    expect(PutLibraryMarkInput.safeParse({ key: icon }).success).toBe(false)
    expect(PutLibraryMarkInput.safeParse({ key: icon, used: false }).success).toBe(false)
    expect(ListLibraryMarksResponse.safeParse({ favourites: [], recents: [] }).success).toBe(true)
  })
})

describe('the icon index and shards (WS1)', () => {
  const shards = Array.from({ length: ICON_SHARD_COUNT }, (_, i) => `shard-${i}.0123abcd.json`)
  const index = {
    format: 'lobby-icon-index',
    version: 1,
    sets: [
      { id: 'lucide', version: '1.49.0', licence: 'ISC', count: 1 },
      { id: 'tabler', version: '3.48.0', licence: 'MIT', count: 1 },
    ],
    shards,
    icons: [
      ['lucide', 'arrow-right', ['forward', 'next'], null, 5],
      ['tabler', 'arrow-right', ['arrow'], 'Arrows', 63],
    ],
  }

  it('an index lists sets, 64 hashed shard names and [set, name, tags, category, shard] entries', () => {
    expect(IconIndex.safeParse(index).success).toBe(true)
    expect(IconIndex.safeParse({ ...index, shards: shards.slice(1) }).success).toBe(false)
    expect(IconIndex.safeParse({ ...index, icons: [['lucide', 'Arrow', [], null, 0]] }).success).toBe(false)
    expect(IconIndex.safeParse({ ...index, icons: [['lucide', 'a', [], null, 64]] }).success).toBe(false)
    expect(IconIndex.safeParse({ ...index, extra: true }).success).toBe(false)
    expect(ICON_INDEX_FILE_PATTERN.test('index.0123abcd.json')).toBe(true)
    expect(ICON_INDEX_FILE_PATTERN.test('index.json')).toBe(false)
    expect(ICON_SHARD_FILE_PATTERN.exec('shard-12.deadbeef.json')?.[1]).toBe('12')
    expect(ICON_ASSET_PREFIX).toBe('/lobby-assets/icons/')
  })

  it('a shard holds geometry per icon key: lines, ellipses and rectangles on the 24 grid', () => {
    const shard = {
      format: 'lobby-icon-shard',
      version: 1,
      shard: 5,
      icons: {
        [iconKey('lucide', 'arrow-right')]: [
          { t: 'line', p: [5, 12, 19, 12] },
          { t: 'line', p: [12, 5, 19, 12, 12, 19] },
        ],
        'lucide:circle-dot': [
          { t: 'ellipse', x: 2, y: 2, w: 20, h: 20 },
          { t: 'ellipse', x: 11, y: 11, w: 2, h: 2, f: true },
        ],
        'tabler:square': [{ t: 'rect', x: 4, y: 4, w: 16, h: 16, r: 2 }],
      },
    }
    expect(IconShard.safeParse(shard).success).toBe(true)
    const bad = (geometry: unknown) =>
      IconShard.safeParse({ ...shard, icons: { 'lucide:x': geometry } }).success
    expect(bad([{ t: 'line', p: [0, 0, 1] }])).toBe(false)
    expect(bad([{ t: 'line', p: [0, 0] }])).toBe(false)
    expect(bad([{ t: 'line', p: [0, 0, 30, 30] }])).toBe(false)
    expect(bad([{ t: 'path', d: 'M0 0' }])).toBe(false)
    expect(bad([])).toBe(false)
    expect(bad(Array(ICON_MAX_PRIMITIVES + 1).fill({ t: 'rect', x: 0, y: 0, w: 1, h: 1 }))).toBe(false)
    expect(IconGeometry.safeParse([{ t: 'rect', x: 0, y: 0, w: 1, h: 1 }]).success).toBe(true)
    const feather = { 'feather:x': [{ t: 'rect', x: 0, y: 0, w: 1, h: 1 }] }
    expect(IconShard.safeParse({ ...shard, icons: feather }).success).toBe(false)
  })

  it('icon keys and alt text', () => {
    expect(parseIconKey('tabler:arrow-right')).toEqual({ set: 'tabler', name: 'arrow-right' })
    expect(parseIconKey('tabler:')).toBeNull()
    expect(parseIconKey('lucide:a:b')).toBeNull()
    expect(iconAltText('lucide', 'arrow-right')).toBe('Lucide icon: arrow-right')
    expect(ICON_SIZE_PRESETS).toEqual({
      S: { px: 48, strokeWidth: 4 },
      M: { px: 96, strokeWidth: 8 },
      L: { px: 192, strokeWidth: 16 },
    })
  })
})

describe('the Elements panel (WS3)', () => {
  it('drag payloads round-trip for each source; other text is not the panel’s', () => {
    for (const t of [
      { source: 'icon', id: 'lucide:arrow-right' },
      { source: 'piece', id: 'decision' },
      { source: 'item', id: ITEM },
    ] as const)
      expect(parseElementDrag(elementDragPayload(t))).toEqual(t)
    for (const bad of [
      'lobby-piece:decision',
      `${ELEMENT_DRAG_PREFIX}icon:arrow-right`,
      `${ELEMENT_DRAG_PREFIX}icon:feather:x`,
      `${ELEMENT_DRAG_PREFIX}item:lbi_x`,
      `${ELEMENT_DRAG_PREFIX}board:b-board01`,
      `${ELEMENT_DRAG_PREFIX}piece:decision\nmore`,
      `${ELEMENT_DRAG_PREFIX}piece:${'a'.repeat(200)}`,
      'buy milk',
      null,
    ])
      expect(parseElementDrag(bad), String(bad)).toBeNull()
  })

  it('insert options: a bad stored value falls back per field; the defaults keep things together, unlocked', () => {
    expect(InsertOptions.parse(DEFAULT_INSERT_OPTIONS)).toEqual(DEFAULT_INSERT_OPTIONS)
    expect(InsertOptions.parse({ color: 'mauve', size: 'XL', keepTogether: 'yes', lock: 1 })).toEqual(
      DEFAULT_INSERT_OPTIONS,
    )
    expect(InsertOptions.parse({ color: 'blue', size: 'L', keepTogether: false, lock: true })).toEqual({
      color: 'blue',
      size: 'L',
      keepTogether: false,
      lock: true,
    })
    expect(ELEMENTS_PANEL_ID).toBe('elements')
  })

  it('the panel command is a palette id, no longer pending (the integration turned the panel on); the new usage events are valid', () => {
    expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(ELEMENTS_OPEN_COMMAND_ID)
    expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).not.toContain(ELEMENTS_OPEN_COMMAND_ID)
    expect(isUsageEvent(`palette.run:${ELEMENTS_OPEN_COMMAND_ID}`)).toBe(true)
    for (const e of [
      'elements.insert.icon',
      'elements.insert.piece',
      'elements.insert.item',
      'elements.save',
      'elements.favourite',
      'elements.import',
    ]) {
      expect(isUsageEvent(e), e).toBe(true)
      expect(e).toMatch(USAGE_EVENT_PATTERN)
    }
  })
})
