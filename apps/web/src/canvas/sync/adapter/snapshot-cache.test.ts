// M6-1 (wave M, PWR-4): the board cache, a private and purgeable copy of the CONFIRMED server state. These tests run
// the store over an in-memory IndexedDB (testing/memoryIdb.ts: the repo has no fake-indexeddb dependency and wave M
// adds none) and the engine core over the protocol fake.
import { isRedactedTombstone } from '@draftroom/canvas-schema/elements'
import { hashElements } from '@draftroom/canvas-schema/hash'
import { CONTRACTS_REV, ELEMENT_SCHEMA_VERSION } from '@draftroom/canvas-schema/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rect, text } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness } from '../testing/harness.ts'
import { createMemoryIdb, type MemoryIdb } from '../testing/memoryIdb.ts'
import type { SceneElement } from '../types.ts'
import {
  CACHE_BOARDS,
  CACHE_DB,
  CACHE_INDEX,
  cacheConnection,
  preloadBoardCache,
  purgeBoardCachesOf,
  setPageCacheConnectionForTests,
} from './board-cache-db.ts'
import { createSignOutPurge } from './offline-idb.ts'
import {
  type BoardCacheStore,
  type CacheContent,
  cacheElementsOf,
  cacheHash,
  cacheRecordOf,
  createBoardCacheStore,
  hasUrl,
  purgeBoardCache,
  setBoardCacheForTests,
  sha256Hex,
  takeBoardCache,
} from './snapshot-cache.ts'

const content = (elements: SceneElement[], clock = 7, epoch = 'epoch1'): CacheContent => ({
  epoch,
  clock,
  horizon: 0,
  elements,
})

const els = (n: number, prefix = 'r') =>
  Array.from({ length: n }, (_, i) =>
    stored(rect(`${prefix}${i}`, `a${String(i).padStart(3, '0')}`, { x: i })),
  ) as SceneElement[]

let idb: MemoryIdb
let store: BoardCacheStore
const conn = () => cacheConnection(() => idb.factory)
beforeEach(() => {
  idb = createMemoryIdb()
  store = createBoardCacheStore({ connection: conn() })
})
afterEach(() => {
  setBoardCacheForTests(null)
  setPageCacheConnectionForTests(null)
  vi.unstubAllGlobals()
})

