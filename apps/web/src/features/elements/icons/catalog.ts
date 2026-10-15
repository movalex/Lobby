// OWNER: WS1 (wave Q, the icons). The client side of the built-in icons: the index and the shards, fetched
// same-origin from ICON_ASSET_PREFIX (/lobby-assets/icons/, served by apps/web/build/lobby-assets.ts), validated with
// their contract schemas, and cached for the page's life.
//
//   const catalog = await loadIconCatalog()           // the index: once per page (a failure is retried next call)
//   catalog.search('arrow', { set: 'tabler' })         // ./search.ts, synchronous
//   const geometry = await catalog.geometry(entry.key) // its shard: fetched once, when first asked for
//
// The index file's hashed name comes from the build (`__LOBBY_ICON_INDEX__`, the plugin's define), never from a
// fixed name. A missing or unreadable file (a 404, the SPA's index.html, a schema mismatch) rejects with an
// IconLoadError, never with partial data. Nothing here touches the board.

import {
  ICON_ASSET_PREFIX,
  ICON_INDEX_FILE_PATTERN,
  ICON_SHARD_FILE_PATTERN,
  type IconGeometry,
  IconIndex,
  type IconSetId,
  type IconSetInfo,
  IconShard,
  iconKey,
} from '@draftroom/contracts'
import { createIconSearch, type IconCategory, type IconEntry, type IconSearchOptions } from './search.ts'

declare const __LOBBY_ICON_INDEX__: string | undefined

/** The index file name this build serves, or null outside a build of the web app (tests). */
export function builtIconIndexFile(): string | null {
  const name = typeof __LOBBY_ICON_INDEX__ === 'string' ? __LOBBY_ICON_INDEX__ : null
  return name && ICON_INDEX_FILE_PATTERN.test(name) ? name : null
}

export type IconLoadErrorCode = 'unavailable' | 'invalid' | 'not-found'

export class IconLoadError extends Error {
  readonly code: IconLoadErrorCode
  constructor(code: IconLoadErrorCode, message: string) {
    super(message)
    this.name = 'IconLoadError'
    this.code = code
  }
}

export interface IconCatalog {
  readonly sets: readonly IconSetInfo[]
  /** every icon, in index order (set, then name) */
  readonly entries: readonly IconEntry[]
  get(key: string): IconEntry | undefined
  search(query: string, opts?: IconSearchOptions): IconEntry[]
  categories(set?: IconSetId | null): IconCategory[]
  /** the pinned version of a set (the mark keys carry it: `icon:<set>:<name>@<version>`) */
  version(set: IconSetId): string | null
  /** an icon's geometry (fetches its shard the first time); rejects with IconLoadError */
  geometry(key: string): Promise<IconGeometry>
}

export interface LoadIconCatalogOptions {
  /** the fetch to use (tests); default the page's */
  readonly fetch?: typeof fetch
  /** the index file name (tests); default the build's */
  readonly indexFile?: string | null
}

async function fetchJson(doFetch: typeof fetch, file: string): Promise<unknown> {
  let res: Response
  try {
    res = await doFetch(`${ICON_ASSET_PREFIX}${file}`, { credentials: 'same-origin' })
  } catch {
    throw new IconLoadError('unavailable', 'icons: the request failed')
  }
  if (res.status === 404) throw new IconLoadError('not-found', `icons: ${file} is not served`)
  if (!res.ok) throw new IconLoadError('unavailable', `icons: ${file} answered ${res.status}`)
  try {
    return await res.json()
  } catch {
    // e.g. the SPA's index.html where a file should be
    throw new IconLoadError('invalid', `icons: ${file} is not JSON`)
  }
}

/** The catalog of an index already read (tests; and what loadIconCatalog builds). */
export function iconCatalogOf(index: IconIndex, doFetch: typeof fetch): IconCatalog {
  const entries: IconEntry[] = index.icons.map(([set, name, tags, category, shard]) => ({
    key: iconKey(set, name),
    set,
    name,
    tags,
    category,
    shard,
  }))
  const byKey = new Map(entries.map((e) => [e.key, e]))
  const search = createIconSearch(entries)
  const shards = new Map<number, Promise<Record<string, IconGeometry>>>()
  const loadShard = (n: number) => {
    let p = shards.get(n)
    if (!p) {
      const file = index.shards[n] as string
      p = (async () => {
        const parsed = IconShard.safeParse(await fetchJson(doFetch, file))
        if (!parsed.success || parsed.data.shard !== n)
          throw new IconLoadError('invalid', `icons: shard ${n} does not match its schema`)
        return parsed.data.icons
      })()
      // a failed shard is fetched again the next time it is asked for
      p.catch(() => shards.delete(n))
      shards.set(n, p)
    }
    return p
  }
  return {
    sets: index.sets,
    entries,
    get: (key) => byKey.get(key),
    search: (q, opts) => search.search(q, opts),
    categories: (set) => search.categories(set),
    version: (set) => index.sets.find((s) => s.id === set)?.version ?? null,
    async geometry(key) {
      const entry = byKey.get(key)
      if (!entry) throw new IconLoadError('not-found', 'icons: no such icon')
      const geometry = (await loadShard(entry.shard))[key]
      if (!geometry) throw new IconLoadError('invalid', `icons: shard ${entry.shard} lacks an indexed icon`)
      return geometry
    },
  }
}

let pageCatalog: Promise<IconCatalog> | null = null

/**
 * The icon catalog: the index fetched and validated once per page (the default options), or per call with options.
 * Rejects with IconLoadError; a failed load is tried again on the next call.
 */
export function loadIconCatalog(opts: LoadIconCatalogOptions = {}): Promise<IconCatalog> {
  const custom = opts.fetch !== undefined || opts.indexFile !== undefined
  if (!custom && pageCatalog) return pageCatalog
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
  const file = opts.indexFile === undefined ? builtIconIndexFile() : opts.indexFile
  const p = (async () => {
    if (!file || !ICON_INDEX_FILE_PATTERN.test(file))
      throw new IconLoadError('unavailable', 'icons: this build serves no icon index')
    const parsed = IconIndex.safeParse(await fetchJson(doFetch, file))
    if (!parsed.success) throw new IconLoadError('invalid', 'icons: the index does not match its schema')
    if (!parsed.data.shards.every((s) => ICON_SHARD_FILE_PATTERN.test(s)))
      throw new IconLoadError('invalid', 'icons: the index names a malformed shard')
    return iconCatalogOf(parsed.data, doFetch)
  })()
  if (!custom) {
    pageCatalog = p
    p.catch(() => {
      if (pageCatalog === p) pageCatalog = null
    })
  }
  return p
}
