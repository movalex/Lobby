// OWNER: 3i. Element fixtures for the a11y feature's unit tests (Node; no engine, no DOM).
import type { CanvasElement } from '../../../canvas/api/index.ts'
import type { LevelInput } from './reading-order.ts'

export const el = (p: Record<string, unknown>): CanvasElement =>
  ({
    id: 'x',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    ...p,
  }) as unknown as CanvasElement

/** A sticky note with its bound label (`<id>-label`). */
export function note(id: string, x: number, y: number, text: string, extra: Record<string, unknown> = {}) {
  return [
    el({
      id,
      type: 'stickynote',
      x,
      y,
      width: 200,
      height: 200,
      boundElements: text ? [{ id: `${id}-label`, type: 'text' }] : null,
      ...extra,
    }),
    ...(text
      ? [
          el({
            id: `${id}-label`,
            type: 'text',
            x: x + 10,
            y: y + 10,
            width: 180,
            height: 40,
            containerId: id,
            originalText: text,
            text,
            frameId: extra.frameId ?? null,
          }),
        ]
      : []),
  ]
}

export const frame = (id: string, x: number, y: number, w: number, h: number, name: string | null) =>
  el({ id, type: 'frame', x, y, width: w, height: h, name })

export const text = (id: string, x: number, y: number, words: string, extra: Record<string, unknown> = {}) =>
  el({ id, type: 'text', x, y, width: 160, height: 30, originalText: words, text: words, ...extra })

/** A level input over plain elements (bounds from x, y, width, height). */
export function input(elements: CanvasElement[], hidden: string[] = []): LevelInput {
  const byId = new Map(elements.map((e) => [e.id, e]))
  return {
    elements,
    bounds: (id) => {
      const e = byId.get(id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    isHidden: (id) => hidden.includes(id),
  }
}
