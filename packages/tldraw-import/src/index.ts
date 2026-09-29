/**
 * The tldraw 5.4.2 → Excalidraw 0.18.0-1118751 converter (docs/EXCALIDRAW-MIGRATION.md §5, D13), used
 * by apps/sync (conversion, roll-forward) and apps/api (checkpoint and archive v1). It keeps only the
 * five MIT tldraw packages (`@tldraw/tlschema`, `utils`, `store`, `state`, `validate`) and nothing else
 * from tldraw, and builds elements through `@draftroom/canvas-schema` (the engine wrappers and the
 * server's own element check) only.
 *
 * - `convertBoard`: the whole-board conversion (fresh indices, page offsets computed once, then frozen);
 * - `convertRecords`: local mode (frozen offsets, no index; §5.1), used by the roll-forward and deleted rows;
 * - `migrateRecords`: stored records up to the current tldraw schema;
 * - `convertDeleted`: `dr_deleted_*` → `lb_deleted` rows;
 * - `semanticDiff`: the §5.3 verification (`./diff`);
 * - `./board-file`: reading a board file's tldraw tables with node:sqlite (Node only).
 *
 * Nothing in this package logs; reports carry ids, counts and codes only.
 */
export {
  type ConvertResult,
  computeLegacyPages,
  convertBoard,
  convertRecords,
  type DocValues,
  elementIdOf,
  hash31,
  indexSnapshot,
  isBindableShape,
  type LocalResult,
  lossyCounts,
  normalizeFixedPoint,
  type Snapshot,
} from './convert.ts'
export { convertDeleted, type DeletedConversion, type LbDeletedRow } from './deleted.ts'
export { currentSchema, type MigrateResult, migrateRecords } from './migrate.ts'
export { plainLines } from './rich-text.ts'
export * from './types.ts'

export const TLDRAW_IMPORT_SOURCE = 'tldraw-5.4.2' as const
