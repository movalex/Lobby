// OWNER: WS3 (wave Q). A TEST FIXTURE of WS1's icons module (./icons/index.ts; docs/WAVE-Q-CONTRACTS.md §3) with the
// two exports ./icons-port.ts adapts: fourteen hand-drawn outlines on the 24-unit grid in one shard, served to WS1's own
// catalog code (iconCatalogOf: its search, categories and shard loading) through an in-memory fetch, and WS1's own
// iconElements. Only the unit tests import it; no page loads it (the shipped icons are WS1's generated sets).
import {
  ICON_INDEX_FORMAT,
  ICON_INDEX_VERSION,
  ICON_SHARD_COUNT,
  ICON_SHARD_FORMAT,
  ICON_SHARD_VERSION,
  type IconGeometry,
  type IconIndex,
  type IconIndexEntry,
  type IconPrimitive,
  type IconSetId,
} from '@draftroom/contracts'
import { type IconCatalog, iconCatalogOf } from './icons/catalog.ts'

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

/** One shard holds all fourteen (shard 0); every other shard is empty. */
const SHARD = {
  format: ICON_SHARD_FORMAT,
  version: ICON_SHARD_VERSION,
  shard: 0,
  icons: Object.fromEntries(Object.entries(ICONS).map(([key, [, , geometry]]) => [key, geometry])),
}

/** Serves the double's shard files, as /lobby-assets/icons/ would. */
const fetchShard: typeof fetch = async (input) => {
  const url = String(input)
  const n = INDEX.shards.findIndex((file) => url.endsWith(`/${file}`))
  if (n < 0) return new Response('not found', { status: 404 })
  const body = n === 0 ? SHARD : { ...SHARD, shard: n, icons: {} }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

/** WS1's catalog over the double's index and shards. */
export async function loadIconCatalog(): Promise<IconCatalog> {
  return iconCatalogOf(INDEX, fetchShard)
}

export { iconElements } from './icons/elements.ts'
