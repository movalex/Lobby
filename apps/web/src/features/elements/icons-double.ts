// OWNER: WS3 (wave Q). A TEST DOUBLE of WS1's icons module (./icons/index.ts; docs/WAVE-Q-CONTRACTS.md §3), with the
// same four exports, so the Elements panel's own tests and specs run before WS1's sets land. It is loaded only on a
// dev-auth page that turned the panel on (./icons-port.ts), never in a production bundle, and it is NOT the shipped
// icon set: fourteen hand-drawn outlines on the 24-unit grid, a substring search, and a plain primitive-to-element
// conversion in the contract's shapes (line per primitive, ellipse, rectangle; roughness 0; one group; `kind` 'icon'
// and the alt text). The real conversion, fidelity and search ranking are WS1's.
import { lobbyColor, newElementId } from '@draftroom/board-ops/elements'
import {
  ICON_ELEMENT_KIND,
  ICON_GRID,
  ICON_INDEX_FORMAT,
  ICON_INDEX_VERSION,
  ICON_SHARD_COUNT,
  ICON_SIZE_PRESETS,
  type IconGeometry,
  type IconIndex,
  type IconIndexEntry,
  type IconPrimitive,
  type IconSetId,
  iconAltText,
  iconKey,
} from '@draftroom/contracts'
import type { IconElementsInput, IconSearchOptions } from './icons-port.ts'
import type { PlaceSource } from './place.ts'

const L = (...p: number[]): IconPrimitive => ({ t: 'line', p })
const closed = (...p: number[]): IconPrimitive => ({ t: 'line', p, closed: true })

/** One icon: its tags (space-separated), its category (Tabler's; null for Lucide) and its primitives. */
const icon = (tags: string, category: string | null, ...geometry: IconPrimitive[]) =>
  [tags.split(' '), category, geometry] as const

/**  → [tags, category, geometry]. */
const ICONS: Readonly<Record<string, readonly [string[], string | null, IconGeometry]>> = {
  'lucide:arrow-right': icon('arrow direction next', null, L(5, 12, 19, 12), L(12, 5, 19, 12, 12, 19)),
  'lucide:arrow-left': icon('arrow direction back', null, L(19, 12, 5, 12), L(12, 19, 5, 12, 12, 5)),
  'lucide:arrow-up': icon('arrow direction', null, L(12, 19, 12, 5), L(5, 12, 12, 5, 19, 12)),
  'lucide:check': icon('done tick yes', null, L(20, 6, 9, 17, 4, 12)),
  'lucide:x': icon('close cancel no', null, L(18, 6, 6, 18), L(6, 6, 18, 18)),
  'lucide:circle': icon('shape round', null, { t: 'ellipse', x: 2, y: 2, w: 20, h: 20 }),
  'lucide:square': icon('shape box', null, { t: 'rect', x: 3, y: 3, w: 18, h: 18, r: 2 }),
  'lucide:star': icon(
    'favourite rating',
    null,
    closed(12, 2, 15.09, 8.26, 22, 9.27, 17, 14.14, 18.18, 21.02, 12, 17.77, 5.82, 21.02, 7, 14.14, 2, 9.27),
  ),
  'lucide:heart': icon(
    'love like',
    null,
    closed(12, 21, 4, 13.5, 2.5, 10, 3, 6.5, 5.5, 4, 9, 4, 12, 7, 15, 4, 18.5, 4, 21, 6.5, 21.5, 10),
  ),
  'lucide:house': icon(
    'home building',
    null,
    closed(3, 10, 12, 3, 21, 10, 21, 21, 3, 21),
    L(9, 21, 9, 14, 15, 14, 15, 21),
  ),
  'lucide:message-square': icon(
    'chat comment',
    null,
    closed(21, 15, 21, 5, 19, 3, 5, 3, 3, 5, 3, 21, 7, 17, 19, 17),
  ),
  'tabler:bulb': icon(
    'idea light',
    'Electrical',
    { t: 'ellipse', x: 6, y: 2, w: 12, h: 12 },
    L(9, 16, 15, 16),
    L(10, 19, 14, 19),
    L(12, 14, 12, 16),
  ),
  'tabler:user': icon(
    'person account people',
    'System',
    { t: 'ellipse', x: 8, y: 3, w: 8, h: 8 },
    L(6, 21, 6, 19, 8, 15, 12, 14, 16, 15, 18, 19, 18, 21),
  ),
  'tabler:flag': icon('report milestone', 'Map', L(5, 21, 5, 4), closed(5, 4, 19, 4, 15, 9, 19, 14, 5, 14)),
}

