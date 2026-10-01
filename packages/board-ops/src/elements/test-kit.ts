// Element fixtures for the board-ops element tests (not exported from the package): a small board with
// every kind of reference the readers and the archive follow, valid by the server's element check and the
// cross-element invariants.

import type { WireElement } from '@draftroom/canvas-schema/elements'
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { LOBBY_INK, LOBBY_PALETTE } from './palette.ts'

/** The engine's text layout in Node (the server table), as apps/sync installs it. */
export const metrics = installServerTextMetrics()

const base = {
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid' as const,
  strokeWidth: 2,
  strokeStyle: 'solid' as const,
  roughness: 0,
  opacity: 100,
  groupIds: [] as string[],
  frameId: null as string | null,
  roundness: null,
  seed: 7,
  version: 3,
  versionNonce: 11,
  isDeleted: false,
  boundElements: null as { id: string; type: 'arrow' | 'text' }[] | null,
  updated: 1_790_000_000_000,
  created: null,
  link: null,
  locked: false,
}

const text = (
  id: string,
  index: string,
  at: { x: number; y: number; w: number; h: number },
  words: string,
  extra: Record<string, unknown> = {},
) => ({
  ...base,
  id,
  type: 'text' as const,
  index,
  x: at.x,
  y: at.y,
  width: at.w,
  height: at.h,
  text: words,
  originalText: words,
  fontSize: 20,
  fontFamily: 6 as const,
  baseFontSize: null,
  textAlign: 'center' as const,
  verticalAlign: 'middle' as const,
  containerId: null as string | null,
  autoResize: true,
  lineHeight: 1.25,
  labelPosition: null,
  ...extra,
})

const lobbyServer = {
  createdBy: { uid: 'usr_alice', name: 'Alice', guest: false },
  createdAt: 1,
  lastEditedBy: { uid: 'usr_bob', name: 'Bob', guest: false },
  lastEditedAt: 2,
}

/** A small board: frame F (Ideas) holding note N (+label), box R (+label) → arrow A → ellipse E; text T; … */
export function sampleBoard(): WireElement[] {
  return [
    {
      ...base,
      id: 'F',
      type: 'frame',
      index: 'a0',
      x: 0,
      y: 0,
      width: 1000,
      height: 600,
      name: 'Ideas',
      strokeColor: '#bbb',
      customData: { lobby: { present: { index: 2 } } },
    },
    {
      ...base,
      id: 'N',
      type: 'stickynote',
      index: 'a1',
      x: 40,
      y: 100,
      width: 200,
      height: 200,
      baseHeight: 200,
      frameId: 'F',
      backgroundColor: LOBBY_PALETTE.yellow.noteFill,
      strokeColor: LOBBY_INK,
      boundElements: [{ id: 'N-label', type: 'text' }],
      customData: {
        lobby: {
          'tag:research': { name: 'research', color: 'blue' },
          'plusOne:usr_alice': true,
          mindmap: { rootId: 'N', parentId: null, side: 'right', collapsed: false },
        },
        lobbyServer,
      },
    },
    text('N-label', 'a2', { x: 60, y: 175, w: 160, h: 50 }, 'Café idea\nsecond line', {
      frameId: 'F',
      containerId: 'N',
      strokeColor: LOBBY_INK,
      baseFontSize: 20,
      customData: { lobbyServer },
    }),
    {
      ...base,
      id: 'R',
      type: 'rectangle',
      index: 'a3',
      x: 300,
      y: 100,
      width: 200,
      height: 100,
      frameId: 'F',
      strokeColor: LOBBY_PALETTE.orange.solid,
      boundElements: [
        { id: 'R-label', type: 'text' },
        { id: 'A', type: 'arrow' },
      ],
      customData: { lobby: { ai: { by: 'usr_alice' }, kind: 'card' } },
    },
    text('R-label', 'a4', { x: 350, y: 137.5, w: 100, h: 25 }, '=Launch plan', {
      frameId: 'F',
      containerId: 'R',
      strokeColor: LOBBY_PALETTE.black.solid,
    }),
    {
      ...base,
      id: 'E',
      type: 'ellipse',
      index: 'a5',
      x: 700,
      y: 100,
      width: 200,
      height: 100,
      frameId: 'F',
      strokeColor: LOBBY_PALETTE.violet.solid,
      boundElements: [{ id: 'A', type: 'arrow' }],
    },
    {
      ...base,
      id: 'A',
      type: 'arrow',
      index: 'a6',
      x: 506,
      y: 150,
      width: 188,
      height: 0,
      frameId: 'F',
      strokeColor: LOBBY_PALETTE.grey.solid,
      points: [
        [0, 0],
        [188, 0],
      ],
      startBinding: { elementId: 'R', fixedPoint: [1, 0.5001], mode: 'orbit' },
      endBinding: { elementId: 'E', fixedPoint: [0, 0.5001], mode: 'orbit' },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
      customData: { lobby: { mindmapEdge: { rootId: 'N', parentId: 'N', childId: 'E' } } },
    },
    text('T', 'a7', { x: 40, y: 400, w: 400, h: 25 }, 'Free text in the frame', {
      frameId: 'F',
      textAlign: 'left',
      verticalAlign: 'top',
      autoResize: false,
      strokeColor: LOBBY_PALETTE.grey.solid,
      locked: true,
    }),
    {
      ...base,
      id: 'I',
      type: 'image',
      index: 'a8',
      x: 1200,
      y: 0,
      width: 300,
      height: 200,
      fileId: 'ver_0123456789abcdef',
      status: 'saved',
      scale: [1, 1],
      crop: null,
      groupIds: ['G1'],
      customData: {
        lobby: {
          alt: 'Hero shot',
          file: {
            assetId: 'ast_0123456789abcdef',
            versionId: 'ver_0123456789abcdef',
            kind: 'image',
            name: 'hero.png',
            mimeType: 'image/png',
            sizeBytes: 1234,
          },
        },
      },
    },
    {
      ...base,
      id: 'D',
      type: 'freedraw',
      index: 'a9',
      x: 1200,
      y: 300,
      width: 10,
      height: 10,
      groupIds: ['G1'],
      points: [
        [0, 0],
        [10, 10],
      ],
      pressures: [],
      simulatePressure: true,
      strokeOptions: { variability: 'variable', streamline: 0.5 },
    },
    {
      ...base,
      id: 'F2',
      type: 'frame',
      index: 'aA',
      x: 0,
      y: 800,
      width: 400,
      height: 300,
      name: 'Parking lot',
      strokeColor: '#bbb',
      customData: { lobby: { present: { skip: true } } },
    },
    {
      ...base,
      id: 'X',
      type: 'rectangle',
      index: 'aB',
      x: 2000,
      y: 2000,
      width: 10,
      height: 10,
      isDeleted: true,
    },
  ] as unknown as WireElement[]
}

export const SAMPLE_DOC = {
  startView: { x: 0, y: 0, w: 1000, h: 600, frameId: 'F' },
  workshop: { hideNoteAuthors: true, hideCursors: false },
  'tagDef:research': { name: 'research', color: 'blue' },
  import: {
    from: 'tldraw-5.4.2',
    converterVersion: '1',
    at: 1,
    legacyPages: {},
    legacyIds: {},
    lossy: {},
  },
}

export const SAMPLE_ASSET = {
  assetId: 'ast_0123456789abcdef',
  versionId: 'ver_0123456789abcdef',
  name: 'hero.png',
  mimeType: 'image/png',
  sizeBytes: 1234,
  sha256: 'a'.repeat(64),
}

/** `e1`, `e2`, … */
export function seqIds(prefix = 'n'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}
