/**
 * The single import of `@excalidraw/element` on the server side, re-typed with Lobby's own types.
 *
 * Every signature below was checked against `@excalidraw/element@0.18.0-1118751`
 * `dist/types/element/src/*.d.ts` (and the implementation in `dist/dev/index.js`; line numbers in
 * comments refer to that file). Keep this list short: a wrapper exists only when the server needs it.
 */
import * as common from '@excalidraw/common'
import * as element from '@excalidraw/element'
import type {
  EngineElement,
  StickyNoteElement,
  StickyNoteLayout,
  StickyNoteLayoutOpts,
  TextElement,
  TextMetricsProvider,
} from './types.ts'

/** Constructor options accepted by `newElement` and friends (`newElement.d.ts`, `ElementConstructorOpts`). */
export interface ConstructorOpts {
  x: number
  y: number
  id?: string
  width?: number
  height?: number
  angle?: number
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: string
  strokeWidth?: number
  strokeStyle?: string
  roughness?: number
  opacity?: number
  groupIds?: readonly string[]
  frameId?: string | null
  index?: string | null
  roundness?: null | { type: number; value?: number }
  seed?: number
  version?: number
  versionNonce?: number
  link?: string | null
  locked?: boolean
  customData?: Record<string, unknown>
  /** `created` is accepted by the constructor (index.js:16371) though `mutateElement` refuses it. */
  created?: number | null
  boundElements?: readonly { id: string; type: 'arrow' | 'text' }[] | null
}

export interface TextOpts extends ConstructorOpts {
  text: string
  originalText?: string
  fontSize?: number
  fontFamily?: number
  textAlign?: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  containerId?: string | null
  lineHeight?: number
  autoResize?: boolean
  baseFontSize?: number | null
}

interface RawElementApi {
  setCustomTextMetricsProvider(provider: TextMetricsProvider): void
  newElement(opts: ConstructorOpts & { type: string }): EngineElement
  newStickyNoteElement(opts: ConstructorOpts & { type: 'stickynote'; baseHeight?: number }): StickyNoteElement
  newTextElement(opts: TextOpts): TextElement
  getStickyNoteLayout(
    container: StickyNoteElement,
    text: TextElement | null,
    opts?: StickyNoteLayoutOpts,
  ): StickyNoteLayout
  getStickyNoteFooter(
    el: Pick<StickyNoteElement, 'created' | 'width' | 'height'>,
    now?: number,
  ): { text: string; x: number; y: number } | null
  wrapText(text: string, font: string, maxWidth: number): string
  measureText(text: string, font: string, lineHeight: number): { width: number; height: number }
  isBindableElement(el: EngineElement | null | undefined, includeLocked?: boolean): boolean
  isTextBindableContainer(el: EngineElement | null | undefined, includeLocked?: boolean): boolean
  syncInvalidIndices<T extends EngineElement>(elements: readonly T[]): T[]
  validateFractionalIndices(
    elements: readonly EngineElement[],
    opts: { shouldThrow: boolean; includeBoundTextValidation: boolean; ignoreLogs?: true },
  ): void
  orderByFractionalIndex<T extends EngineElement>(elements: T[]): T[]
  duplicateElement<T extends EngineElement>(
    editingGroupId: string | null,
    groupIdMapForOperation: Map<string, string>,
    el: T,
    randomizeSeed?: boolean,
  ): T
  Scene: new (
    elements?: readonly EngineElement[] | null,
  ) => {
    replaceAllElements(elements: readonly EngineElement[], opts?: { skipValidation?: boolean }): void
    getElementsIncludingDeleted(): readonly EngineElement[]
  }
}

export const raw = element as unknown as RawElementApi

interface RawCommonApi {
  /** `${size}px ${family}, <fallbacks>` exactly as Excalidraw builds it (common `index.js:2618-2633`) */
  getFontString(opts: { fontSize: number; fontFamily: number }): string
  FONT_FAMILY: Record<string, number>
  STICKY_NOTE_MIN_FONT_SIZE: number
  STICKY_NOTE_PADDING: number
  STICKY_NOTE_BODY_INSET_Y: number
  STICKY_NOTE_MIN_SIZE: number
}

export const rawCommon = common as unknown as RawCommonApi
