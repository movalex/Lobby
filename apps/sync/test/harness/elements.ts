// Plain element builders for protocol tests on the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §6.2):
// every field of the strict per-type schemas (packages/canvas-schema elements.ts) with Lobby's defaults
// (roughness 0, fontFamily 5), as JSON. No engine import: server tests build what a client would send and
// the server's own code (the room, canvas-schema) does the rest. `checkElement` in the harness self-test
// proves every builder's output is a valid wire element.

// biome-ignore lint/suspicious/noExplicitAny: wire elements are JSON, read field by field
export type El = Record<string, any>

let seq = 0
/** A fresh element id (the CommentShapeRef character set: `[A-Za-z0-9_.:-]{1,120}`). */
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
export const diamond = (id: string, o: El = {}) => base(id, 'diamond', o)
/** A sticky note (without its label: see `noteWithLabel`). */
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
/** A bound label of `containerId` (centred); the container's `boundElements` entry is the caller's. */
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
export const freedraw = (id: string, o: El = {}) =>
  base(id, 'freedraw', {
    points: [
      [0, 0],
      [10, 10],
    ],
    pressures: [],
    simulatePressure: true,
    strokeOptions: { variability: 'variable', streamline: 0.5 },
    ...o,
  })
export const image = (id: string, fileId: string, o: El = {}) =>
  base(id, 'image', { fileId, status: 'saved', scale: [1, 1], crop: null, ...o })

/** Lists `labelEl` in `container`'s `boundElements` (the one-to-one rule, §2.4.4). */
export function withLabel(container: El, labelEl: El): El {
  container.boundElements = [...(container.boundElements ?? []), { id: labelEl.id, type: 'text' }]
  return container
}

/** A note and its bound label, both sides listed: what a client creates for a sticky note. */
export function noteWithLabel(id: string, words = '', o: El = {}): [El, El] {
  const n = note(id, o)
  const t = label(`${id}.t`, id, { text: words, originalText: words, x: n.x + 10, y: n.y + 10 })
  withLabel(n, t)
  return [n, t]
}

/** Binds `a` (an arrow) to `start` and `end`, both sides, in orbit mode. */
export function bindArrow(a: El, start: El | null, end: El | null): El {
  a.startBinding = start ? { elementId: start.id, fixedPoint: [1, 0.5], mode: 'orbit' } : null
  a.endBinding = end ? { elementId: end.id, fixedPoint: [0, 0.5], mode: 'orbit' } : null
  for (const t of [start, end])
    if (t && !(t.boundElements ?? []).some((r: El) => r.id === a.id))
      t.boundElements = [...(t.boundElements ?? []), { id: a.id, type: 'arrow' }]
  return a
}

/** The whole `path` unit of an arrow or a line (what a client pushes for any geometry change, §3.2). */
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
  return Object.fromEntries(fields.map((f) => [f, structuredClone(el[f])]))
}

/** A version id of the §3.1 `fileId` pattern, and an asset id. */
export const versionId = (n: number) => `ver_${String(n).padStart(12, '0')}`
export const assetId = (n: number) => `ast_${String(n).padStart(12, '0')}`
