// The wave Q foundation's web side: the 'elements' feature is registered and contributes nothing while ELEMENTS_PANEL is
// off, the library client answers its safe defaults on an api without the routes, and the contracts the four
// workstreams share agree with the engine-side limits and lists they mirror. OWNER: WS3 (the client's own tests are
// features/elements/client.test.ts; the panel's, features/elements/*.test.ts).
import { LOBBY_COLOR_NAMES } from '@draftroom/board-ops/elements'
import { lobbyKeySpec } from '@draftroom/canvas-schema/custom-data'
import {
  ASSET_ID_PATTERN,
  MAX_LINEAR_POINTS,
  MAX_OPS_PER_PUSH,
  MAX_PUSH_BYTES,
  VERSION_ID_PATTERN,
} from '@draftroom/canvas-schema/limits'
import {
  ELEMENTS_OPEN_COMMAND_ID,
  ELEMENTS_PANEL_ID,
  elementDragPayload,
  ICON_ELEMENT_KIND,
  ICON_MAX_LINE_POINTS,
  ICON_NAME_MAX,
  ICON_SET_IDS,
  INSERT_COLOR_NAMES,
  iconAltText,
  LIBRARY_ASSET_ID_PATTERN,
  LIBRARY_LIMITS,
  LIBRARY_VERSION_ID_PATTERN,
  libraryMarkKey,
  PENDING_PALETTE_COMMAND_IDS,
  PIECE_ID_PATTERN,
  parseElementDrag,
  parseLibraryMarkKey,
} from '@draftroom/contracts'
import { PIECE_IDS, pieceKind } from '@draftroom/templates/pieces/catalog'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../api/client.ts'
import type { CanvasFeatureContext } from '../canvas/api/index.ts'
import { CANVAS_FEATURES } from './canvas-registry.ts'
import {
  createLibraryFolder,
  deleteLibraryFolder,
  deleteLibraryItem,
  getLibraryItem,
  importLibrary,
  LibraryRequestError,
  libraryAvailable,
  listLibrary,
  listLibraryFolders,
  listLibraryMarks,
  patchLibraryFolder,
  patchLibraryItem,
  placeLibraryItem,
  putLibraryMark,
  resetLibraryClient,
  restoreLibraryItem,
  saveLibraryItem,
  setLibraryRequester,
} from './elements/client.ts'
import { ELEMENTS_PANEL } from './elements/flags.ts'
import { ELEMENTS_PANEL_SPEC, elementsFeature, feature } from './elements/index.tsx'
import { fakeLibraryApi } from './elements/test-kit.ts'
import { PANEL_ID as PIECES_PANEL_ID } from './pieces/commands.ts'

let calls = 0
const g = globalThis as { fetch?: unknown }
let fetchBefore: unknown
beforeEach(() => {
  calls = 0
  fetchBefore = g.fetch
  g.fetch = () => {
    calls++
    return Promise.reject(new Error('no request expected'))
  }
})
afterEach(() => {
  g.fetch = fetchBefore
  // the library client goes through its requester; it never calls fetch itself
  expect(calls).toBe(0)
})

const W = 'wsp_0123456789abcdefghij'
const ITEM = 'lbi_0123456789abcdefghij'
const FOLDER = 'lbf_0123456789abcdefghij'
const ctxAs = (role: string, status = 'active') =>
  ({ role, board: { status } }) as unknown as CanvasFeatureContext

describe('the elements feature (WS3)', () => {
  it('is registered on the board page, after the wave N features, and is on: the Elements panel replaces Shapes', () => {
    expect(ELEMENTS_PANEL).toBe(true)
    const ids = CANVAS_FEATURES.map((f) => f.id)
    expect(ids.at(-1)).toBe('elements')
    expect(ids.indexOf('elements')).toBeGreaterThan(ids.indexOf('board-links'))
    expect(feature).toEqual(elementsFeature(true))
    // the Elements panel is the board's; the Shapes panel's dock entry has retired
    const panels = CANVAS_FEATURES.flatMap((f) => f.panels ?? []).map((p) => p.id)
    expect(panels).toContain(ELEMENTS_PANEL_ID)
    expect(panels).not.toContain(PIECES_PANEL_ID)
    // its command is registered once, and no longer pending
    expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).not.toContain(ELEMENTS_OPEN_COMMAND_ID)
    const commands = CANVAS_FEATURES.flatMap((f) => f.commands ?? []).map((c) => c.id)
    expect(commands.filter((c) => c === ELEMENTS_OPEN_COMMAND_ID)).toHaveLength(1)
  })

  it('switched off, it contributes nothing', () => {
    expect(elementsFeature(false)).toEqual({ id: 'elements' })
  })

  it('switched on, it is one dock panel at the Shapes panel’s place, for people who can edit', () => {
    expect(elementsFeature(true).panels).toEqual([ELEMENTS_PANEL_SPEC])
    expect(ELEMENTS_PANEL_SPEC).toMatchObject({ id: 'elements', label: 'Elements', order: 35 })
    const visible = ELEMENTS_PANEL_SPEC.visible
    if (!visible) throw new Error('the panel decides who sees it')
    expect(visible(ctxAs('editor'))).toBe(true)
    expect(visible(ctxAs('owner'))).toBe(true)
    for (const role of ['viewer', 'commenter']) expect(visible(ctxAs(role)), role).toBe(false)
    expect(visible(ctxAs('editor', 'archived'))).toBe(false)
  })
})

