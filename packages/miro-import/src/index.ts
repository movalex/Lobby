/**
 * Import from Miro (wave R, WS1; docs/WAVE-R-CONTRACTS.md §3): Miro REST API v2 items → Lobby elements, built through
 * `@draftroom/canvas-schema` (the engine's note, label and arrow helpers, the server's own element check) only, with
 * existing element types and `customData.lobby` keys. Used by apps/sync (the `miro-v2` seed's worker thread); the
 * api reads only `./sources` (no engine), the dialog only `./notes`.
 *
 * - `convertMiroBoard`: a whole board (items, connectors, groups, tags, the files the api stored) → elements, the
 *   board document's tag definitions and the report (`ImportBoardReport`);
 * - `./sources`: the seed body, the readers and slimming of Miro's answers, an item's file reference;
 * - `./notes`: the report's notes;
 * - `./fixtures`: a board of every item type, in Miro's documented answer shapes (tests and the e2e fake Miro).
 *
 * Text layout needs the server text metrics (`installServerTextMetrics`), as apps/sync installs them at start-up.
 * Nothing in this package logs; reports carry ids, counts and codes only.
 */
export {
  hexColor,
  MIRO_STICKY_COLORS,
  oklabDistance,
  STICKY_TABLE,
  SUBSTITUTE_DELTA,
  stickyColor,
  TAG_COLOR_TABLE,
  tagColor,
} from './colors.ts'
export { type ConvertedMiro, type ConvertMiroOptions, convertMiroBoard, num, POLYGONS } from './convert.ts'
export { fontOf } from './fonts.ts'
export { cleanText, htmlToText, type PlainText } from './html.ts'
export { MIRO_NOTES, type MiroNote } from './notes.ts'
export { buildReport } from './report.ts'
export * from './sources.ts'
