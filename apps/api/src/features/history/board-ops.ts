// The one import point for the tldraw-era v1 board archive in the API (old .lobby.json files, imported
// still; exported for a v1 checkpoint body). Since wave 4 part 2 it is packages/tldraw-import's.
export {
  type ArchiveAssetRef,
  ArchiveError,
  type ArchiveErrorCode,
  type BoardArchiveV1,
  exportBoardArchive,
  importBoardArchive,
  type SerializedSchema,
} from '@draftroom/tldraw-import/archive-v1'
