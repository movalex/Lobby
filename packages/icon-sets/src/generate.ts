// OWNER: WS1 (wave Q, the icons). The generator: both pinned sets, read from node_modules, converted (./convert.ts)
// into the files the web serves under ICON_ASSET_PREFIX (contracts icons.ts; docs/WAVE-Q-CONTRACTS.md §3.2):
//
//   index.<hash>.json      IconIndex: [set, name, tags, category, shard] for every included icon, sorted by set, name
//   shard-<n>.<hash>.json  IconShard n: `<set>:<name>` → IconGeometry, for the icons whose key hashes to n
//   LICENSES.txt           both sets' licence texts (the panel footer links it)
//
// and the build report: per set, what is in and what was left out and why (Tabler's Brand category: trademarks;
// icons the converter refuses, with its reason), the fidelity (the Hausdorff distance of every included icon to its
// densely sampled source) and the file sizes. <hash> is 16 hex characters of the file's sha256, so a file name
// changes exactly when its content does; the index names the shards, so it changes with any of them.
//
// Run at build (apps/web/build/lobby-assets.ts) and in the tests, never committed: the output is a pure function of
// the pinned packages and this code (the checksum test pins it). Node only.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ICON_INDEX_FORMAT,
  ICON_INDEX_VERSION,
  ICON_NAME_MAX,
  ICON_NAME_PATTERN,
  ICON_SET_IDS,
  ICON_SHARD_COUNT,
  ICON_SHARD_FORMAT,
  ICON_SHARD_VERSION,
  ICON_TAG_MAX_CHARS,
  ICON_TAGS_MAX,
  type IconGeometry,
  type IconIndex,
  type IconIndexEntry,
  type IconSetId,
  type IconShard,
  iconKey,
} from '@draftroom/contracts'
import { type ConvertFailure, convertIcon } from './convert.ts'
import { ICON_SETS_ROOT, readIconSetJson } from './files.ts'
import { ICON_SET_PACKAGES, type IconNode, type TablerIconMeta } from './index.ts'

/** Tabler's category of brand logos: trademarks (a licence does not grant their use), left out. */
export const EXCLUDED_TABLER_CATEGORIES: readonly string[] = ['Brand']

export type ExcludedReason = ConvertFailure | 'brand' | 'bad-name'

/** One icon as the sets describe it, before conversion. */
export interface SourceIcon {
  readonly set: IconSetId
  readonly name: string
  readonly nodes: readonly IconNode[]
  readonly tags: readonly string[]
  readonly category: string | null
}

export interface IconSetReport {
  readonly id: IconSetId
  readonly version: string
  /** icons in the package */
  readonly total: number
  readonly included: number
  /** reason → the names left out for it (sorted) */
  readonly excluded: Readonly<Partial<Record<ExcludedReason, readonly string[]>>>
  /** the refusals' details, `name: detail` (Brand is not listed: it is a category, not a failure) */
  readonly details: readonly string[]
}

export interface IconBuildReport {
  readonly sets: readonly IconSetReport[]
  readonly fidelity: {
    /** grid units; ICON_MAX_HAUSDORFF is the cap */
    readonly mean: number
    readonly p50: number
    readonly p99: number
    readonly max: number
    /** the ten furthest icons, `<set>:<name>` and distance */
    readonly worst: readonly (readonly [string, number])[]
  }
  readonly primitives: { readonly total: number; readonly max: number; readonly linePoints: number }
  readonly sizes: {
    readonly index: number
    readonly shardsTotal: number
    readonly shardMin: number
    readonly shardMax: number
    readonly licences: number
  }
}

export interface GeneratedFile {
  /** relative to ICON_ASSET_PREFIX */
  readonly name: string
  readonly content: string
}

export interface GeneratedIcons {
  /** every file, the index first, then the shards in order, then LICENSES.txt */
  readonly files: readonly GeneratedFile[]
  /** the hashed index file name (the web learns it at build time) */
  readonly indexFile: string
  readonly index: IconIndex
  readonly report: IconBuildReport
}

// ---- reading the sets ---------------------------------------------------------------------------------------------

/** Lowercased, trimmed, unique tags; the name and its words are left out (search reads the name anyway). */
function cleanTags(raw: readonly unknown[], name: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([name, ...name.split('-')])
  for (const t of raw) {
    const tag = String(t).trim().toLowerCase().replace(/\s+/g, ' ')
    if (!tag || tag.length > ICON_TAG_MAX_CHARS || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= ICON_TAGS_MAX) break
  }
  return out
}

