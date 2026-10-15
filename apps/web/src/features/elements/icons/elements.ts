// OWNER: WS1 (wave Q, the icons). An icon's geometry (24-unit grid primitives, contracts icons.ts) as native
// Excalidraw elements at an insert size and colour (docs/WAVE-Q-CONTRACTS.md §3.3), ready for ../place.ts:
//
//   placeElements(canvas, iconElements('lucide', 'arrow-right', geometry, { size: 'M', color: 'blue' }), { at, … })
//
//   line     a `line` per primitive (roughness 0, no roundness: Excalidraw draws it with round caps and joins);
//            closed → `polygon: true` with the first point repeated; filled → backgroundColor = the stroke colour
//   ellipse  an `ellipse`; rect  a `rectangle` (corner radius r → roundness {type: 3, value: r × scale})
//
// Every element carries `customData.lobby.kind` ICON_ELEMENT_KIND and `alt` iconAltText(set, name), and all of
// them share one fresh group id (place an icon with keepTogether: false, or placeElements wraps a second group
// around it). The box is the icon's 24 grid at the preset's size (ICON_SIZE_PRESETS: S 48 px stroke 4, M 96 / 8,
// L 192 / 16), which `bounds` reports so a placed icon is centred by its grid, not by its ink. Colour: one of
// Lobby's 13 (board-ops lobbyColor; null = the ink).
// Never an image element. Pure: no fetch, no engine import.

import { type IdSource, lobbyColor, newElementId, randomInt31 } from '@draftroom/board-ops/elements'
import { round2 } from '@draftroom/canvas-schema/limits'
import {
  ICON_ELEMENT_KIND,
  ICON_GRID,
  ICON_SIZE_PRESETS,
  type IconGeometry,
  type IconPrimitive,
  type IconSetId,
  type IconSize,
  type InsertColorName,
  iconAltText,
} from '@draftroom/contracts'
import type { PlaceSource } from '../place.ts'

export interface IconElementsOptions {
  /** the size preset (default M) */
  readonly size?: IconSize
  /** one of Lobby's colours; null or absent = the default ink (black, which dark mode shows light) */
  readonly color?: InsertColorName | null
  /** where ids come from (tests) */
  readonly newId?: IdSource
  /** the `updated` stamp (tests); default now */
  readonly now?: number
}

type El = Record<string, unknown>

/** The undo step's label of an inserted icon. */
export const iconInsertLabel = (name: string) => `insert ${name} icon`

/** The icon's elements at the preset's size, its grid box as `bounds` (see the module comment). */
export function iconElements(
  set: IconSetId,
  name: string,
  geometry: IconGeometry,
  opts: IconElementsOptions = {},
): PlaceSource {
  const preset = ICON_SIZE_PRESETS[opts.size ?? 'M']
  const scale = preset.px / ICON_GRID
  const colour = lobbyColor(opts.color ?? 'black').solid
  const newId = opts.newId ?? newElementId
  const updated = opts.now ?? Date.now()
  const group = newId()
  const lobby = { kind: ICON_ELEMENT_KIND, alt: iconAltText(set, name) }
  const s = (v: number) => round2(v * scale)
  const common = (filled: boolean): El => ({
    id: newId(),
    angle: 0,
    strokeColor: colour,
    backgroundColor: filled ? colour : 'transparent',
    fillStyle: 'solid',
    strokeWidth: preset.strokeWidth,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    seed: randomInt31(),
    version: 1,
    versionNonce: randomInt31(),
    index: null,
    isDeleted: false,
    groupIds: [group],
    frameId: null,
    boundElements: null,
    updated,
    created: null,
    link: null,
    locked: false,
    customData: { lobby: { ...lobby } },
  })
  const element = (p: IconPrimitive): El => {
    switch (p.t) {
      case 'line': {
        const abs: [number, number][] = []
        for (let n = 0; n < p.p.length; n += 2) abs.push([s(p.p[n] as number), s(p.p[n + 1] as number)])
        if (p.closed) abs.push([...(abs[0] as [number, number])])
        const [x0, y0] = abs[0] as [number, number]
        const points = abs.map(([x, y]) => [round2(x - x0), round2(y - y0)])
        const xs = points.map((q) => q[0] as number)
        const ys = points.map((q) => q[1] as number)
        return {
          ...common(p.f === true),
          type: 'line',
          x: x0,
          y: y0,
          width: round2(Math.max(...xs) - Math.min(...xs)),
          height: round2(Math.max(...ys) - Math.min(...ys)),
          roundness: null,
          points,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: null,
          polygon: p.closed === true,
        }
      }
      case 'ellipse':
        return {
          ...common(p.f === true),
          type: 'ellipse',
          x: s(p.x),
          y: s(p.y),
          width: s(p.w),
          height: s(p.h),
          roundness: null,
        }
      case 'rect':
        return {
          ...common(p.f === true),
          type: 'rectangle',
          x: s(p.x),
          y: s(p.y),
          width: s(p.w),
          height: s(p.h),
          roundness: p.r ? { type: 3, value: s(p.r) } : null,
        }
    }
  }
  return {
    label: iconInsertLabel(name),
    elements: geometry.map(element),
    bounds: { x: 0, y: 0, w: preset.px, h: preset.px },
  }
}
