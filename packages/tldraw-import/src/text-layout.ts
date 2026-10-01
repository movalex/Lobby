/**
 * Text layout for converted labels and free text, the way Excalidraw lays them out, so the converter's
 * output is a fixed point of `restoreElements(…, { repairBindings, refreshDimensions })` in a browser
 * (§8.3 B8) and matches what the sync process's own layout gives (spike A3: 0/208 line-break differences
 * with the kerning table).
 *
 * Wrapping is Excalidraw's own `wrapText` through `@draftroom/canvas-schema/engine` (`wrapLabelText`), and
 * widths come from the installed server text-metrics provider; the formulas below are ports of the
 * engine's (dist/dev/index.js line numbers of `@excalidraw/element@0.18.0-1118751`):
 * - `measureText` (5683-5689): empty lines are measured as " ", tabs as 8 spaces, height = lines × size × lineHeight;
 * - `getBoundTextMaxWidth` / `getBoundTextMaxHeight` (6583-6619);
 * - `computeBoundTextPosition` / `getContainerCoords` (6407-6526);
 * - `getLineHeight` (common 2194): 1.25 for Excalifont (5), Nunito (6) and Comic Shanns (8).
 * Sticky notes use the engine's own `getStickyNoteLayout` (`layoutStickyNote`).
 */
import {
  fontString,
  installedServerTextMetrics,
  installServerTextMetrics,
  type LobbyFontFamily,
  type ServerTextMetrics,
  wrapLabelText,
} from '@draftroom/canvas-schema/engine'

/** Excalidraw's BOUND_TEXT_PADDING (common index.js:1942). */
export const BOUND_TEXT_PADDING = 5
/** ARROW_LABEL_WIDTH_FRACTION and ARROW_LABEL_FONT_SIZE_TO_MIN_WIDTH_RATIO (common 1943-1944). */
export const ARROW_LABEL_WIDTH_FRACTION = 0.7
export const ARROW_LABEL_MIN_WIDTH_RATIO = 11

/** `getLineHeight(fontFamily)`: FONT_METADATA's line height (1.25 for every family Lobby serves). */
export const lineHeightOf = (family: LobbyFontFamily): number =>
  family === 5 || family === 6 || family === 8 ? 1.25 : 1.25

/** Makes sure the engine measures with `metrics` (process-wide; the engine caches per font string). */
export function useMetrics(metrics: ServerTextMetrics): void {
  if (installedServerTextMetrics() !== metrics) installServerTextMetrics(metrics)
}

const normalizeText = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\t/g, '        ')

/** Excalidraw `measureText(text, font, lineHeight)`. */
export function measureText(
  metrics: ServerTextMetrics,
  text: string,
  family: LobbyFontFamily,
  sizePx: number,
  lineHeight: number,
): { width: number; height: number } {
  const lines = normalizeText(
    text
      .split('\n')
      .map((x) => x || ' ')
      .join('\n'),
  ).split('\n')
  const font = fontString(family, sizePx)
  let width = 0
  for (const line of lines) width = Math.max(width, metrics.getLineWidth(line, font))
  return { width, height: sizePx * lineHeight * lines.length }
}

/** Excalidraw `wrapText(originalText, font, maxWidth)` (the engine's own code). */
export const wrapText = (text: string, family: LobbyFontFamily, sizePx: number, maxWidth: number): string =>
  wrapLabelText(text, family, sizePx, maxWidth)

export type ContainerType = 'rectangle' | 'ellipse' | 'diamond' | 'arrow'

/** `getBoundTextMaxWidth(container, text)`. */
export function boundTextMaxWidth(type: ContainerType, width: number, fontSize: number): number {
  if (type === 'arrow')
    return Math.max(ARROW_LABEL_WIDTH_FRACTION * width, fontSize * ARROW_LABEL_MIN_WIDTH_RATIO)
  if (type === 'ellipse') return Math.round((width / 2) * Math.sqrt(2)) - BOUND_TEXT_PADDING * 2
  if (type === 'diamond') return Math.round(width / 2) - BOUND_TEXT_PADDING * 2
  return width - BOUND_TEXT_PADDING * 2
}

/** `getBoundTextMaxHeight(container, text)` for the box containers. */
export function boundTextMaxHeight(type: Exclude<ContainerType, 'arrow'>, height: number): number {
  if (type === 'ellipse') return Math.round((height / 2) * Math.sqrt(2)) - BOUND_TEXT_PADDING * 2
  if (type === 'diamond') return Math.round(height / 2) - BOUND_TEXT_PADDING * 2
  return height - BOUND_TEXT_PADDING * 2
}

export interface ContainerBox {
  readonly type: Exclude<ContainerType, 'arrow'>
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly angle: number
}

/** `computeBoundTextPosition(container, text)` for rectangle, ellipse and diamond containers. */
export function boundTextPosition(
  c: ContainerBox,
  text: {
    readonly width: number
    readonly height: number
    readonly textAlign: 'left' | 'center' | 'right'
    readonly verticalAlign: 'top' | 'middle' | 'bottom'
    readonly fontSize: number
  },
): { x: number; y: number } {
  let offsetX = BOUND_TEXT_PADDING
  let offsetY = BOUND_TEXT_PADDING
  if (c.type === 'ellipse') {
    offsetX += (c.width / 2) * (1 - Math.sqrt(2) / 2)
    offsetY += (c.height / 2) * (1 - Math.sqrt(2) / 2)
  }
  if (c.type === 'diamond') {
    offsetX += c.width / 4
    offsetY += c.height / 4
  }
  const cx = c.x + offsetX
  const cy = c.y + offsetY
  const maxH = boundTextMaxHeight(c.type, c.height)
  const maxW = boundTextMaxWidth(c.type, c.width, text.fontSize)
  const y =
    text.verticalAlign === 'top'
      ? cy
      : text.verticalAlign === 'bottom'
        ? cy + (maxH - text.height)
        : cy + (maxH / 2 - text.height / 2)
  const x =
    text.textAlign === 'left'
      ? cx
      : text.textAlign === 'right'
        ? cx + (maxW - text.width)
        : cx + (maxW / 2 - text.width / 2)
  if (!c.angle) return { x, y }
  const centerX = cx + maxW / 2
  const centerY = cy + maxH / 2
  const tx = x + text.width / 2 - centerX
  const ty = y + text.height / 2 - centerY
  const cos = Math.cos(c.angle)
  const sin = Math.sin(c.angle)
  return {
    x: centerX + tx * cos - ty * sin - text.width / 2,
    y: centerY + tx * sin + ty * cos - text.height / 2,
  }
}