/** Both sets' icons, in set order and then by name (code-unit order, so it never depends on a locale). */
export function readSourceIcons(): SourceIcon[] {
  const out: SourceIcon[] = []
  for (const set of ICON_SET_IDS) {
    const pkg = ICON_SET_PACKAGES[set]
    const nodes = readIconSetJson(set, pkg.nodesFile) as Record<string, IconNode[]>
    const meta = readIconSetJson(set, pkg.metaFile) as Record<string, unknown>
    for (const name of Object.keys(nodes).sort()) {
      let tags: readonly unknown[] = []
      let category: string | null = null
      if (pkg.metaShape === 'tabler-icons-json') {
        const m = meta[name] as TablerIconMeta | undefined
        tags = m?.tags ?? []
        category = m?.category?.trim() || null
      } else tags = (meta[name] as string[] | undefined) ?? []
      out.push({ set, name, nodes: nodes[name] ?? [], tags: cleanTags(tags, name), category })
    }
  }
  return out
}

// ---- hashing and files ----------------------------------------------------------------------------------------------

/** The shard of an icon: FNV-1a (32 bit) of `<set>:<name>`, modulo ICON_SHARD_COUNT. */
export function shardOf(set: IconSetId, name: string): number {
  let h = 0x811c9dc5
  const key = iconKey(set, name)
  for (let n = 0; n < key.length; n++) {
    h ^= key.charCodeAt(n)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % ICON_SHARD_COUNT
}

const hash16 = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 16)

function licencesText(): string {
  const parts = [
    "Lobby's built-in icons are converted from these icon sets (outline style). Their licences:",
    '',
  ]
  for (const set of ICON_SET_IDS) {
    const pkg = ICON_SET_PACKAGES[set]
    const text = readFileSync(join(ICON_SETS_ROOT, pkg.licenceFile), 'utf8').replace(/\r\n/g, '\n').trimEnd()
    parts.push(`==== ${pkg.credit}: ${pkg.packageName} ${pkg.version} (${pkg.licence}) ====`, '', text, '')
  }
  return `${parts.join('\n')}\n`
}

const quantile = (sorted: readonly number[], q: number) =>
  sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number) : 0
const round4 = (v: number) => Math.round(v * 1e4) / 1e4

interface SetStats {
  total: number
  included: number
  excluded: Map<ExcludedReason, string[]>
  details: string[]
}

