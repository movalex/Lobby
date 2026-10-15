// OWNER: WS1 (wave Q, the icons). The built-in icons' API for the Elements panel (WS3). Import it lazily
// (`await import('./icons/index.ts')`): nothing of it belongs in the board's entry chunk (the bundle test checks).
//
//   const catalog = await loadIconCatalog()                  index: once per page; rejects with IconLoadError
//   catalog.search(query, { set, category, limit })          ranked IconEntry[] (name, tags, category)
//   catalog.categories(set?)                                 [{ name, count }] (Tabler's; Lucide has none)
//   catalog.version(set)                                     for the mark key icon:<set>:<name>@<version>
//   const geometry = await catalog.geometry(entry.key)       its shard, fetched once
//   placeElements(canvas, iconElements(entry.set, entry.name, geometry, { size, color }),
//                 { at, lock, keepTogether: false })
//
// iconElements already puts the icon's elements in one group: placeElements' keepTogether would wrap a second,
// outer group around it, so pass keepTogether: false for an icon on its own.

export {
  builtIconIndexFile,
  type IconCatalog,
  IconLoadError,
  type IconLoadErrorCode,
  iconCatalogOf,
  type LoadIconCatalogOptions,
  loadIconCatalog,
} from './catalog.ts'
export { type IconElementsOptions, iconElements, iconInsertLabel } from './elements.ts'
export {
  createIconSearch,
  DEFAULT_ICON_SEARCH_LIMIT,
  type IconCategory,
  type IconEntry,
  type IconSearch,
  type IconSearchOptions,
  normalizeQuery,
} from './search.ts'
