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
  type CacheChannelLike,
  cacheConnection,
  createSignOutMarks,
  preloadBoardCache,
  purgeBoardCachesOf,
  SIGNED_OUT_PREFIX,
  type SignOutMarks,
  setPageCacheConnectionForTests,
  setPageSignOutMarksForTests,
} from './board-cache-db.ts'
import { createSignOutPurge } from './offline-idb.ts'
import {
  type BoardCacheStore,
  type CacheContent,
  cacheElementsOf,
  cacheJsonOf,
  cacheRecordOf,
  cacheWriteGate,
  createBoardCacheStore,
  hasUrl,
  purgeBoardCache,
  type StoredBoard,
  setBoardCacheForTests,
  sha256Hex,
  storedRecordOf,
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
/** a page's Sign out marks with nothing shared (no localStorage, no channel): each test starts with none */
const isolatedMarks = (): SignOutMarks =>
  createSignOutMarks({ storage: () => null, channel: () => null, storageEvents: () => () => {} })
beforeEach(() => {
  idb = createMemoryIdb()
  setPageSignOutMarksForTests(isolatedMarks())
  store = createBoardCacheStore({ connection: conn() })
})
afterEach(() => {
  setBoardCacheForTests(null)
  setPageCacheConnectionForTests(null)
  setPageSignOutMarksForTests(null)
  vi.unstubAllGlobals()
})

describe('the stored form', () => {
  it('its hash is the SHA-256 of its stored text, and that text is the server copies exactly (hash.ts)', async () => {
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
    const rec = storedRecordOf('b1', 'usr_a', content(sample), 5) as StoredBoard
    expect(rec.hash).toBe(sha256Hex(rec.json))
    expect(rec).toMatchObject({ count: sample.length, bytes: rec.json.length, exact: true })
    // (WebCrypto agrees on the digest of the same text)
    const subtle = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(rec.json))
    expect([...new Uint8Array(subtle)].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(rec.hash)
    // the text parses back to the copies that went in: their convergence hash is the input's
    const back = cacheRecordOf('b1', 'usr_a', content(sample), 5)
    expect(await hashElements(back?.elements ?? [])).toBe(await hashElements(sample))
    expect(cacheRecordOf('b1', 'usr_a', content([]), 5)?.elements).toEqual([])
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
      // after a line break or a tab (in the stored JSON text, a letter of its escape comes right before it)
      stored(
        text('t2', 'a4', {
          text: 'one\ndata:image/png;base64,AAAA\tblob:x',
          originalText: 'one\ndata:image/png;base64,AAAA\tblob:x',
        }),
      ),
    ] as SceneElement[]
    const { elements, exact } = cacheElementsOf(withUrls)
    expect(exact).toBe(false)
    expect(hasUrl(elements)).toBe(false)
    // the other words of a text stay
    expect((elements.find((e) => e.id === 't1') as { text?: string }).text).toBe('see  today')
    expect((elements.find((e) => e.id === 't2') as { text?: string }).text).toBe('one\n\t')
    // only that one, after a line break: the text check still finds it
    const alone = cacheJsonOf([withUrls[4] as SceneElement])
    expect(alone.exact).toBe(false)
    expect(hasUrl(JSON.parse(alone.json))).toBe(false)
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
    expect(await hashElements(back?.elements ?? [])).toBe(await h.roomHash())
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

  it('a record read for an open counts as used: the least recently USED goes first (the W6 review)', async () => {
    let t = 1000
    store = createBoardCacheStore({ connection: conn(), now: () => t++, maxBoards: 3 })
    for (const b of ['b0', 'b1', 'b2']) expect(await store.write(b, 'usr_a', content(els(2)))).toBe(true)
    // b0, the oldest save, is opened again
    expect((await store.read('b0', 'usr_a'))?.elements).toHaveLength(2)
    await vi.waitFor(() => expect(idb.store(CACHE_DB, CACHE_INDEX).get('b0|usr_a')?.usedAt).toBeDefined())
    expect(await store.write('b3', 'usr_a', content(els(2)))).toBe(true)
    expect([...idb.store(CACHE_DB, CACHE_BOARDS).keys()].sort()).toEqual(['b0|usr_a', 'b2|usr_a', 'b3|usr_a'])
    expect([...idb.store(CACHE_DB, CACHE_INDEX).keys()].sort()).toEqual(['b0|usr_a', 'b2|usr_a', 'b3|usr_a'])
  })

  it('a read never leaves an index entry behind a purge that follows it', async () => {
    expect(await store.write('b0', 'usr_a', content(els(2)))).toBe(true)
    expect(await store.read('b0', 'usr_a')).not.toBeNull()
    await store.purge('b0', 'usr_a')
    await new Promise((r) => setTimeout(r, 30))
    expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b0|usr_a')).toBe(false)
    expect(idb.store(CACHE_DB, CACHE_INDEX).has('b0|usr_a')).toBe(false)
  })

  it('keeps at most maxBytes in all; a board over the whole budget is not kept, nor its older copy', async () => {
    let t = 1000
    const one = JSON.stringify(cacheElementsOf(els(10)).elements).length
    // (a record is `one` give or take a few bytes: the versionNonce counter is shared by every test)
    const budget = one * 3 + 30
    store = createBoardCacheStore({ connection: conn(), now: () => t++, maxBytes: budget })
    for (let i = 0; i < 5; i++) expect(await store.write(`b${i}`, 'usr_a', content(els(10)))).toBe(true)
    expect([...idb.store(CACHE_DB, CACHE_BOARDS).keys()].sort()).toEqual(['b2|usr_a', 'b3|usr_a', 'b4|usr_a'])
    const total = [...idb.store(CACHE_DB, CACHE_INDEX).values()].reduce((n, e) => n + (e.bytes as number), 0)
    expect(total).toBeLessThanOrEqual(budget)
    expect([...idb.store(CACHE_DB, CACHE_INDEX).keys()].sort()).toEqual(['b2|usr_a', 'b3|usr_a', 'b4|usr_a'])
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
    ['a text that no longer hashes to the record (tampered or cut short)', { json: JSON.stringify(els(2)) }],
    ['a text that is not its elements (the count differs)', { count: 99 }],
    ['a broken record', { json: 42 }],
    ['the first form (elements as objects, no text)', { json: undefined, elements: els(3) }],
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
    // (another person's Sign out: usr_a's record is not theirs)
    expect(await store.purgeUser('usr_z')).toBe(0)
    idb.throwOnTransaction = false
    expect((await store.read('b1', 'usr_a'))?.elements).toHaveLength(2)
  })

  it("a Sign out whose delete fails still hides the person's copies (its mark is kept first: fail closed)", async () => {
    expect(await store.write('b1', 'usr_a', content(els(2)), { startedAt: Date.now() - 1000 })).toBe(true)
    idb.throwOnTransaction = true
    expect(await purgeBoardCachesOf('usr_a', conn(), undefined, Date.now() + 1)).toBe(0)
    idb.throwOnTransaction = false
    expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b1|usr_a')).toBe(true)
    expect(await store.read('b1', 'usr_a')).toBeNull()
    expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b1|usr_a')).toBe(false)
  })

  it('a record verifies without WebCrypto (an http origin that is not localhost, the NAS over the LAN)', async () => {
    expect(await store.write('b1', 'usr_a', content(els(3)))).toBe(true)
    vi.stubGlobal('crypto', {})
    expect(globalThis.crypto.subtle).toBeUndefined()
    expect((await store.read('b1', 'usr_a'))?.elements).toHaveLength(3)
    expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b1|usr_a')).toBe(true)
    // and through the route's early read
    const raw = idb.store(CACHE_DB, CACHE_BOARDS).get('b1|usr_a')
    expect((await store.verify(raw, 'b1', 'usr_a'))?.elements).toHaveLength(3)
  })

  it('an element the store cannot encode (a cycle) is no write, not a throw', async () => {
    const cyclic = stored(rect('r1', 'a0')) as Record<string, unknown>
    cyclic.self = cyclic
    expect(await store.write('b1', 'usr_a', content([cyclic as SceneElement]))).toBe(false)
  })
})

describe('a Sign out holds in every tab of this browser (the W6 review)', () => {
  /**
   * One browser's localStorage, seen by several tabs: a write is visible to every tab at once, and the other tabs
   * get its `storage` event (on a later task, as in a browser).
   */
  function browserStorage() {
    const data = new Map<string, string>()
    const listeners: { tab: number; fn: (k: string | null, v: string | null) => void }[] = []
    return {
      data,
      tab: (tab: number) => ({
        storage: () => ({
          getItem: (k: string) => data.get(k) ?? null,
          setItem: (k: string, v: string) => {
            data.set(k, v)
            for (const l of listeners) if (l.tab !== tab) setTimeout(() => l.fn(k, v), 0)
          },
        }),
        storageEvents: (fn: (k: string | null, v: string | null) => void) => {
          const l = { tab, fn }
          listeners.push(l)
          return () => listeners.splice(listeners.indexOf(l), 1)
        },
      }),
    }
  }

  const channels: BroadcastChannel[] = []
  /** a BroadcastChannel of its own name per test (Node's: delivered across instances, as across tabs) */
  const channelPair = (): [() => CacheChannelLike, () => CacheChannelLike] => {
    const name = `lobby-board-cache-test-${Math.random()}`
    const a = new BroadcastChannel(name)
    const b = new BroadcastChannel(name)
    channels.push(a, b)
    return [() => a as unknown as CacheChannelLike, () => b as unknown as CacheChannelLike]
  }
  afterEach(() => {
    for (const c of channels.splice(0)) c.close()
  })

  type How = 'the channel' | 'the storage event' | 'the stored mark only (nothing heard)'
  const tabsFor = (how: How): { a: SignOutMarks; b: SignOutMarks } => {
    const none = { channel: () => null, storageEvents: () => () => {} }
    if (how === 'the channel') {
      const [ca, cb] = channelPair()
      return {
        a: createSignOutMarks({ storage: () => null, channel: ca, storageEvents: () => () => {} }),
        b: createSignOutMarks({ storage: () => null, channel: cb, storageEvents: () => () => {} }),
      }
    }
    const shared = browserStorage()
    if (how === 'the storage event')
      return {
        a: createSignOutMarks({ ...shared.tab(1), channel: () => null }),
        b: createSignOutMarks({ ...shared.tab(2), channel: () => null }),
      }
    return {
      a: createSignOutMarks({ storage: shared.tab(1).storage, ...none }),
      b: createSignOutMarks({ storage: shared.tab(2).storage, ...none }),
    }
  }

  for (const how of ['the channel', 'the storage event', 'the stored mark only (nothing heard)'] as const)
    it(`tab A's Sign out: tab B's open session writes nothing back, and its old copy is never shown (${how})`, async () => {
      const T = Date.now()
      const tabs = tabsFor(how)
      // tab B: a board session started before the Sign out, with a copy written and more to write
      let clock = T - 900
      const storeB = createBoardCacheStore({ connection: conn(), marks: tabs.b, now: () => clock })
      const signedOut = vi.fn()
      const gateB = cacheWriteGate('usr_a', { marks: tabs.b, now: () => T - 1000, onSignedOut: signedOut })
      expect(gateB.open()).toBe(true)
      expect(await storeB.write('b1', 'usr_a', content(els(3)), { startedAt: gateB.startedAt })).toBe(true)
      expect(await storeB.write('b1', 'usr_b', content(els(2)), { startedAt: gateB.startedAt })).toBe(true)
      const before = structuredClone(idb.store(CACHE_DB, CACHE_BOARDS).get('b1|usr_a'))

      // tab A: alice's own Sign out
      expect(await purgeBoardCachesOf('usr_a', conn(), tabs.a, T - 500)).toBe(1)
      expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b1|usr_a')).toBe(false)
      if (how !== 'the stored mark only (nothing heard)')
        await vi.waitFor(() => expect(signedOut).toHaveBeenCalledTimes(1))

      // tab B's next idle, hidden-page or dispose-time write: refused by its gate, and by the store itself
      expect(gateB.open()).toBe(false)
      expect(signedOut).toHaveBeenCalledTimes(1)
      clock = T - 400
      expect(await storeB.write('b1', 'usr_a', content(els(4)), { startedAt: gateB.startedAt })).toBe(false)
      expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b1|usr_a')).toBe(false)
      expect(idb.store(CACHE_DB, CACHE_INDEX).has('b1|usr_a')).toBe(false)
      // a copy saved before the Sign out (an early read, a write that got in first): never shown, and dropped
      idb.store(CACHE_DB, CACHE_BOARDS).set('b1|usr_a', before as never)
      expect(await storeB.verify(before, 'b1', 'usr_a')).toBeNull()
      expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b1|usr_a')).toBe(false)
      // another account's copy in this browser is untouched
      expect((await storeB.read('b1', 'usr_b'))?.elements).toHaveLength(2)

      // alice signs in again: a session started after the Sign out keeps her copy as usual
      const later = cacheWriteGate('usr_a', { marks: tabs.b })
      expect(later.startedAt).toBeGreaterThan(T - 500)
      expect(later.open()).toBe(true)
      clock = Date.now()
      expect(await storeB.write('b1', 'usr_a', content(els(3)), { startedAt: later.startedAt })).toBe(true)
      expect((await storeB.read('b1', 'usr_a'))?.elements).toHaveLength(3)
      gateB.close()
      later.close()
    })

  it('a write already under way when the Sign out lands is refused once its database is open', async () => {
    const T = Date.now()
    const tabs = tabsFor('the stored mark only (nothing heard)')
    // tab B's connection not open yet: its write waits for the open, and the Sign out comes in between
    const storeB = createBoardCacheStore({ connection: conn(), marks: tabs.b, now: () => T - 900 })
    const pending = storeB.write('b1', 'usr_a', content(els(3)), { startedAt: T - 1000 })
    tabs.a.note('usr_a', T - 500)
    expect(await pending).toBe(false)
    await new Promise((r) => setTimeout(r, 30))
    expect(idb.store(CACHE_DB, CACHE_BOARDS).has('b1|usr_a')).toBe(false)
  })

  it("the mark is the time of the person's latest Sign out, per person, in localStorage", () => {
    const shared = browserStorage()
    const a = createSignOutMarks({ ...shared.tab(1), channel: () => null })
    const b = createSignOutMarks({ ...shared.tab(2), channel: () => null })
    expect(b.at('usr_a')).toBeNull()
    a.note('usr_a', 2000)
    a.note('usr_a', 1000)
    expect(shared.data.get(`${SIGNED_OUT_PREFIX}usr_a`)).toBe('2000')
    expect(b.at('usr_a')).toBe(2000)
    expect(b.at('usr_b')).toBeNull()
    // a broken value is no mark
    shared.data.set(`${SIGNED_OUT_PREFIX}usr_c`, 'nope')
    expect(b.at('usr_c')).toBeNull()
    // localStorage throwing (blocked site data): the page's own marks still hold
    const blocked = createSignOutMarks({
      storage: () => {
        throw new Error('SecurityError')
      },
      channel: () => null,
      storageEvents: () => () => {},
    })
    blocked.note('usr_a', 3000)
    expect(blocked.at('usr_a')).toBe(3000)
  })

  it("the board page's reads under way in another tab show nothing after the Sign out", async () => {
    const [ca, cb] = channelPair()
    const a = createSignOutMarks({ storage: () => null, channel: ca, storageEvents: () => () => {} })
    const b = createSignOutMarks({ storage: () => null, channel: cb, storageEvents: () => () => {} })
    setPageSignOutMarksForTests(b)
    const c = conn()
    const page = createBoardCacheStore({ connection: c })
    setBoardCacheForTests(page)
    setPageCacheConnectionForTests(c)
    expect(await page.write('b1', 'usr_a', content(els(2)), { startedAt: Date.now() - 1000 })).toBe(true)
    const read = takeBoardCache('b1', 'usr_a')
    expect(read?.value).toBeUndefined()
    // (the mark in the future: the record about to be read was saved before it)
    a.note('usr_a', Date.now() + 60_000)
    await vi.waitFor(() => expect(read?.cancelled).toBe(true))
    expect(await read?.done).toBeNull()
    expect(read?.value).toBeNull()
  })
})
