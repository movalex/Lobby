// Plain element builders for the room's tests: every field of the strict per-type schemas
// (packages/canvas-schema elements.ts), with Lobby's defaults (roughness 0). No engine import (these tests
// may not import @excalidraw/*; the engine's own constructors are used by the C0 arrow tests).

// biome-ignore lint/suspicious/noExplicitAny: test elements are JSON, read field by field
export type El = Record<string, any>

let seq = 0
/** A fresh element id (the CommentShapeRef character set). */
export const newId = (prefix = 'el') =>
  `${prefix}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`

const base = (id: string, type: string, o: El): El => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roundness: null,
  roughness: 0,
  opacity: 100,
  seed: 1,
  version: 1,
  versionNonce: 1,
  index: null,
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  updated: 1,
  created: 1,
  link: null,
  locked: false,
  ...o,
})

export const rect = (id: string, o: El = {}) => base(id, 'rectangle', o)
export const ellipse = (id: string, o: El = {}) => base(id, 'ellipse', o)
export const note = (id: string, o: El = {}) =>
  base(id, 'stickynote', {
    width: 200,
    height: 200,
    baseHeight: 200,
    backgroundColor: '#fff3bf',
    created: null,
    ...o,
  })
export const frame = (id: string, o: El = {}) =>
  base(id, 'frame', { width: 800, height: 600, name: null, ...o })
export const text = (id: string, o: El = {}) =>
  base(id, 'text', {
    width: 60,
    height: 25,
    fontSize: 20,
    fontFamily: 5,
    baseFontSize: null,
    text: 'hello',
    originalText: 'hello',
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
    ...o,
  })
/** A bound label of `container` (centred), with its container's `boundElements` entry left to the caller. */
export const label = (id: string, containerId: string, o: El = {}) =>
  text(id, { containerId, textAlign: 'center', verticalAlign: 'middle', ...o })
export const arrow = (id: string, o: El = {}) =>
  base(id, 'arrow', {
    width: 100,
    height: 0,
    points: [
      [0, 0],
      [100, 0],
    ],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false,
    ...o,
  })
export const line = (id: string, o: El = {}) =>
  base(id, 'line', {
    points: [
      [0, 0],
      [100, 0],
    ],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    polygon: false,
    ...o,
  })
export const image = (id: string, fileId: string, o: El = {}) =>
  base(id, 'image', { fileId, scale: [1, 1], crop: null, ...o })

/** Binds `a` (an arrow) to targets, both sides, in orbit mode. */
export function bindArrow(a: El, start: El | null, end: El | null, fs = [1, 0.5], fe = [0, 0.5]): El {
  a.startBinding = start ? { elementId: start.id, fixedPoint: fs, mode: 'orbit' } : null
  a.endBinding = end ? { elementId: end.id, fixedPoint: fe, mode: 'orbit' } : null
  for (const t of [start, end])
    if (t && !(t.boundElements ?? []).some((r: El) => r.id === a.id))
      t.boundElements = [...(t.boundElements ?? []), { id: a.id, type: 'arrow' }]
  return a
}

/** Lists `labelEl` in `container`'s boundElements. */
export function withLabel(container: El, labelEl: El): El {
  container.boundElements = [...(container.boundElements ?? []), { id: labelEl.id, type: 'text' }]
  return container
}

/** The whole `path` unit of an arrow or a line (what a client pushes for any geometry change). */
export function pathUnit(el: El): El {
  const fields =
    el.type === 'line'
      ? ['x', 'y', 'points', 'width', 'height', 'angle', 'polygon']
      : [
          'x',
          'y',
          'points',
          'width',
          'height',
          'angle',
          'elbowed',
          ...['fixedSegments', 'startIsSpecial', 'endIsSpecial'].filter((f) => el[f] !== undefined),
        ]
  return Object.fromEntries(fields.map((f) => [f, JSON.parse(JSON.stringify(el[f]))]))
}

/** A version id of the §3.1 pattern. */
export const versionId = (n: number) => `ver_${String(n).padStart(12, '0')}`
export const assetId = (n: number) => `ast_${String(n).padStart(12, '0')}`
