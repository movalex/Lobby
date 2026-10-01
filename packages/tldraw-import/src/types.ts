/**
 * The converter's public types (docs/EXCALIDRAW-MIGRATION.md §5.1-§5.3, §3.4 `import`).
 */
import type { ServerTextMetrics } from '@draftroom/canvas-schema/engine'

/** The converter's version, recorded in `lb_meta.converted_from.converterVersion` and `lb_doc.import`. */
export const CONVERTER_VERSION = '2'
/** What the converter reads (`lb_doc.import.from`). */
export const CONVERTED_FROM = 'tldraw-5.4.2' as const

/**
 * Lossy codes (§5.2), reported per board by code and tldraw record id, never with content. The first
 * group is the plan's; the rest were added by the port (spike B8) and are listed in the B8 evidence.
 */
export const LOSSY_CODES = [
  'rich-text-formatting',
  'serif-font',
  'geo-polygon',
  'geo-approximated',
  'nested-frame',
  'page-flattened',
  'arrow-binding-dropped',
  'arrowhead-approximated',
  'arrow-label-position',
  'stroke-simplified',
  'over-limit',
  'image-circle-crop',
  'frame-rotation',
  'missing-asset',
  'unknown-shape',
  'orphan',
  // added by the port
  'group-with-frame',
  'link-dropped',
  'embed-as-link',
  'bookmark-as-link',
  'meta-dropped',
  'ai-marker',
  'private-frame-marker',
  'empty-group',
] as const
export type LossyCode = (typeof LOSSY_CODES)[number]

export interface Lossy {
  readonly code: LossyCode
  /** the tldraw record id it is about (a shape, page or document id) */
  readonly id: string
}

/** One flattened page's frozen offset (`lb_doc.import.legacyPages[pageId]`, doc.ts ImportDocValue). */
export interface LegacyPage {
  readonly dx: number
  readonly dy: number
  /** the page's position in the tldraw page order (0 = the first page) */
  readonly index: number
  readonly name: string
}
export type LegacyPages = Readonly<Record<string, LegacyPage>>

/** A tldraw record as stored (`documents.state`), after migration to the current schema. */
export type TlRecord = Readonly<Record<string, unknown>> & { readonly id: string; readonly typeName: string }

export interface ConvertOptions {
  /** stamped as `updated` (and `lobbyServer` times) on every element: the output is deterministic */
  readonly updatedAt: number
  /** the server text metrics (canvas-schema/engine `createTableTextMetrics`); installed into the engine */
  readonly metrics: ServerTextMetrics
  /**
   * The board's frozen page offsets (`lb_doc.import.legacyPages`). Required in local mode; in whole-board
   * mode they are computed from page-1 bounds when absent (the first conversion) and reused otherwise.
   */
  readonly legacyPages?: LegacyPages
  /** gap between flattened pages (first conversion only), default 800 */
  readonly pageGap?: number
}

/** A file the board references (the asset set of the semantic diff). */
export interface FileRef {
  readonly fileId: string
  readonly versionId: string
  readonly assetId: string
}

/** Why an element could not be written (the server would refuse it): the board fails conversion. */
export interface ConvertFailure {
  readonly id: string
  readonly code: 'INVALID' | 'TOO_LARGE' | 'OVER_CAP' | 'PAGE_MISSING'
  /** schema paths only, never values */
  readonly detail: string
}
