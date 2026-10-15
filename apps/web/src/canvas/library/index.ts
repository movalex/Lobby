// OWNER: WS4 (wave Q, kits and import). The `.excalidrawlib` normaliser's public surface (docs/WAVE-Q-CONTRACTS.md §6).
export {
  type LibraryEngine,
  type LibraryImportReport,
  type LibraryRefusal,
  loadLibraryEngine,
  type NormaliseLibraryOptions,
  type NormaliseLibraryResult,
  normaliseExcalidrawLib,
} from './excalidrawlib.ts'
export {
  cleanLibraryElements,
  FALLBACK_FONT,
  FONT_MAP,
  IMPORT_ITEM_LIMITS,
  type ItemCuts,
  type ItemResult,
  normaliseLibraryItem,
} from './normalise.ts'
