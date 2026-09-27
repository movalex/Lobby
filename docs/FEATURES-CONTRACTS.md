# Board features: pure logic contracts (packages/board-ops, packages/templates)

These packages hold the **framework-free logic** behind the Miro-style features the web client and API add in milestones 2 and 4 (bulk notes, search, frame outline, presentation order, CSV export, native board export/import, templates). They take and return plain tldraw records (`TLRecord` from `@tldraw/tlschema` 5.4.2, validated by `draftroomSchema` from `@draftroom/canvas-schema`). No React, no editor instance, no DOM, no network — so everything is unit-testable in Node and reusable on the server (e.g. seeding a board from a template through sync's `/internal/boards/:bid/seed`).

Verify every tldraw API in `node_modules/@tldraw/{tlschema,utils}/**/*.d.ts` before using it (5.4.2 is newer than model training data). Key facts: `docs/research/SYNTHESIS.md`, `docs/research/sync-client.md` (rich text is TipTap JSON: `{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }`).

## Output record rules (both packages)

- Produced records must pass `draftroomSchema.types.<typeName>.validate(record)` — tests assert it for every output.
- Shapes need valid fractional `index` keys (use `@tldraw/utils` index helpers, e.g. `getIndices` / `getIndexAbove` — verify names), correct `parentId` (page id or frame/group id), `typeName: 'shape'`, full `props` for the shape type (take defaults from the tlschema default props definitions / validators; notes, text, geo, frame, arrow, image, group, and `dr-file-card`).
- Arrows connect through **binding records** (`typeName: 'binding'`, `type: 'arrow'`, `fromId` = arrow, `toId` = target shape, `props.terminal` `'start' | 'end'`, `normalizedAnchor`, `isExact`, `isPrecise` — verify the 5.4.2 arrow binding props).
- Never emit `instance`, `instance_page_state`, `camera`, `pointer`, `instance_presence` or `document` records; emit `page` records only when explicitly asked.
- No URLs with hosts, no base64 in records. Asset records keep stable `/files/<ast>/<ver>/original` refs.

## packages/board-ops

```ts
// Rich text
export function plainTextOf(richText: unknown): string                  // TipTap JSON -> plain text (paragraphs joined by \n); never throws
export function richTextFrom(text: string): TLRichText                  // plain text -> TipTap doc (one paragraph per line)

// Bulk notes (Miro: paste spreadsheet cells / lines into sticky notes)
export interface BulkNotesOptions { origin: { x: number; y: number }; pageId: TLPageId; parentId?: TLParentId; color?: string; maxNotes?: number /* default 500 */; gap?: number }
export function parseBulkText(text: string): string[][]                 // rows x cells; TSV (tab) and CSV (quoted, commas) and plain lines; trims, drops empty cells/rows
export function notesFromText(text: string, opts: BulkNotesOptions): { shapes: TLShape[]; truncated: boolean }  // grid: one row per input row, one note per cell; sizes per the note shape defaults

// Search
export interface SearchHit { shapeId: TLShapeId; type: string; text: string; snippet: string; score: number; pageId: TLPageId }
export function extractSearchableText(record: TLShape): string          // note/text/geo/arrow label richText, frame name, dr-file-card name, image alt text
export function searchBoard(records: Iterable<TLRecord>, query: string, opts?: { limit?: number }): SearchHit[]  // case/diacritic-insensitive, all terms must match, ranked (exact phrase > word start > substring), snippet with the match

// Frames (outline, navigation, presentation)
export interface FrameEntry { id: TLShapeId; name: string; pageId: TLPageId; parentFrameId: TLShapeId | null; depth: number; bounds: { x: number; y: number; w: number; h: number } }
export function frameOutline(records: Iterable<TLRecord>, pageId: TLPageId): FrameEntry[]   // reading order: rows (by top, with tolerance) then left-to-right; nested frames follow their parent; page-space bounds (account for parent transforms incl. rotation 0 case; document rotation limits)
export function presentationOrder(records: Iterable<TLRecord>, pageId: TLPageId): FrameEntry[]  // top-level frames; explicit meta.presentationIndex (number) first, then reading order

// CSV export
export function boardToCsv(records: Iterable<TLRecord>, opts?: { pageId?: TLPageId }): string   // header: id,type,text,frame,color,x,y ; RFC 4180 quoting; spreadsheet-formula neutralization (cells starting with = + - @ \t \r are prefixed with ')

// Duplication / import with fresh ids
export interface RemapResult { records: TLRecord[]; idMap: Map<string, string> }
export function remapIds(records: TLRecord[], opts: { targetPageId: TLPageId; offset?: { x: number; y: number }; keepAssets?: boolean }): RemapResult
//   new ids for every shape, binding (and asset unless keepAssets); rewrites parentId, binding fromId/toId, group/frame children,
//   shape props.assetId references, drops bindings whose endpoints are missing, re-parents orphans to targetPageId, fresh index keys preserving order

// Native board archive (portable export; assets referenced by manifest, bytes not included yet)
export interface BoardArchiveV1 { format: 'draftroom-board'; version: 1; exportedAt: string; schema: SerializedSchema; records: TLRecord[]; assets: ArchiveAssetRef[] }
export interface ArchiveAssetRef { assetId: string; versionId: string; name: string; mimeType: string; sizeBytes: number; sha256: string }
export function exportBoardArchive(records: Iterable<TLRecord>, schema: SerializedSchema, assets: ArchiveAssetRef[]): BoardArchiveV1  // document records only (no presence/instance/camera)
export function importBoardArchive(input: unknown, opts: { targetPageId: TLPageId }): { records: TLRecord[]; assets: ArchiveAssetRef[]; warnings: string[] }
//   treats input as UNTRUSTED: size/count caps (e.g. 20k records), strict shape of the envelope, migrates older schema versions with draftroomSchema
//   (StoreSchema migrate APIs — verify), validates every record, rejects unknown shape types, then remapIds with fresh ids; throws a typed ArchiveError
```

## packages/templates

Six editable templates for a creative team (build plan §4/§9), each a `TemplateDefinition`:

```ts
export interface TemplateDefinition {
  id: 'brainstorm' | 'mood-board' | 'storyboard' | 'pitch-outline' | 'retrospective' | 'production-plan'
  name: string
  description: string   // one sentence for the picker
  category: 'ideate' | 'visual' | 'plan' | 'review'
  build(ctx: { pageId: TLPageId; origin: { x: number; y: number } }): { records: TLRecord[] }  // fresh ids on every call
}
export const TEMPLATES: readonly TemplateDefinition[]
export function instantiateTemplate(id: TemplateDefinition['id'], ctx): { records: TLRecord[]; bounds: { x: number; y: number; w: number; h: number } }
```

Content guidance (original content — do not copy Miro or community templates): named frames as sections, a heading text in each, a few starter sticky notes with prompts in different colors, arrows bound between steps where flow matters (storyboard panels in sequence, production plan phases), placeholder geo boxes for image slots (mood board, storyboard). All objects are ordinary editable shapes. Frames must not overlap; the whole template should fit roughly within 3000×2000 at the origin.

Tests: every template's records validate; unique ids across two instantiations; every binding's endpoints exist; every `parentId` resolves; frame children lie inside their frame; `frameOutline` over the template returns the frames in the intended order.

## As built (review, 2026-09-26)

- board-ops: 161 tests, templates: 211 tests; adversarial review fixed 7 defects (id-prefix impostors in remapIds, CSV formula triggers after leading whitespace/fullwidth forms, unusable arrow bindings and `javascript:`/`data:`/`file:`/`blob:` embed URLs on import, limit overrides that disabled caps, an unbounded rich-text scan, lone surrogates at length caps). 25 targeted mutations were each caught by a test.
- `importBoardArchive` drops unusable arrow bindings and clears non-http(s) embed URLs (each with a warning), ignores non-finite/negative limit overrides, drops page/document/user records with a warning, and merges multi-page content onto `targetPageId`.
- `remapIds` (the generic duplicate/paste path) does **not** enforce arrow-binding or embed-URL policy — only import does. Any path that feeds untrusted JSON must go through `importBoardArchive` or `store.put` validation.
- Open product/security decision: imported bookmark/embed shapes with arbitrary http(s) hosts are kept (tldraw renders embeds sandboxed). Restricting to known embed providers is a candidate hardening.
- Two template instances on one page need `indexAbove` to avoid index collisions; the rotated-frame outline uses the axis-aligned box.
