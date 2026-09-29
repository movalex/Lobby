/**
 * The tldraw 5.4.2 → Excalidraw 0.18.0-1118751 converter (docs/EXCALIDRAW-MIGRATION.md §5, D13), used
 * by apps/sync (conversion, roll-forward) and apps/api (checkpoint and archive v1). It keeps only the
 * five MIT tldraw packages (`@tldraw/tlschema`, `utils`, `store`, `state`, `validate`) and nothing else
 * from tldraw.
 *
 * Created empty by the lead at the spike B contracts step C0; everything in this package except
 * `package.json` belongs to O4 (docs/research/excalidraw/spike-b/CONTRACTS.md). A dependency change is a
 * change request to the lead (the lockfile is the lead's).
 */
export const TLDRAW_IMPORT_SOURCE = 'tldraw-5.4.2' as const
