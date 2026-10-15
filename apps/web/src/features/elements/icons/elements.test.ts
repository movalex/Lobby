// Wave Q (WS1): iconElements over EVERY generated icon at every size preset: elements the room accepts
// (canvas-schema checkElement per element, checkInvariants across them), the icon marker and alt text, one shared
// group, the preset's stroke width, inside the preset's box; and an icon placed through the shared insert in one
// undo step.
import { lobbyColor } from '@draftroom/board-ops/elements'
import { checkElement } from '@draftroom/canvas-schema/elements'
import { indexKeysBetween } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import {
  ICON_ELEMENT_KIND,
  ICON_GRID,
  ICON_GRID_MAX,
  ICON_GRID_MIN,
  ICON_SIZE_PRESETS,
  ICON_SIZES,
  type IconGeometry,
  IconShard,
  iconAltText,
} from '@draftroom/contracts'
import { pinnedIcons } from '@draftroom/icon-sets/generate'
import { beforeAll, describe, expect, it } from 'vitest'
import { fakeCanvas } from '../../sort/test-kit.ts'
import { placeElements } from '../place.ts'
import { iconElements, iconInsertLabel } from './elements.ts'

type El = Record<string, unknown>

let all: [key: string, geometry: IconGeometry][]

beforeAll(() => {
  all = []
  for (const f of pinnedIcons().files) {
    if (!f.name.startsWith('shard-')) continue
    for (const entry of Object.entries(IconShard.parse(JSON.parse(f.content)).icons)) all.push(entry)
  }
})

const split = (key: string) => key.split(':') as ['lucide' | 'tabler', string]

describe('iconElements', () => {
  it('turns EVERY icon, at S, M and L, into elements the room accepts, marked, grouped and sized', () => {
    expect(all.length).toBe(pinnedIcons().index.icons.length)
    let counter = 0
    const newId = () => `icon-el-${(counter++).toString(36).padStart(6, '0')}`
    for (const size of ICON_SIZES) {
      const { px, strokeWidth } = ICON_SIZE_PRESETS[size]
      const lo = (ICON_GRID_MIN / ICON_GRID) * px - 0.01
      const hi = (ICON_GRID_MAX / ICON_GRID) * px + 0.01
      for (const [key, geometry] of all) {
        const [set, name] = split(key)
        const out = iconElements(set, name, geometry, { size, newId, now: 1 })
        expect(out.bounds).toEqual({ x: 0, y: 0, w: px, h: px })
        const els = out.elements as El[]
        expect(els).toHaveLength(geometry.length)
        const groups = new Set(els.map((e) => JSON.stringify(e.groupIds)))
        expect(groups.size, key).toBe(1)
        for (const e of els) {
          const check = checkElement(e)
          if (!check.ok) throw new Error(`${key} ${size}: ${check.detail}`)
          expect((e.groupIds as string[]).length).toBe(1)
          expect(e.strokeWidth).toBe(strokeWidth)
          expect(e.customData).toEqual({ lobby: { kind: ICON_ELEMENT_KIND, alt: iconAltText(set, name) } })
          const x = e.x as number
          const y = e.y as number
          const pts = (e.points as [number, number][] | undefined) ?? [
            [0, 0],
            [e.width as number, e.height as number],
          ]
          for (const [px0, py0] of pts) {
            if (!(x + px0 >= lo && x + px0 <= hi && y + py0 >= lo && y + py0 <= hi))
              throw new Error(`${key} ${size}: a point outside the box`)
          }
        }
        // the insert gives them indices on top of the board (here: a fresh run)
        const keys = indexKeysBetween(null, null, els.length)
        const violations = checkInvariants(els.map((e, n) => ({ ...e, index: keys[n] })) as never)
        if (violations.length) throw new Error(`${key} ${size}: ${violations.map((v) => v.code).join(',')}`)
      }
    }
  })

  it('draws lines, closed and filled lines, ellipses and rounded rectangles as Excalidraw does', () => {
    const geometry: IconGeometry = [
      { t: 'line', p: [2, 2, 22, 2] },
      { t: 'line', p: [12, 2, 22, 22, 2, 22], closed: true },
      { t: 'line', p: [6, 14, 8, 14, 8, 16, 6, 16], closed: true, f: true },
      { t: 'ellipse', x: 2, y: 2, w: 20, h: 20 },
      { t: 'ellipse', x: 7, y: 7, w: 1, h: 1, f: true },
      { t: 'rect', x: 3, y: 3, w: 18, h: 18, r: 2 },
      { t: 'rect', x: 3, y: 3, w: 18, h: 18 },
    ]
    const blue = lobbyColor('blue').solid
    const out = iconElements('lucide', 'test', geometry, { size: 'L', color: 'blue', now: 5 })
    const els = out.elements as El[]
    const [open, closed, filled, ring, dot, rounded, square] = els as El[]
    // L: 192 px, 8 px per grid unit
    expect(open).toMatchObject({
      type: 'line',
      x: 16,
      y: 16,
      width: 160,
      height: 0,
      points: [
        [0, 0],
        [160, 0],
      ],
      polygon: false,
      roughness: 0,
      roundness: null,
      strokeColor: blue,
      backgroundColor: 'transparent',
      strokeWidth: 16,
    })
    expect(closed?.polygon).toBe(true)
    expect(closed?.points).toEqual([
      [0, 0],
      [80, 160],
      [-80, 160],
      [0, 0],
    ])
    expect(filled).toMatchObject({ polygon: true, backgroundColor: blue, fillStyle: 'solid' })
    expect(ring).toMatchObject({ type: 'ellipse', x: 16, y: 16, width: 160, height: 160 })
    expect(ring?.backgroundColor).toBe('transparent')
    expect(dot).toMatchObject({ type: 'ellipse', backgroundColor: blue })
    expect(rounded).toMatchObject({ type: 'rectangle', roundness: { type: 3, value: 16 } })
    expect(square?.roundness).toBeNull()
    for (const e of els) expect(e).toMatchObject({ updated: 5, created: null, index: null, locked: false })
    // the default colour is Lobby's ink (dark mode shows it light)
    const ink = iconElements('tabler', 'x', [{ t: 'line', p: [0, 0, 1, 1] }]).elements[0] as El
    expect(ink.strokeColor).toBe(lobbyColor('black').solid)
    expect(ink.strokeWidth).toBe(ICON_SIZE_PRESETS.M.strokeWidth)
  })

  it('places through the shared insert in one undo step, centred by its grid box, still marked', () => {
    const [key, geometry] = all.find(([k]) => k === 'lucide:arrow-right') ?? []
    if (!key || !geometry) throw new Error('lucide:arrow-right is not generated')
    const f = fakeCanvas([])
    const source = iconElements('lucide', 'arrow-right', geometry, { size: 'M' })
    const at = { x: 1000, y: 500 }
    const out = placeElements(f.canvas, source, { at, keepTogether: false, reveal: false })
    if (!out.ok) throw new Error(out.reason)
    expect(f.steps).toEqual([iconInsertLabel('arrow-right')])
    expect(out.bounds).toEqual({ x: 952, y: 452, width: 96, height: 96 })
    const placed = out.allIds.map((id) => f.els.get(id) as El)
    expect(placed).toHaveLength(geometry.length)
    // fresh ids and one fresh group, the marker kept
    expect(new Set(placed.map((e) => (e.groupIds as string[]).join())).size).toBe(1)
    for (const e of placed) {
      expect((e.customData as { lobby: { kind: string } }).lobby.kind).toBe('icon')
      expect(source.elements.some((s) => s.id === e.id)).toBe(false)
    }
  })
})