const SETS = [
  { id: 'lucide' as const, version: '1.49.0', licence: 'ISC' as const },
  { id: 'tabler' as const, version: '3.48.0', licence: 'MIT' as const },
]

const INDEX: IconIndex = {
  format: ICON_INDEX_FORMAT,
  version: ICON_INDEX_VERSION,
  sets: SETS.map((s) => ({
    ...s,
    count: Object.keys(ICONS).filter((k) => k.startsWith(`${s.id}:`)).length,
  })),
  shards: Array.from({ length: ICON_SHARD_COUNT }, (_, n) => `shard-${n}.00000000.json`),
  icons: Object.entries(ICONS)
    .map(([key, [tags, category]]): IconIndexEntry => {
      const [set, name] = key.split(':') as [IconSetId, string]
      return [set, name, tags, category, 0]
    })
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
}

export async function loadIconIndex(): Promise<IconIndex> {
  return INDEX
}

export function searchIcons(index: IconIndex, query: string, opts: IconSearchOptions = {}): IconIndexEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const pool = index.icons.filter(
    (e) => (!opts.set || e[0] === opts.set) && (!opts.category || e[3] === opts.category),
  )
  const scored: { e: IconIndexEntry; score: number; at: number }[] = []
  pool.forEach((e, at) => {
    let score = 0
    for (const w of words) {
      if (e[1].startsWith(w)) score += 100
      else if (e[1].includes(w)) score += 30
      else if (e[2].some((t) => t.startsWith(w))) score += 10
      else return
    }
    scored.push({ e, score, at })
  })
  const out = scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.e)
  return opts.limit ? out.slice(0, opts.limit) : out
}

export async function loadIconGeometry(
  _index: IconIndex,
  set: IconSetId,
  name: string,
): Promise<IconGeometry | null> {
  return ICONS[iconKey(set, name)]?.[2] ?? null
}

const r2 = (v: number) => Math.round(v * 100) / 100
const seed = () => Math.floor(Math.random() * 2 ** 31)

export function iconElements(input: IconElementsInput): PlaceSource {
  const preset = ICON_SIZE_PRESETS[input.size]
  const k = preset.px / ICON_GRID
  const ink = lobbyColor(input.color ?? 'black').solid
  const group = input.geometry.length > 1 ? newElementId() : null
  const now = Date.now()
  const base = (fill: boolean) => ({
    angle: 0,
    strokeColor: ink,
    backgroundColor: fill ? ink : 'transparent',
    fillStyle: 'solid',
    strokeWidth: preset.strokeWidth,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    index: null,
    isDeleted: false,
    groupIds: group ? [group] : [],
    frameId: null,
    boundElements: null,
    updated: now,
    created: null,
    link: null,
    locked: false,
    customData: { lobby: { kind: ICON_ELEMENT_KIND, alt: iconAltText(input.set, input.name) } },
  })
  const elements = input.geometry.map((p): Record<string, unknown> => {
    if (p.t === 'line') {
      const pts: [number, number][] = []
      for (let i = 0; i + 1 < p.p.length; i += 2)
        pts.push([r2((p.p[i] as number) * k), r2((p.p[i + 1] as number) * k)])
      if (p.closed) pts.push([...(pts[0] as [number, number])])
      const [x0, y0] = pts[0] as [number, number]
      const rel = pts.map(([x, y]) => [r2(x - x0), r2(y - y0)] as [number, number])
      const xs = rel.map((q) => q[0])
      const ys = rel.map((q) => q[1])
      return {
        ...base(false),
        id: newElementId(),
        type: 'line',
        x: x0,
        y: y0,
        width: r2(Math.max(...xs) - Math.min(...xs)),
        height: r2(Math.max(...ys) - Math.min(...ys)),
        roundness: null,
        points: rel,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
        polygon: p.closed === true,
      }
    }
    return {
      ...base(p.f === true),
      id: newElementId(),
      type: p.t === 'rect' ? 'rectangle' : 'ellipse',
      x: r2(p.x * k),
      y: r2(p.y * k),
      width: r2(p.w * k),
      height: r2(p.h * k),
      roundness: p.t === 'rect' && p.r ? { type: 3, value: r2(p.r * k) } : null,
    }
  })
  return {
    label: `insert ${input.name} icon`,
    elements,
    bounds: { x: 0, y: 0, w: preset.px, h: preset.px },
  }
}