describe('the stored form', () => {
  it('its hash is hash.ts hashElements exactly (a synchronous SHA-256 of the same canonical input)', async () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    // two blocks, and a length past one block
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    )
    const sample = [
      ...els(30),
      stored(text('t1', 'b0', { text: 'grüße 🙂 «quotes»', originalText: 'grüße 🙂 «quotes»' })),
      { ...stored(rect('gone', 'b1')), isDeleted: true },
    ] as SceneElement[]
    expect(cacheHash(sample)).toBe(await hashElements(sample))
    expect(cacheHash([])).toBe(await hashElements([]))
  })

  it('a tombstone is stored as the server sends it (redacted), whatever content this tab kept under it', () => {
    const kept = {
      ...stored(text('t1', 'a0', { text: 'secret words', originalText: 'secret words' })),
      isDeleted: true,
    }
    const { elements, exact } = cacheElementsOf([kept as SceneElement])
    expect(exact).toBe(true)
    expect(isRedactedTombstone(elements[0] as never)).toBe(true)
    expect(JSON.stringify(elements)).not.toContain('secret words')
  })

  it('no data:, blob: or http(s) URL reaches a stored value; such a copy is not exact (it never resumes)', async () => {
    const withUrls = [
      stored(rect('r1', 'a0', { link: 'https://example.com/private?token=abc' })),
      stored(
        text('t1', 'a1', {
          text: 'see http://intranet.example/x today',
          originalText: 'see http://intranet.example/x today',
        }),
      ),
      stored(
        rect('r2', 'a2', {
          customData: { lobby: { note: 'data:image/png;base64,AAAA', other: 'blob:http://x/1' } },
        }),
      ),
      stored(rect('r3', 'a3')),
    ] as SceneElement[]
    const { elements, exact } = cacheElementsOf(withUrls)
    expect(exact).toBe(false)
    expect(hasUrl(elements)).toBe(false)
    // the other words of a text stay
    expect((elements.find((e) => e.id === 't1') as { text?: string }).text).toBe('see  today')
    expect(await store.write('b1', 'usr_a', content(withUrls))).toBe(true)
    // the scan of every stored value, both stores of the database
    for (const s of [CACHE_BOARDS, CACHE_INDEX])
      expect(hasUrl([...idb.store(CACHE_DB, s).values()])).toBe(false)
    const back = await store.read('b1', 'usr_a')
    expect(back?.exact).toBe(false)
    expect(hasUrl(back)).toBe(false)
    // a copy with none is exact
    expect(cacheElementsOf(els(3)).exact).toBe(true)
  })

  it('elements are stored in (index, id) order, the order a scene is installed in', () => {
    const { elements } = cacheElementsOf([
      stored(rect('b', 'a1')),
      stored(rect('a', 'a1')),
      stored(rect('c', 'a0')),
    ] as SceneElement[])
    expect(elements.map((e) => e.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('only the confirmed copy is stored', () => {
  it('a pending edit, an unsent create and an offline change are absent: the record is the server copy', async () => {
    const h = createHarness({
      seed: [stored(rect('r1', 'a0', { x: 10 })), stored(rect('r2', 'a1', { x: 20 }))],
    })
    const a = h.client('alice')
    h.settle()
    expect(a.core.saveStatus.state).toBe('saved')
    // offline: a move of r1 and a new r3, neither acknowledged
    h.room.cut(a.transport)
    h.settle()
    a.change('r1', { x: 555 })
    a.edit((m) => m.set('r3', rect('r3', 'a2', { x: 30 })))
    h.settle()
    expect(a.core.unsentIds().sort()).toEqual(['r1', 'r3'])
    const c = a.core.cacheContent()
    expect(c).not.toBeNull()
    expect(await store.write('b1', 'alice', c as CacheContent)).toBe(true)
    const back = await store.read('b1', 'alice')
    expect(back?.elements.map((e) => e.id)).toEqual(['r1', 'r2'])
    expect(back?.elements.find((e) => e.id === 'r1')?.x).toBe(10)
    // exactly the server's copies
    expect(back?.hash).toBe(await h.roomHash())
    expect(back).toMatchObject({ clock: h.room.clock, epoch: 'epoch1', exact: true })
  })

  it('nothing before the first welcome, nor while a reset waits for its snapshot', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    expect(a.core.cacheContent()).toBeNull()
    h.settle()
    expect(a.core.cacheContent()).not.toBeNull()
  })
})

describe('the bounds (LRU)', () => {
  it(`keeps at most maxBoards records, the most recently saved`, async () => {
    let t = 1000
    store = createBoardCacheStore({ connection: conn(), now: () => t++, maxBoards: 20 })
    for (let i = 0; i < 25; i++) expect(await store.write(`b${i}`, 'usr_a', content(els(2)))).toBe(true)
    const keys = [...idb.store(CACHE_DB, CACHE_BOARDS).keys()].sort()
    expect(keys).toHaveLength(20)
    expect(keys).not.toContain('b0|usr_a')
    expect(keys).not.toContain('b4|usr_a')
    expect(keys).toContain('b5|usr_a')
    expect(keys).toContain('b24|usr_a')
    expect(idb.store(CACHE_DB, CACHE_INDEX).size).toBe(20)
    expect(await store.read('b0', 'usr_a')).toBeNull()
    expect((await store.read('b24', 'usr_a'))?.elements).toHaveLength(2)
  })

  it('keeps at most maxBytes in all; a board over the whole budget is not kept, nor its older copy', async () => {
    let t = 1000
    const one = JSON.stringify(cacheElementsOf(els(10)).elements).length
    store = createBoardCacheStore({ connection: conn(), now: () => t++, maxBytes: one * 3 })
    for (let i = 0; i < 5; i++) expect(await store.write(`b${i}`, 'usr_a', content(els(10)))).toBe(true)
    expect([...idb.store(CACHE_DB, CACHE_BOARDS).keys()].sort()).toEqual(['b2|usr_a', 'b3|usr_a', 'b4|usr_a'])
    const total = [...idb.store(CACHE_DB, CACHE_INDEX).values()].reduce((n, e) => n + (e.bytes as number), 0)
    expect(total).toBeLessThanOrEqual(one * 3)
    // b4 grows past the whole budget: not kept, and its older copy goes too
    expect(await store.write('b4', 'usr_a', content(els(40)))).toBe(false)
    expect(await store.read('b4', 'usr_a')).toBeNull()
    expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b4|usr_a')).toBe(false)
  })
})

describe('every purge empties that board', () => {
  const seedTwo = async () => {
    expect(await store.write('b1', 'usr_a', content(els(2)))).toBe(true)
    expect(await store.write('b2', 'usr_a', content(els(2)))).toBe(true)
    expect(await store.write('b1', 'usr_b', content(els(2)))).toBe(true)
  }

  it('purge(board, user): that record only (a FORBIDDEN close, a 403/404, access-lost, a trashed board, export off)', async () => {
    await seedTwo()
    await store.purge('b1', 'usr_a')
    expect([...idb.store(CACHE_DB, CACHE_BOARDS).keys()].sort()).toEqual(['b1|usr_b', 'b2|usr_a'])
    expect(idb.store(CACHE_DB, CACHE_INDEX).has('b1|usr_a')).toBe(false)
  })

  it('the page purge also cancels a read under way: its record is never shown', async () => {
    const page = createBoardCacheStore({ connection: conn() })
    setBoardCacheForTests(page)
    setPageCacheConnectionForTests(conn())
    expect(await page.write('b1', 'usr_a', content(els(2)))).toBe(true)
    const read = takeBoardCache('b1', 'usr_a')
    expect(read?.value).toBeUndefined()
    await purgeBoardCache('b1', 'usr_a')
    expect(await read?.done).toBeNull()
    expect(read?.value).toBeNull()
    expect(await page.read('b1', 'usr_a')).toBeNull()
  })

  it("the route's early read, then the page's check, gives the record; a purge before the take forgets the early read", async () => {
    const c = conn()
    const page = createBoardCacheStore({ connection: c })
    setBoardCacheForTests(page)
    setPageCacheConnectionForTests(c)
    expect(await page.write('b1', 'usr_a', content(els(2)))).toBe(true)
    preloadBoardCache('b1', 'usr_a')
    const read = takeBoardCache('b1', 'usr_a')
    expect((await read?.done)?.elements).toHaveLength(2)
    preloadBoardCache('b1', 'usr_a')
    await purgeBoardCache('b1', 'usr_a')
    expect(await takeBoardCache('b1', 'usr_a')?.done).toBeNull()
  })

  it("the person's own Sign out: every record of theirs, never another account's", async () => {
    await seedTwo()
    expect(await purgeBoardCachesOf('usr_a', conn())).toBe(2)
    expect([...idb.store(CACHE_DB, CACHE_BOARDS).keys()]).toEqual(['b1|usr_b'])
    expect([...idb.store(CACHE_DB, CACHE_INDEX).keys()]).toEqual(['b1|usr_b'])
  })

  it('createSignOutPurge (App.tsx) purges the board cache with the offline queues, only on an explicit Sign out', async () => {
    vi.stubGlobal('indexedDB', idb.factory)
    vi.stubGlobal('navigator', {})
    setPageCacheConnectionForTests(cacheConnection(() => idb.factory))
    await seedTwo()
    const seen = createSignOutPurge()
    seen({ status: 'signed-in', uid: 'usr_a' })
    seen({ status: 'signed-out', uid: null })
    await new Promise((r) => setTimeout(r, 30))
    expect(idb.store(CACHE_DB, CACHE_BOARDS).size).toBe(3)
    seen({ status: 'signed-in', uid: 'usr_a' })
    seen({ status: 'signed-out', uid: null, explicit: true })
    await vi.waitFor(() => expect([...idb.store(CACHE_DB, CACHE_BOARDS).keys()]).toEqual(['b1|usr_b']))
  })
})

describe('a record of another form is dropped, never translated', () => {
  const seedRaw = async (patch: Record<string, unknown>) => {
    expect(await store.write('b1', 'usr_a', content(els(3)))).toBe(true)
    const rec = idb.store(CACHE_DB, CACHE_BOARDS).get('b1|usr_a') as Record<string, unknown>
    idb.store(CACHE_DB, CACHE_BOARDS).set('b1|usr_a', { ...rec, ...patch, key: 'b1|usr_a' })
  }

  for (const [what, patch] of [
    ['another CONTRACTS_REV', { rev: CONTRACTS_REV - 1 }],
    ['a later CONTRACTS_REV', { rev: CONTRACTS_REV + 1 }],
    ['another element schema', { schema: ELEMENT_SCHEMA_VERSION + 1 }],
    ['no revision at all', { rev: undefined }],
    ['elements that no longer hash to the record (tampered or cut short)', { elements: els(2) }],
    ['a broken record', { elements: 'nope' }],
  ] as const)
    it(what, async () => {
      await seedRaw(patch)
      expect(await store.read('b1', 'usr_a')).toBeNull()
      expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b1|usr_a')).toBe(false)
      expect(idb.store(CACHE_DB, CACHE_INDEX).has('b1|usr_a')).toBe(false)
    })

  it('the current form reads back as written', async () => {
    const three = els(3)
    const written = cacheRecordOf('b1', 'usr_a', content(three), 5) as NonNullable<
      ReturnType<typeof cacheRecordOf>
    >
    expect(await store.write('b1', 'usr_a', content(three))).toBe(true)
    const back = await store.read('b1', 'usr_a')
    expect(back?.hash).toBe(written.hash)
    expect(back?.elements).toEqual(written.elements)
    expect(back).toMatchObject({
      rev: CONTRACTS_REV,
      schema: ELEMENT_SCHEMA_VERSION,
      clock: 7,
      epoch: 'epoch1',
    })
  })
})

describe('IndexedDB failing is harmless', () => {
  it('no IndexedDB at all (the factory throws): nothing read, nothing kept, purges resolve', async () => {
    idb.throwOnOpen = true
    expect(await store.read('b1', 'usr_a')).toBeNull()
    expect(await store.write('b1', 'usr_a', content(els(2)))).toBe(false)
    await expect(store.purge('b1', 'usr_a')).resolves.toBeUndefined()
    expect(await store.purgeUser('usr_a')).toBe(0)
    const none = createBoardCacheStore({ connection: cacheConnection(() => null) })
    expect(await none.read('b1', 'usr_a')).toBeNull()
    expect(await none.write('b1', 'usr_a', content(els(2)))).toBe(false)
  })

  it('the open fails, a transaction throws, a write aborts (quota): never a throw, never a half record', async () => {
    idb.failOpen = true
    expect(await store.write('b1', 'usr_a', content(els(2)))).toBe(false)
    idb.failOpen = false
    // opened again on the next call
    expect(await store.write('b1', 'usr_a', content(els(2)))).toBe(true)
    idb.abortWrites = true
    expect(await store.write('b2', 'usr_a', content(els(2)))).toBe(false)
    expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b2|usr_a')).toBe(false)
    idb.abortWrites = false
    idb.throwOnTransaction = true
    expect(await store.read('b1', 'usr_a')).toBeNull()
    expect(await store.write('b1', 'usr_a', content(els(2)))).toBe(false)
    await expect(store.purge('b1', 'usr_a')).resolves.toBeUndefined()
    expect(await store.purgeUser('usr_a')).toBe(0)
    idb.throwOnTransaction = false
    expect((await store.read('b1', 'usr_a'))?.elements).toHaveLength(2)
  })

  it('an element the store cannot encode (a cycle) is no write, not a throw', async () => {
    const cyclic = stored(rect('r1', 'a0')) as Record<string, unknown>
    cyclic.self = cyclic
    expect(await store.write('b1', 'usr_a', content([cyclic as SceneElement]))).toBe(false)
  })
})
