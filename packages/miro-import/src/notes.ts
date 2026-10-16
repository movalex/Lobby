/**
 * The machine notes a Miro import's report carries (`ImportBoardReport.notes`, `ImportReportRow.note`; contracts
 * imports.ts ImportNote: lower-case words, never content). The dialog labels them (apps/web dashboard/import-miro);
 * a note it does not know is shown as its code. Pure.
 */
export const MIRO_NOTES = [
  'color-substituted',
  'font-substituted',
  'text-formatting-lost',
  'text-truncated',
  'shape-approximated',
  'shape-polygon',
  'frame-nested',
  'frame-fill-dropped',
  'connector-curved',
  'connector-unsupported',
  'connector-end-unbound',
  'connector-caption-extra',
  'connector-cap-approximated',
  'file-not-imported-yet',
  'file-host-refused',
  'file-failed',
  'file-too-large',
  'card-as-shape',
  'app-card-as-shape',
  'embed-as-link',
  'table-not-imported',
  'doc-not-imported',
  'preview-not-imported',
  'unknown-type',
  'no-geometry',
  'group-dropped',
  'tag-dropped',
  'tag-color-substituted',
  'link-dropped',
  'position-clamped',
  'element-invalid',
  'over-limit',
] as const
export type MiroNote = (typeof MIRO_NOTES)[number]
