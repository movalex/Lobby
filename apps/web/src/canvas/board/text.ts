/**
 * Text helpers of the board page (docs/EXCALIDRAW-CONTRACTS.md §2.1 `text.measure`, `text.replace`):
 *
 *  - `measureText`: Excalidraw's own measurement (the canvas the editor measures with), wrapped at a
 *    width when one is given;
 *  - `layoutReplacement`: the fields a programmatic text write changes, laid out the way Excalidraw's
 *    editor lays them out when someone types (a bound label re-wraps and re-centres in its container; a
 *    sticky note re-runs its fit; a free text grows). It runs on copies of the elements, so the writes
 *    go into ONE `transact` (one undo step, pushed by the sync engine) instead of a second scene update.
 *
 * Browser only (Excalidraw's measurement needs a canvas).
 */
import { getFontString, getLineHeight } from '@excalidraw/common'
import * as ElementLib from '@excalidraw/element'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element helpers, typed loosely on purpose
const X = ElementLib as any

export interface MeasureStyle {
  readonly fontFamily: number
  readonly fontSize: number
  readonly lineHeight?: number
  readonly width?: number
}

/** The size `text` takes in `style` (wrapped at `style.width` when given), in scene px. */
export function measureText(text: string, style: MeasureStyle): { width: number; height: number } {
  const font = getFontString({ fontSize: style.fontSize, fontFamily: style.fontFamily } as never)
  const lineHeight = style.lineHeight ?? getLineHeight(style.fontFamily as never)
  const shown = style.width !== undefined ? X.wrapText(text, font, style.width) : text
  const m = X.measureText(shown, font, lineHeight) as { width: number; height: number }
  return { width: m.width, height: m.height }
}

const LAYOUT_FIELDS = ['text', 'originalText', 'x', 'y', 'width', 'height', 'fontSize', 'autoResize'] as const
const CONTAINER_FIELDS = ['x', 'y', 'width', 'height'] as const

/**
 * The writes that put `text` into the text element `labelId` (a bound label or a free text), laid out
 * as the editor would: id → changed fields. Falls back to the words alone when Excalidraw's layout
 * refuses the copies (the server's fit and re-snap still run on the push).
 */
export function layoutReplacement(
  api: ExcalidrawImperativeAPI,
  labelId: string,
  text: string,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const els = api.getSceneElementsIncludingDeleted()
  // biome-ignore lint/suspicious/noExplicitAny: plain copies of engine elements
  const map = new Map<string, any>(els.map((e) => [e.id, structuredClone(e)]))
  const label = map.get(labelId)
  if (label?.type !== 'text') throw new Error(`text.replace: ${labelId} is not a text element`)
  const before = structuredClone(label)
  const container = label.containerId ? map.get(label.containerId) : null
  const containerBefore = container ? structuredClone(container) : null
  try {
    const scene = {
      // biome-ignore lint/suspicious/noExplicitAny: see above
      mutateElement: (el: any, u: any, o?: any) => X.mutateElement(el, map, u, o),
      getNonDeletedElementsMap: () => map,
      getElementsMapIncludingDeleted: () => map,
      getNonDeletedElements: () => [...map.values()].filter((e) => !e.isDeleted),
      getElement: (id: string) => map.get(id) ?? null,
      triggerUpdate: () => {},
    }
    X.mutateElement(label, map, { text, originalText: text })
    if (container?.type === 'stickynote' && typeof X.updateStickyNoteLayout === 'function')
      X.updateStickyNoteLayout(container, scene, { text })
    else X.redrawTextBoundingBox(label, container, scene)
  } catch {
    out.set(labelId, { text, originalText: text })
    return out
  }
  const patch: Record<string, unknown> = {}
  for (const f of LAYOUT_FIELDS) if (label[f] !== before[f]) patch[f] = label[f]
  patch.text = label.text
  patch.originalText = text
  out.set(labelId, patch)
  if (container && containerBefore) {
    const cp: Record<string, unknown> = {}
    for (const f of CONTAINER_FIELDS) if (container[f] !== containerBefore[f]) cp[f] = container[f]
    if (Object.keys(cp).length) out.set(container.id, cp)
  }
  return out
}
