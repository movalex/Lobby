// Wave Q (WS3): the web library client against WS2's routes, with a fake api client (the routes and their answers are
// the contracts'). Every answer is parsed with its schema, a 404 to the list latches the library off for that
// workspace (later reads answer empty with no request, writes reject 'unavailable'), other read failures answer the
// safe default, and writes reject with the api's own code. And the marks store (./marks.ts) on top of it.
import { libraryItemPath, libraryListPath, libraryMarksPath, libraryPlacePath } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client.ts'
import {
  deleteLibraryItem,
  getLibraryItem,
  LibraryRequestError,
  libraryAvailable,
  listLibrary,
  listLibraryFolders,
  listLibraryMarks,
  patchLibraryItem,
  placeLibraryItem,
  putLibraryMark,
  resetLibraryClient,
  saveLibraryItem,
  setLibraryRequester,
  subscribeLibrary,
} from './client.ts'
import { createMarksStore } from './marks.ts'
import { type FakeCall, fakeLibraryApi, summary, TEST_ITEM, TEST_WORKSPACE } from './test-kit.ts'

const W = TEST_WORKSPACE
const ITEM = TEST_ITEM

let calls: FakeCall[] = []
let answer: (c: FakeCall) => unknown = () => undefined

beforeEach(() => {
  resetLibraryClient()
  calls = fakeLibraryApi((c) => answer(c))
})
afterEach(() => setLibraryRequester(null))

describe('the library client', () => {
  it('lists a page with its query, parsed with the contract', async () => {
    answer = () => ({ items: [summary()], nextCursor: 'c2' })
    const r = await listLibrary(W, { scope: 'personal', q: 'flow' })
    expect(r.items.map((i) => i.id)).toEqual([ITEM])
    expect(r.nextCursor).toBe('c2')
    expect(calls).toEqual([
      { method: 'GET', path: libraryListPath(W, { scope: 'personal', q: 'flow' }), body: undefined },
    ])
    expect(libraryAvailable(W)).toBe(true)
  })

  it('a 404 to the list latches the library off for that workspace: no more requests, writes unavailable', async () => {
    let told = 0
    const off = subscribeLibrary(() => told++)
    answer = () => new ApiError('not-found', 404, 'NOT_FOUND', 'Not found')
    expect(await listLibrary(W)).toEqual({ items: [], nextCursor: null })
    expect(libraryAvailable(W)).toBe(false)
    expect(libraryAvailable('wsp_other0123456789')).toBe(true)
    expect(told).toBe(1)
    const n = calls.length
    expect(await listLibrary(W)).toEqual({ items: [], nextCursor: null })
    expect(await getLibraryItem(W, ITEM)).toBeNull()
    expect(await listLibraryFolders(W, 'workspace')).toEqual([])
    expect(await listLibraryMarks(W)).toEqual({ favourites: [], recents: [] })
    const err = await deleteLibraryItem(W, ITEM).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(LibraryRequestError)
    expect((err as LibraryRequestError).code).toBe('unavailable')
    expect(calls.length).toBe(n)
    off()
  })

  it('a 404 to one item is that item’s answer, never a latch; an unreadable answer reads as nothing', async () => {
    answer = () => new ApiError('not-found', 404, 'NOT_FOUND', 'Not found')
    expect(await getLibraryItem(W, ITEM)).toBeNull()
    expect(libraryAvailable(W)).toBe(true)
    answer = () => ({ items: [{ id: 'not an id' }], nextCursor: null })
    expect(await listLibrary(W)).toEqual({ items: [], nextCursor: null })
    expect(libraryAvailable(W)).toBe(true)
    answer = () => new ApiError('server', 500, 'HTTP_500', 'x')
    expect(await putLibraryMark(W, { key: 'piece:decision', favourite: true })).toBeNull()
  })

  it('writes send the contract bodies and reject with the api’s code', async () => {
    answer = () => summary({ revision: 2, name: 'Renamed' })
    const saved = await patchLibraryItem(W, ITEM, { revision: 1, name: 'Renamed' })
    expect(saved.revision).toBe(2)
    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      path: libraryItemPath(W, ITEM),
      body: { revision: 1, name: 'Renamed' },
    })
    for (const [e, code, status] of [
      [new ApiError('forbidden', 403, 'CREATOR_REQUIRED', 'x'), 'CREATOR_REQUIRED', 403],
      [new ApiError('conflict', 409, 'LIBRARY_STALE_REVISION', 'x'), 'LIBRARY_STALE_REVISION', 409],
      [new ApiError('network', 0, 'NETWORK', 'x'), 'unavailable', null],
    ] as const) {
      answer = () => e
      const err = await saveLibraryItem(W, {
        scope: 'workspace',
        name: 'A',
        tags: [],
        folderId: null,
        sourceBoardId: 'b-board01',
        elements: [{ id: 'a' }],
      }).then(
        () => null,
        (x: unknown) => x,
      )
      expect(err).toBeInstanceOf(LibraryRequestError)
      expect((err as LibraryRequestError).code).toBe(code)
      expect((err as LibraryRequestError).status).toBe(status)
    }
  })

  it('place posts to the board’s route and parses the item’s elements and files', async () => {
    answer = () => ({
      item: { id: ITEM, name: 'Flow start', revision: 3 },
      elements: [{ id: 'e1', type: 'rectangle' }],
      files: [],
    })
    const r = await placeLibraryItem('b-board01', ITEM)
    expect(r.item.revision).toBe(3)
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: libraryPlacePath('b-board01', ITEM),
      body: undefined,
    })
  })

  it('marks: reads and a star', async () => {
    answer = (c) =>
      c.method === 'GET'
        ? { favourites: [{ key: 'piece:decision', favourite: true, usedAt: null }], recents: [] }
        : { key: 'piece:process', favourite: true, usedAt: null }
    expect((await listLibraryMarks(W)).favourites.map((m) => m.key)).toEqual(['piece:decision'])
    expect(await putLibraryMark(W, { key: 'piece:process', favourite: true })).toMatchObject({
      key: 'piece:process',
    })
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: libraryMarksPath(W),
      body: { key: 'piece:process', favourite: true },
    })
  })
})

