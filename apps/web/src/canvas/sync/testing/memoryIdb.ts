/**
 * A small in-memory IndexedDB for the board cache's tests (wave M, M6-1): databases by name, object stores with an
 * in-line `key` key path, `get`, `getAll`, `getAllKeys`, `put` and `delete`, requests answered on a later task,
 * read-write transactions that complete (and become visible) only once all their requests have answered and are
 * run one at a time in the order they were made (as overlapping transactions on one store are in a browser), and
 * `commit()`. Failure switches: `failOpen` (the open errors), `throwOnOpen` (the factory throws), `abortWrites`
 * (every read-write transaction aborts: a quota error), `throwOnTransaction`.
 *
 * Not a full IndexedDB: enough for adapter/snapshot-cache.ts and adapter/board-cache-db.ts. (The repo has no
 * fake-indexeddb dependency, and wave M adds none.)
 */

type Rec = Record<string, unknown> & { key: string }

export interface MemoryIdb {
  readonly factory: IDBFactory
  /** every database's stores, by database then store name (live: tests read and seed them) */
  readonly dbs: Map<string, Map<string, Map<string, Rec>>>
  store(db: string, store: string): Map<string, Rec>
  failOpen: boolean
  throwOnOpen: boolean
  abortWrites: boolean
  throwOnTransaction: boolean
  readonly opens: number
}

export function createMemoryIdb(): MemoryIdb {
  const dbs = new Map<string, Map<string, Map<string, Rec>>>()
  const queue: (() => void)[] = []
  let running = false
  let opens = 0
  const runNext = () => {
    const next = queue.shift()
    if (!next) {
      running = false
      return
    }
    running = true
    next()
  }
  const later = (fn: () => void) => setTimeout(fn, 0)

  const self: MemoryIdb = {
    factory: null as unknown as IDBFactory,
    dbs,
    store(db, store) {
      let d = dbs.get(db)
      if (!d) {
        d = new Map()
        dbs.set(db, d)
      }
      let s = d.get(store)
      if (!s) {
        s = new Map()
        d.set(store, s)
      }
      return s
    },
    failOpen: false,
    throwOnOpen: false,
    abortWrites: false,
    throwOnTransaction: false,
    get opens() {
      return opens
    },
  }

  const database = (name: string) => {
    const stores = () => {
      let d = dbs.get(name)
      if (!d) {
        d = new Map()
        dbs.set(name, d)
      }
      return d
    }
    const db = {
      name,
      onversionchange: null as (() => void) | null,
      objectStoreNames: { contains: (s: string) => stores().has(s) },
      createObjectStore: (s: string) => {
        stores().set(s, new Map())
        return {}
      },
      close: () => {},
      transaction: (names: string | string[], mode: IDBTransactionMode = 'readonly') => {
        if (self.throwOnTransaction) throw new Error('InvalidStateError: transaction')
        const list = typeof names === 'string' ? [names] : names
        for (const n of list) if (!stores().has(n)) throw new Error(`NotFoundError: no store ${n}`)
        let pending = 0
        let started = false
        let done = false
        const ops: (() => void)[] = []
        // a read-write transaction works on a copy, made visible when it completes (none on an abort)
        const staged = new Map<string, Map<string, Rec>>()
        const view = (n: string): Map<string, Rec> => {
          if (mode === 'readonly') return stores().get(n) as Map<string, Rec>
          let s = staged.get(n)
          if (!s) {
            s = new Map(stores().get(n) as Map<string, Rec>)
            staged.set(n, s)
          }
          return s
        }
        const t = {
          mode,
          error: null as unknown,
          oncomplete: null as (() => void) | null,
          onabort: null as (() => void) | null,
          onerror: null as (() => void) | null,
          commit: () => {},
          abort: () => {
            if (done) return
            done = true
            t.error = new Error('AbortError')
            later(() => {
              t.onabort?.()
              runNext()
            })
          },
          objectStore: (n: string) => store(n),
        }
        const finish = () => {
          if (pending > 0 || done) return
          later(() => {
            if (pending > 0 || done) return
            done = true
            if (mode === 'readwrite' && self.abortWrites) {
              t.error = new Error('QuotaExceededError')
              t.onabort?.()
              runNext()
              return
            }
            for (const [n, s] of staged) stores().set(n, s)
            t.oncomplete?.()
            runNext()
          })
        }
        const req = <T>(fn: () => T) => {
          const r = {
            result: undefined as T | undefined,
            error: null as unknown,
            onsuccess: null as (() => void) | null,
            onerror: null as (() => void) | null,
          }
          pending++
          const op = () =>
            later(() => {
              if (done) return
              r.result = fn()
              r.onsuccess?.()
              pending--
              finish()
            })
          if (started) op()
          else ops.push(op)
          return r
        }
        const store = (n: string) => ({
          get: (k: string) => req(() => structuredClone(view(n).get(k))),
          getAll: () => req(() => [...view(n).values()].map((r) => structuredClone(r))),
          getAllKeys: () => req(() => [...view(n).keys()]),
          put: (v: Rec) => {
            if (mode !== 'readwrite') throw new Error('ReadOnlyError')
            return req(() => {
              view(n).set(v.key, structuredClone(v))
              return v.key
            })
          },
          delete: (k: string) => {
            if (mode !== 'readwrite') throw new Error('ReadOnlyError')
            return req(() => void view(n).delete(k))
          },
        })
        queue.push(() => {
          started = true
          for (const op of ops.splice(0)) op()
          finish()
        })
        // the runner is claimed now: two transactions made in one task while it was idle ran side by side before
        // (each scheduled its own runNext), so a read-write one could commit a copy of a store staged before the
        // other committed (wave N.1: a read's LRU touch then undid a write made right after it)
        if (!running) {
          running = true
          later(runNext)
        }
        return t
      },
    }
    return db
  }

  const factory = {
    open: (name: string) => {
      if (self.throwOnOpen) throw new Error('SecurityError: no IndexedDB here')
      opens++
      const existed = dbs.has(name)
      const r = {
        result: null as unknown,
        error: null as unknown,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      }
      later(() => {
        if (self.failOpen) {
          r.error = new Error('UnknownError: open failed')
          r.onerror?.()
          return
        }
        r.result = database(name)
        if (!existed) r.onupgradeneeded?.()
        r.onsuccess?.()
      })
      return r
    },
  }
  ;(self as { factory: IDBFactory }).factory = factory as unknown as IDBFactory
  return self
}
