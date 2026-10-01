/**
 * Plain elements with the pinned engine's field set (canvas-schema elements.ts), for the engine core's
 * Node tests: every one passes `WireElement`. Roughness 0, as Lobby draws (CONTRACTS.md finding 4).
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import type { SceneElement } from '../types.ts'

const common = (id: string, index: string) => ({
  id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid' as const,
  strokeWidth: 2,
  strokeStyle: 'solid' as const,
  roughness: 0,
  opacity: 100,
  groupIds: [] as string[],
  frameId: null,
  index,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null as { id: string; type: 'arrow' | 'text' }[] | null,
  updated: 1_700_000_000_000,
  created: 1_700_000_000_000 as number | null,
  link: null,
  locked: false,
})

type Opts = Readonly<Record<string, unknown>>

export const rect = (id: string, index: string, o: Opts = {}): SceneElement =>
  ({ ...common(id, index), type: 'rectangle', ...o }) as unknown as SceneElement

export const frame = (id: string, index: string, o: Opts = {}): SceneElement =>
  ({
    ...common(id, index),
    type: 'frame',
    name: null,
    width: 600,
    height: 400,
    ...o,
  }) as unknown as SceneElement

export const note = (id: string, index: string, o: Opts = {}): SceneElement =>
  ({
    ...common(id, index),
    type: 'stickynote',
    width: 200,
    height: 200,
    baseHeight: 200,
    backgroundColor: '#f8e48f',
    created: null,
    ...o,
  }) as unknown as SceneElement

export const text = (id: string, index: string, o: Opts = {}): SceneElement =>
  ({
    ...common(id, index),
    type: 'text',
    width: 60,
    height: 25,
    fontSize: 20,
    fontFamily: 6,
    baseFontSize: null,
    text: 'memo',
    originalText: 'memo',
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
    ...o,
  }) as unknown as SceneElement

export const arrow = (
  id: string,
  index: string,
  o: Opts & { points?: [number, number][] } = {},
): SceneElement =>
  ({
    ...common(id, index),
    type: 'arrow',
    x: 100,
    y: 50,
    width: 200,
    height: 0,
    points: [
      [0, 0],
      [200, 0],
    ],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false,
    ...o,
  }) as unknown as SceneElement

export const binding = (elementId: string, fixedPoint: [number, number]) => ({
  elementId,
  fixedPoint,
  mode: 'orbit' as const,
})