describe('the library client against an api without the library routes (WS2 pending: 404)', () => {
  it('the list latches the library off; reads answer empty and writes reject unavailable, with no more requests', async () => {
    resetLibraryClient()
    const calls = fakeLibraryApi(() => new ApiError('not-found', 404, 'NOT_FOUND', 'Not found'))
    try {
      expect(libraryAvailable(W)).toBe(true)
      expect(await listLibrary(W, { scope: 'personal' })).toEqual({ items: [], nextCursor: null })
      expect(libraryAvailable(W)).toBe(false)
      expect(calls).toHaveLength(1)
      expect(await getLibraryItem(W, ITEM)).toBeNull()
      expect(await listLibraryFolders(W, 'workspace')).toEqual([])
      expect(await listLibraryMarks(W)).toEqual({ favourites: [], recents: [] })
      expect(await putLibraryMark(W, { key: 'piece:decision', favourite: true })).toBeNull()
      const writes: (() => Promise<unknown>)[] = [
        () =>
          saveLibraryItem(W, {
            scope: 'personal',
            name: 'A',
            tags: [],
            folderId: null,
            sourceBoardId: 'b-board01',
            elements: [{ id: 'a' }],
          }),
        () => patchLibraryItem(W, ITEM, { revision: 1, name: 'B' }),
        () => deleteLibraryItem(W, ITEM),
        () => restoreLibraryItem(W, ITEM),
        () =>
          importLibrary(W, {
            scope: 'personal',
            fileName: 'a.excalidrawlib',
            licence: 'MIT',
            author: null,
            folderId: null,
            items: [{ name: 'A', elements: [{ id: 'a' }] }],
          }),
        () => createLibraryFolder(W, { scope: 'personal', name: 'F' }),
        () => patchLibraryFolder(W, FOLDER, { name: 'G' }),
        () => deleteLibraryFolder(W, FOLDER),
      ]
      for (const write of writes) {
        const err = await write().then(
          () => null,
          (e: unknown) => e,
        )
        expect(err).toBeInstanceOf(LibraryRequestError)
        expect((err as LibraryRequestError).code).toBe('unavailable')
      }
      expect(calls).toHaveLength(1)
      // /place belongs to the board, not the workspace: its own 404 is its answer
      const placed = await placeLibraryItem('b-board01', ITEM).then(
        () => null,
        (e: unknown) => e,
      )
      expect((placed as LibraryRequestError).code).toBe('NOT_FOUND')
    } finally {
      setLibraryRequester(null)
      resetLibraryClient()
    }
  })
})

describe('the contracts agree with what they mirror', () => {
  it('an item fits one push; an icon’s lines fit the engine’s point cap', () => {
    expect(LIBRARY_LIMITS.itemElements).toBe(MAX_OPS_PER_PUSH)
    expect(LIBRARY_LIMITS.itemBytes * 2).toBeLessThanOrEqual(MAX_PUSH_BYTES)
    expect(ICON_MAX_LINE_POINTS).toBeLessThanOrEqual(MAX_LINEAR_POINTS)
  })

  it('the id patterns and the colour names are canvas-schema’s and board-ops’ own', () => {
    expect(LIBRARY_ASSET_ID_PATTERN.source).toBe(ASSET_ID_PATTERN.source)
    expect(LIBRARY_VERSION_ID_PATTERN.source).toBe(VERSION_ID_PATTERN.source)
    expect([...INSERT_COLOR_NAMES]).toEqual([...LOBBY_COLOR_NAMES])
  })

  it('an icon’s markers are keys the room accepts today (no CONTRACTS_REV bump)', () => {
    const kind = lobbyKeySpec('kind')
    const alt = lobbyKeySpec('alt')
    if (!kind || !alt) throw new Error('kind and alt are registry keys')
    expect(kind.value.safeParse(ICON_ELEMENT_KIND).success).toBe(true)
    expect(kind.class).toBe('create-only')
    for (const set of ICON_SET_IDS)
      expect(alt.value.safeParse(iconAltText(set, 'x'.repeat(ICON_NAME_MAX))).success, set).toBe(true)
  })

  it('every built-in shape has a mark key, a drag payload and a kind that fit their grammars', () => {
    for (const id of PIECE_IDS) {
      expect(PIECE_ID_PATTERN.test(id), id).toBe(true)
      expect(parseLibraryMarkKey(libraryMarkKey({ source: 'piece', id }))).toEqual({ source: 'piece', id })
      expect(parseElementDrag(elementDragPayload({ source: 'piece', id }))).toEqual({ source: 'piece', id })
      expect(lobbyKeySpec('kind')?.value.safeParse(pieceKind(id)).success, id).toBe(true)
    }
  })
})
