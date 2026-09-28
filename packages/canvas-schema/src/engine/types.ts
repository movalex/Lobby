/**
 * Lobby's own structural types for the Excalidraw elements the server touches.
 *
 * Why these exist (plan §2.3.1): `@excalidraw/element`'s `.d.ts` files import types from
 * `@excalidraw/excalidraw`, which the server does not install, so under `skipLibCheck` many of its
 * types resolve to `any`. The wrappers in this folder therefore declare what they accept and return,
 * and only this folder imports `@excalidraw/*` on the server side.
 *
 * Field names were checked against `@excalidraw/element@0.18.0-1118751` `dist/types/element/src/types.d.ts`.
 */

/** Excalidraw font family ids Lobby uses: 5 Excalifont, 6 Nunito, 8 Comic Shanns. */
export type LobbyFontFamily = 5 | 6 | 8

export interface BoundElementRef {
  readonly id: string
  readonly type: 'arrow' | 'text'
}

/** Fields every Excalidraw element has in this engine version. */
export interface EngineElementBase {
  readonly id: string
  readonly type: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly angle: number
  readonly strokeColor: string
  readonly backgroundColor: string
  readonly fillStyle: string
  readonly strokeWidth: number
  readonly strokeStyle: string
  readonly roundness: null | { readonly type: number; readonly value?: number }
  readonly roughness: number
  readonly opacity: number
  readonly seed: number
  readonly version: number
  readonly versionNonce: number
  readonly index: string | null
  readonly isDeleted: boolean
  readonly groupIds: readonly string[]
  readonly frameId: string | null
  readonly boundElements: readonly BoundElementRef[] | null
  readonly updated: number
  readonly created: number | null
  readonly link: string | null
  readonly locked: boolean
  readonly customData?: Record<string, unknown>
}

export interface StickyNoteElement extends EngineElementBase {
  readonly type: 'stickynote'
  readonly baseHeight: number
}

export interface TextElement extends EngineElementBase {
  readonly type: 'text'
  readonly text: string
  readonly originalText: string
  readonly fontSize: number
  readonly baseFontSize: number | null
  readonly fontFamily: number
  readonly textAlign: 'left' | 'center' | 'right'
  readonly verticalAlign: 'top' | 'middle' | 'bottom'
  readonly containerId: string | null
  readonly autoResize: boolean
  readonly lineHeight: number
  readonly labelPosition: unknown
}

/** Any element, typed loosely: the server validates the full shape with zod elsewhere. */
export type EngineElement = EngineElementBase & Record<string, unknown>

/** Output of `getStickyNoteLayout` (element `dist/types/element/src/stickyNote.d.ts`). */
export interface StickyNoteLayout {
  container: Pick<StickyNoteElement, 'x' | 'y' | 'width' | 'height' | 'baseHeight'>
  text: Pick<
    TextElement,
    'text' | 'fontSize' | 'baseFontSize' | 'width' | 'height' | 'x' | 'y' | 'angle'
  > | null
}

export interface StickyNoteLayoutOpts {
  originalText?: string
  baseHeight?: number
  baseFontSize?: number
  anchor?: 'top' | 'bottom' | 'center'
}

/** `TextMetricsProvider` from element `textMeasurements.d.ts`. */
export interface TextMetricsProvider {
  getLineWidth(text: string, fontString: string): number
}