describe('the marks store (favourites and recents)', () => {
  it('a star shows at once and goes back when the api refuses it; uses go in front, built-ins stamped', async () => {
    answer = (c) => {
      const used = { key: 'piece:process', favourite: false, usedAt: '2026-10-15' }
      if (c.method === 'GET') return { favourites: [], recents: [used] }
      const body = c.body as { key: string; favourite?: boolean }
      if (body.key === 'piece:decision' && body.favourite) return new ApiError('server', 500, 'HTTP_500', 'x')
      return { key: body.key, favourite: body.favourite ?? false, usedAt: null }
    }
    const store = createMarksStore(W, () => true)
    await store.load()
    expect(store.state.get()).toMatchObject({ loaded: true, favourites: [], recents: ['piece:process'] })
    const starring = store.setFavourite('piece:decision', true)
    expect(store.isFavourite('piece:decision')).toBe(true)
    expect(await starring).toBe(false)
    expect(store.isFavourite('piece:decision')).toBe(false)
    expect(await store.setFavourite('piece:button', true)).toBe(true)
    expect(store.state.get().favourites).toEqual(['piece:button'])
    store.used('piece:button', true)
    store.used(`item:${ITEM}`, false)
    expect(store.state.get().recents).toEqual([`item:${ITEM}`, 'piece:button', 'piece:process'])
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { key: 'piece:decision', favourite: true },
      { key: 'piece:button', favourite: true },
      { key: 'piece:button', used: true },
    ])
  })

  it('without the library: no request, recents of this tab only, no stars', async () => {
    answer = () => {
      throw new Error('no request expected')
    }
    const store = createMarksStore(W, () => false)
    await store.load()
    expect(await store.setFavourite('piece:decision', true)).toBe(false)
    store.used('piece:decision', true)
    expect(store.state.get()).toMatchObject({ favourites: [], recents: ['piece:decision'] })
    expect(calls).toEqual([])
  })
})
