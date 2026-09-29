/**
 * `@draftroom/board-ops/elements`: board logic for the new canvas (docs/EXCALIDRAW-MIGRATION.md §4.9, wave
 * 2D): readers and writers over Excalidraw elements as Lobby stores them (canvas-schema `WireElement`), for
 * the servers and for ported web code. Plain elements in, plain elements out; no tldraw. It may load the
 * engine wrappers (`@draftroom/canvas-schema/engine`: fractional indices, the sticky-note layout), so the
 * default (tldraw) web build never imports it. v1 archives are read by `@draftroom/board-ops/elements/v1`.
 *
 * The engine-neutral helpers the tldraw readers share are re-exported here, so ported code needs only this
 * import path.
 */
export {
  ARCHIVE_LIMITS,
  type ArchiveAssetRef,
  ArchiveError,
  type ArchiveErrorCode,
  type ArchiveLimits,
} from '../archive-common.ts'
export {
  DEFAULT_MAX_NOTES,
  DEFAULT_NOTE_GAP,
  MAX_BULK_NOTES,
  MAX_BULK_TEXT_CHARS,
  MAX_NOTE_TEXT_CHARS,
  NOTE_SIZE,
  parseBulkText,
} from '../bulk-parse.ts'
export { type Box, readingOrder, truncateText } from '../common.ts'
export { CSV_HEADER, csvTextCell } from '../csv-cell.ts'
export { foldForSearch } from '../text-match.ts'
export {
  ARCHIVE_ENGINE,
  ARCHIVE_ENGINE_VERSION,
  ARCHIVE_V2_FORMAT,
  ARCHIVE_V2_VERSION,
  type BoardArchiveV2,
  ELEMENT_ARCHIVE_LIMITS,
  exportElementArchive,
  type ImportElementArchiveOptions,
  type ImportedElementArchive,
  importElementArchive,
  portableDoc,
  portableElement,
} from './archive.ts'
export {
  type ElementNotesOptions,
  noteElementsFromText,
  PASTED_NOTE_FONT_FAMILY,
  PASTED_NOTE_FONT_SIZE,
} from './bulk-notes.ts'
export { colorCellOf, elementsToCsv } from './csv.ts'
export {
  type ElementFrameEntry,
  type ElementFrameOrderOptions,
  frameOutlineOf,
  presentationOrderOf,
} from './frames.ts'
export { type IdSource, newElementId, randomInt31 } from './ids.ts'
export {
  isLobbyColorName,
  LOBBY_COLOR_NAMES,
  LOBBY_FRAME_STROKE,
  LOBBY_GREY_INK,
  LOBBY_INK,
  LOBBY_PALETTE,
  LOBBY_SEMI_FILL,
  type LobbyColorName,
  type LobbyColorSet,
  lobbyColor,
  noteColorName,
  strokeColorName,
} from './palette.ts'
export {
  asElements,
  type BoardElement,
  compareByIndex,
  type ElementLookup,
  elementBounds,
  elementText,
  isLabel,
  isLive,
  kindOf,
  labelOf,
  lobbyValue,
  lookupOf,
  wordsOf,
} from './read.ts'
export { type RemapElementsOptions, type RemapElementsResult, remapElements } from './remap.ts'
export { type ElementSearchHit, searchableElementText, searchElements } from './search.ts'
