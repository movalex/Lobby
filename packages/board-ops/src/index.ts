// Framework-free board logic (docs/FEATURES-CONTRACTS.md "packages/board-ops"): plain tldraw records in, plain records out.
export {
  ARCHIVE_FORMAT,
  ARCHIVE_LIMITS,
  ARCHIVE_VERSION,
  type ArchiveAssetRef,
  ArchiveError,
  type ArchiveErrorCode,
  type ArchiveLimits,
  type BoardArchiveV1,
  exportBoardArchive,
  type ImportBoardArchiveOptions,
  importBoardArchive,
  type SerializedSchema,
} from './archive.ts'
export {
  type BulkNotesOptions,
  DEFAULT_MAX_NOTES,
  DEFAULT_NOTE_GAP,
  MAX_BULK_NOTES,
  MAX_BULK_TEXT_CHARS,
  MAX_NOTE_TEXT_CHARS,
  NOTE_SIZE,
  notesFromText,
  parseBulkText,
} from './bulk-notes.ts'
export { boardToCsv, CSV_HEADER, csvTextCell } from './csv.ts'
export { type FrameEntry, type FrameOrderOptions, frameOutline, presentationOrder } from './frames.ts'
export { type RemapOptions, type RemapResult, remapIds } from './remap.ts'
export { plainTextOf, richTextFrom } from './rich-text.ts'
export { extractSearchableText, foldForSearch, type SearchHit, searchBoard } from './search.ts'