/** Code-unit order (never a locale's). */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Converts the given icons (default: both pinned sets) into the served files and the report. */
export function generateIcons(source: readonly SourceIcon[] = readSourceIcons()): GeneratedIcons {
  const entries: IconIndexEntry[] = []
  const shards: Record<string, IconGeometry>[] = Array.from({ length: ICON_SHARD_COUNT }, () => ({}))
  const perSet = new Map<IconSetId, SetStats>()
  for (const set of ICON_SET_IDS) perSet.set(set, { total: 0, included: 0, excluded: new Map(), details: [] })
  const distances: [string, number][] = []
  let primitives = 0
  let maxPrimitives = 0
  let linePoints = 0
  for (const icon of source) {
    const stats = perSet.get(icon.set)
    if (!stats) continue
    stats.total++
    const exclude = (reason: ExcludedReason, detail?: string) => {
      const list = stats.excluded.get(reason) ?? []
      list.push(icon.name)
      stats.excluded.set(reason, list)
      if (detail) stats.details.push(`${icon.name}: ${reason} (${detail})`)
    }
    if (icon.category && EXCLUDED_TABLER_CATEGORIES.includes(icon.category) && icon.set === 'tabler') {
      exclude('brand')
      continue
    }
    if (icon.name.length > ICON_NAME_MAX || !ICON_NAME_PATTERN.test(icon.name)) {
      exclude('bad-name', 'not a lowercase dashed name')
      continue
    }
    const result = convertIcon(icon.nodes)
    if (!result.ok) {
      exclude(result.reason, result.detail)
      continue
    }
    stats.included++
    const shard = shardOf(icon.set, icon.name)
    const bucket = shards[shard] as Record<string, IconGeometry>
    bucket[iconKey(icon.set, icon.name)] = result.geometry
    entries.push([icon.set, icon.name, [...icon.tags], icon.category, shard])
    distances.push([iconKey(icon.set, icon.name), result.hausdorff ?? 0])
    primitives += result.geometry.length
    maxPrimitives = Math.max(maxPrimitives, result.geometry.length)
    for (const p of result.geometry) if (p.t === 'line') linePoints += p.p.length / 2
  }
  entries.sort((a, b) => byCodeUnits(a[0], b[0]) || byCodeUnits(a[1], b[1]))

  const shardFiles: GeneratedFile[] = shards.map((icons, shard) => {
    const sorted: Record<string, IconGeometry> = {}
    for (const key of Object.keys(icons).sort()) sorted[key] = icons[key] as IconGeometry
    const body: IconShard = { format: ICON_SHARD_FORMAT, version: ICON_SHARD_VERSION, shard, icons: sorted }
    const content = JSON.stringify(body)
    return { name: `shard-${shard}.${hash16(content)}.json`, content }
  })
  const index: IconIndex = {
    format: ICON_INDEX_FORMAT,
    version: ICON_INDEX_VERSION,
    sets: ICON_SET_IDS.map((id) => ({
      id,
      version: ICON_SET_PACKAGES[id].version,
      licence: ICON_SET_PACKAGES[id].licence as 'ISC' | 'MIT',
      count: perSet.get(id)?.included ?? 0,
    })),
    shards: shardFiles.map((f) => f.name),
    icons: entries,
  }
  const indexContent = JSON.stringify(index)
  const indexFile = `index.${hash16(indexContent)}.json`
  const licences = licencesText()
  const files: GeneratedFile[] = [
    { name: indexFile, content: indexContent },
    ...shardFiles,
    { name: 'LICENSES.txt', content: licences },
  ]

  const sortedD = distances.map((d) => d[1]).sort((a, b) => a - b)
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
  const shardSizes = shardFiles.map((f) => bytes(f.content))
  const report: IconBuildReport = {
    sets: ICON_SET_IDS.map((id) => {
      const s = perSet.get(id) as SetStats
      const excluded: Partial<Record<ExcludedReason, string[]>> = {}
      for (const reason of [...s.excluded.keys()].sort())
        excluded[reason] = [...(s.excluded.get(reason) ?? [])].sort()
      return {
        id,
        version: ICON_SET_PACKAGES[id].version,
        total: s.total,
        included: s.included,
        excluded,
        details: [...s.details].sort(),
      }
    }),
    fidelity: {
      mean: round4(sortedD.reduce((a, b) => a + b, 0) / Math.max(1, sortedD.length)),
      p50: round4(quantile(sortedD, 0.5)),
      p99: round4(quantile(sortedD, 0.99)),
      max: round4(sortedD[sortedD.length - 1] ?? 0),
      worst: [...distances]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 10)
        .map(([k, d]) => [k, round4(d)] as const),
    },
    primitives: { total: primitives, max: maxPrimitives, linePoints },
    sizes: {
      index: bytes(indexContent),
      shardsTotal: shardSizes.reduce((a, b) => a + b, 0),
      shardMin: Math.min(...shardSizes),
      shardMax: Math.max(...shardSizes),
      licences: bytes(licences),
    },
  }
  return { files, indexFile, index, report }
}

let cached: GeneratedIcons | undefined

/** generateIcons() of the pinned sets, once per process (a build, the dev server, a test file). */
export function pinnedIcons(): GeneratedIcons {
  cached ??= generateIcons()
  return cached
}

/** The report as lines of text (the build log, `pnpm --filter @draftroom/icon-sets report`). */
export function formatReport(report: IconBuildReport, opts: { names?: boolean } = {}): string {
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`
  const lines: string[] = []
  for (const s of report.sets) {
    const out = Object.entries(s.excluded)
      .map(([reason, names]) => `${reason} ${names?.length ?? 0}`)
      .join(', ')
    lines.push(`${s.id} ${s.version}: ${s.included} of ${s.total} icons${out ? ` (left out: ${out})` : ''}`)
    if (opts.names)
      for (const [reason, names] of Object.entries(s.excluded))
        if (reason !== 'brand') lines.push(`  ${reason}: ${(names ?? []).join(' ')}`)
  }
  const f = report.fidelity
  lines.push(`fidelity (Hausdorff, grid units): mean ${f.mean}, p50 ${f.p50}, p99 ${f.p99}, max ${f.max}`)
  const z = report.sizes
  const shards = `${ICON_SHARD_COUNT} shards ${kb(z.shardsTotal)} (${kb(z.shardMin)} to ${kb(z.shardMax)})`
  lines.push(`files: index ${kb(z.index)}, ${shards}, licences ${kb(z.licences)}`)
  return lines.join('\n')
}
