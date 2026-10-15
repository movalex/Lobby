// OWNER: WS3 (wave Q; bound to WS1 at the integration). How the Elements panel reaches the built-in icons: WS1's module
// `./icons/index.ts` (the index and shard loader, the client-side search and `iconElements()`;
// docs/WAVE-Q-CONTRACTS.md §3), seen through one small interface so the panel never depends on WS1's file layout.
//
// The binding: `import.meta.glob('./icons/index.ts')` finds WS1's module (a lazy chunk of its own: nothing of the icons
// is in the board's main chunk) and `adapt()` reads two of its exports:
//
//   loadIconCatalog(): Promise<IconCatalog>      the index, fetched once per page (same origin); IconLoadError
//     catalog.search(q, { set, category, limit })   ranked IconEntry[]; an empty query lists in index order
//     catalog.categories(set)                       Tabler's categories with their counts (Lucide has none)
//     catalog.geometry(key)                         the icon's shard, fetched once
//   iconElements(set, name, geometry, { size, color }): PlaceSource   native elements, already ONE group
//
// The panel keeps the index (contracts IconIndex) as its handle: the mark keys' set versions and an icon's presence
// are read from it. The unit tests adapt ./icons-double.ts (a test fixture with the same exports, served by WS1's own
// catalog code); no page ever loads it.
import {
  type IconGeometry,
  type IconIndex,
  type IconIndexEntry,
  type IconSetId,
  type IconSize,
  type InsertColorName,
  iconKey,
} from '@draftroom/contracts'
import type { IconCatalog, IconCategory, IconElementsOptions } from './icons/index.ts'
import type { PlaceSource } from './place.ts'

export interface IconSearchOptions {
  readonly set?: IconSetId | null
  readonly category?: string | null
  readonly limit?: number
}

export interface IconElementsInput {
  readonly set: IconSetId
  readonly name: string
  readonly geometry: IconGeometry
  readonly size: IconSize
  /** null: the set's default ink (Lobby's black) */
  readonly color: InsertColorName | null
}

/** What the panel needs of the icons. */
export interface IconsApi {
  /** 'ws1' (the real sets) or 'double' (the unit tests' fixture) */
  readonly origin: 'ws1' | 'double'
  loadIndex(): Promise<IconIndex>
  /** ranked; every match unless `limit` says otherwise */
  search(index: IconIndex, query: string, opts?: IconSearchOptions): readonly IconIndexEntry[]
  /** a set's categories (or every set's), by name with their counts; [] for a set without any */
  categories(index: IconIndex, set?: IconSetId | null): readonly IconCategory[]
  /** null for an icon the index does not hold; rejects when its shard cannot be read */
  loadGeometry(index: IconIndex, set: IconSetId, name: string): Promise<IconGeometry | null>
  /** the icon's elements: one group already, so place them with keepTogether: false */
  elements(input: IconElementsInput): PlaceSource
}

/** The parts of WS1's module the adapter reads. */
interface Ws1Module {
  loadIconCatalog?: unknown
  iconElements?: unknown
}

type LoadCatalog = () => Promise<IconCatalog>
type IconElementsFn = (set: IconSetId, name: string, g: IconGeometry, o: IconElementsOptions) => PlaceSource

const isNotFound = (e: unknown) =>
  e instanceof Error && e.name === 'IconLoadError' && (e as { code?: unknown }).code === 'not-found'

/** WS1's exports as an IconsApi, or null when one is missing. */
export function adapt(mod: Ws1Module, origin: IconsApi['origin'] = 'ws1'): IconsApi | null {
  if (typeof mod.loadIconCatalog !== 'function' || typeof mod.iconElements !== 'function') return null
  const loadCatalog = mod.loadIconCatalog as LoadCatalog
  const iconElements = mod.iconElements as IconElementsFn
  const catalogs = new WeakMap<IconIndex, IconCatalog>()
  const of = (index: IconIndex): IconCatalog => {
    const c = catalogs.get(index)
    if (!c) throw new Error('elements: an icon index this page did not load')
    return c
  }
  return {
    origin,
    async loadIndex() {
      const c = await loadCatalog()
      catalogs.set(c.index, c)
      return c.index
    },
    search: (index, query, opts = {}) =>
      of(index)
        .search(query, {
          set: opts.set ?? null,
          category: opts.category ?? null,
          limit: opts.limit ?? index.icons.length,
        })
        .map((e): IconIndexEntry => [e.set, e.name, [...e.tags], e.category, e.shard]),
    categories: (index, set) => of(index).categories(set ?? null),
    async loadGeometry(index, set, name) {
      try {
        return await of(index).geometry(iconKey(set, name))
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },
    elements: ({ set, name, geometry, size, color }) => iconElements(set, name, geometry, { size, color }),
  }
}

const ws1 = import.meta.glob<Ws1Module>('./icons/index.ts')

let loading: Promise<IconsApi | null> | null = null

/** The icons, loaded once per page; null when this build has none. Never rejects. */
export function loadIconsApi(): Promise<IconsApi | null> {
  loading ??= (async () => {
    try {
      const load = Object.values(ws1)[0]
      return load ? adapt(await load()) : null
    } catch (e) {
      console.warn('elements: the icons did not load', e)
      loading = null
      return null
    }
  })()
  return loading
}

/** Tests: install an IconsApi (null forgets it). */
export function setIconsApiForTests(api: IconsApi | null): void {
  loading = api ? Promise.resolve(api) : null
}
