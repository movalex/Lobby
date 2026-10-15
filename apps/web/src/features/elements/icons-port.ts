// OWNER: WS3 (wave Q). How the Elements panel reaches the built-in icons: WS1's module `./icons/index.ts` (the index
// and shard loader, the client-side search and `iconElements()`; docs/WAVE-Q-CONTRACTS.md §3), seen through one small
// interface so the panel never depends on WS1's file layout.
//
// The binding: `import.meta.glob('./icons/index.ts')` finds WS1's module when it is in the tree (a lazy chunk of its
// own: nothing of the icons is in the board's main chunk) and adapts these exports by name:
//
//   loadIconIndex(): Promise<IconIndex>                                         the index, fetched once (same origin)
//   searchIcons(index, query, { set?, category?, limit? }): IconIndexEntry[]    ranked; an empty query lists in order
//   loadIconGeometry(index, set, name): Promise<IconGeometry | null>            the icon's shard, fetched once
//   iconElements({ set, name, geometry, size, color }): PlaceSource             native elements at that size and colour
//
// If WS1 names them otherwise, the lead adapts `adapt()` below at the integration (this file only). Without WS1's
// module the icons are unavailable (the Icons tab says so), except on a dev-auth page that turned the panel on: there a
// small test double stands in (./icons-double.ts), so the panel's own specs run before WS1 lands.
import type {
  IconGeometry,
  IconIndex,
  IconIndexEntry,
  IconSetId,
  IconSize,
  InsertColorName,
} from '@draftroom/contracts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import { elementsPanelOverride } from './flags.ts'
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
  /** 'ws1' (the real sets) or 'double' (the dev-auth test double) */
  readonly origin: 'ws1' | 'double'
  loadIndex(): Promise<IconIndex>
  search(index: IconIndex, query: string, opts?: IconSearchOptions): readonly IconIndexEntry[]
  loadGeometry(index: IconIndex, set: IconSetId, name: string): Promise<IconGeometry | null>
  elements(input: IconElementsInput): PlaceSource
}

type Ws1Module = Record<string, unknown>

/** WS1's exports as an IconsApi, or null when one is missing. */
export function adapt(mod: Ws1Module, origin: IconsApi['origin'] = 'ws1'): IconsApi | null {
  const { loadIconIndex, searchIcons, loadIconGeometry, iconElements } = mod
  if (
    typeof loadIconIndex !== 'function' ||
    typeof searchIcons !== 'function' ||
    typeof loadIconGeometry !== 'function' ||
    typeof iconElements !== 'function'
  )
    return null
  return {
    origin,
    loadIndex: () => loadIconIndex() as Promise<IconIndex>,
    search: (index, query, opts) => searchIcons(index, query, opts ?? {}) as IconIndexEntry[],
    loadGeometry: (index, set, name) => loadIconGeometry(index, set, name) as Promise<IconGeometry | null>,
    elements: (input) => iconElements(input) as PlaceSource,
  }
}

const ws1 = import.meta.glob<Ws1Module>('./icons/index.ts')

let loading: Promise<IconsApi | null> | null = null

/** The icons, loaded once per page; null when this build has none. Never rejects. */
export function loadIconsApi(): Promise<IconsApi | null> {
  loading ??= (async () => {
    try {
      const load = Object.values(ws1)[0]
      if (load) return adapt(await load())
      if (DEV_AUTH_ENABLED && elementsPanelOverride() === true)
        return adapt(await import('./icons-double.ts'), 'double')
      return null
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
