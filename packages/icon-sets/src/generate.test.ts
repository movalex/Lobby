// The generated icon files over EVERY icon of both pinned sets (OWNER: WS1, wave Q; docs/WAVE-Q-CONTRACTS.md §7):
// the index and the 64 shards match their contract schemas and each other; every included icon is within the caps
// and within ICON_MAX_HAUSDORFF of its densely sampled source (measured again here, apart from the generator); the
// icons left out are exactly the listed ones, for the listed reasons; and a checksum pins the output per pinned
// version. A converter change that moves any coordinate changes the checksum: check the report
// (`pnpm --filter @draftroom/icon-sets report --names`) and the fidelity, then update CHECKSUMS below.
import { createHash } from 'node:crypto'
import {
  ICON_GRID_MAX,
  ICON_GRID_MIN,
  ICON_INDEX_FILE_PATTERN,
  ICON_MAX_LINE_POINTS,
  ICON_MAX_PRIMITIVES,
  ICON_SHARD_COUNT,
  ICON_SHARD_FILE_PATTERN,
  IconIndex,
  IconShard,
  iconKey,
} from '@draftroom/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import { referenceOf } from './convert.ts'
import {
  type GeneratedIcons,
  generateIcons,
  pinnedIcons,
  readSourceIcons,
  type SourceIcon,
  shardOf,
} from './generate.ts'
import { ICON_SET_PACKAGES } from './index.ts'
import { drawn, hausdorff, ICON_MAX_HAUSDORFF } from './measure.ts'

/** sha256 of every generated file (name, content), per pinned versions `lucide@x+tabler@y`. */
const CHECKSUMS: Readonly<Record<string, string>> = {
  'lucide@1.49.0+tabler@3.48.0': 'bcb43432e62d2bbb4cd6f5556109a097452e6fa50cc44abc1b2cc2cc83024efb',
}

/** The icons left out of each set, by reason (Brand is counted: 376 trademarks). */
const EXCLUDED = {
  lucide: {
    'too-many-parts': [
      'brain-circuit',
      'brain-cog',
      'calendar-cog',
      'cog',
      'cpu',
      'germ-off',
      'hourglass-cog',
      'notepad-text-dashed',
      'square-dashed-kanban',
      'square-dashed-plus',
      'square-dashed-text',
      'square-dashed-x',
      'virus',
      'virus-off',
    ],
  },
  tabler: {
    'fill-only-part': [
      'percentage-10',
      'percentage-20',
      'percentage-25',
      'percentage-30',
      'percentage-33',
      'percentage-40',
      'percentage-50',
      'percentage-60',
      'percentage-66',
      'percentage-70',
      'percentage-75',
      'percentage-80',
      'percentage-90',
    ],
    'too-many-parts': [
      'adjustments-cog',
      'barrier-block-off',
      'border-bottom',
      'border-bottom-plus',
      'border-horizontal',
      'border-inner',
      'border-left',
      'border-left-plus',
      'border-none',
      'border-right',
      'border-right-plus',
      'border-top',
      'border-top-plus',
      'border-vertical',
      'box-margin',
      'building-cog',
      'chart-grid-dots',
      ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `circle-dotted-letter-${c}`),
      'container-off',
      'cpu-2',
      'cpu-off',
      'deselect',
      'eye-dotted',
      'go-game',
      'live-photo',
      'live-photo-off',
      'marquee-off',
      'password-fingerprint',
      'reduce-motion',
      'roulette',
      'select-all',
      'snowflake-off',
      'time-duration-0',
      'topology-full-hierarchy',
      'topology-star-3',
      'topology-star-ring',
      'topology-star-ring-2',
      'topology-star-ring-3',
      'virus',
      'virus-off',
      'virus-search',
    ],
  },
} as const

let generated: GeneratedIcons
let sources: SourceIcon[]

beforeAll(() => {
  generated = pinnedIcons()
  sources = readSourceIcons()
  // the generation: about 4 s alone, more under the full suite's load
}, 120_000)

const shardFiles = () => generated.files.filter((f) => ICON_SHARD_FILE_PATTERN.test(f.name))

describe('the generated icon files', () => {
  it('are the index, 64 shards and LICENSES.txt, each named by its content', () => {
    const names = generated.files.map((f) => f.name)
    expect(names[0]).toBe(generated.indexFile)
    expect(generated.indexFile).toMatch(ICON_INDEX_FILE_PATTERN)
    expect(shardFiles()).toHaveLength(ICON_SHARD_COUNT)
    expect(names.at(-1)).toBe('LICENSES.txt')
    expect(names).toHaveLength(ICON_SHARD_COUNT + 2)
    for (const f of generated.files) {
      if (f.name === 'LICENSES.txt') continue
      const hash = /\.([0-9a-f]{16})\.json$/.exec(f.name)?.[1]
      expect(hash, f.name).toBe(createHash('sha256').update(f.content).digest('hex').slice(0, 16))
    }
  })

  it('hold an index that matches its schema, sorted by set and name, one entry per icon, naming the shards', () => {
    const index = IconIndex.parse(JSON.parse(generated.files[0]?.content ?? ''))
    expect(index.shards).toEqual(shardFiles().map((f) => f.name))
    for (const [n, name] of index.shards.entries())
      expect(ICON_SHARD_FILE_PATTERN.exec(name)?.[1]).toBe(String(n))
    const keys = index.icons.map(([set, name]) => iconKey(set, name))
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(keys)
    for (const s of index.sets) {
      expect(s.version).toBe(ICON_SET_PACKAGES[s.id].version)
      expect(s.count).toBe(index.icons.filter((e) => e[0] === s.id).length)
    }
    // Lucide has no categories; Tabler's 41 without Brand
    expect(index.icons.filter((e) => e[0] === 'lucide').every((e) => e[3] === null)).toBe(true)
    const categories = new Set(index.icons.filter((e) => e[0] === 'tabler').map((e) => e[3]))
    expect(categories.size).toBe(40)
    expect(categories.has('Brand')).toBe(false)
  })

  it('hold shards that match their schema, each with exactly the icons the index files under it', () => {
    const inIndex = new Map(generated.index.icons.map((e) => [iconKey(e[0], e[1]), e[4]]))
    const seen = new Set<string>()
    for (const [n, f] of shardFiles().entries()) {
      const shard = IconShard.parse(JSON.parse(f.content))
      expect(shard.shard).toBe(n)
      for (const key of Object.keys(shard.icons)) {
        expect(inIndex.get(key), key).toBe(n)
        const [set, name] = key.split(':') as ['lucide' | 'tabler', string]
        expect(shardOf(set, name)).toBe(n)
        seen.add(key)
      }
    }
    expect(seen.size).toBe(inIndex.size)
  })

  it('convert EVERY included icon within the caps and within 0.15 grid units of its densely sampled source', () => {
    const bySource = new Map(sources.map((s) => [iconKey(s.set, s.name), s]))
    let worst = 0
    let measured = 0
    for (const f of shardFiles()) {
      const shard = IconShard.parse(JSON.parse(f.content))
      for (const [key, geometry] of Object.entries(shard.icons)) {
        expect(geometry.length, key).toBeLessThanOrEqual(ICON_MAX_PRIMITIVES)
        for (const p of geometry) {
          if (p.t !== 'line') continue
          expect(p.p.length / 2, key).toBeLessThanOrEqual(ICON_MAX_LINE_POINTS)
          const onGrid = (v: number) => v >= ICON_GRID_MIN && v <= ICON_GRID_MAX && Number(v.toFixed(2)) === v
          expect(p.p.every(onGrid), key).toBe(true)
        }
        const source = bySource.get(key)
        if (!source) throw new Error(`${key} has no source`)
        const d = hausdorff(referenceOf(source.nodes), geometry.flatMap(drawn))
        if (!(d <= ICON_MAX_HAUSDORFF)) throw new Error(`${key} is ${d} units from its source`)
        worst = Math.max(worst, d)
        measured++
      }
    }
    expect(measured).toBe(generated.index.icons.length)
    expect(worst).toBeCloseTo(generated.report.fidelity.max, 3)
  })

  it('leave out exactly the listed icons: Brand (trademarks), fill-only parts, more than 12 parts', () => {
    const lucide = generated.report.sets.find((s) => s.id === 'lucide')
    const tabler = generated.report.sets.find((s) => s.id === 'tabler')
    expect(lucide?.excluded).toEqual(EXCLUDED.lucide)
    const { brand, ...rest } = tabler?.excluded ?? {}
    expect(rest).toEqual(EXCLUDED.tabler)
    expect(brand).toHaveLength(376)
    expect(lucide?.total).toBe(1857)
    expect(tabler?.total).toBe(5166)
    expect(lucide?.included).toBe(1857 - 14)
    expect(tabler?.included).toBe(5166 - 376 - 13 - 66)
    // each set: included + excluded = total
    for (const s of generated.report.sets) {
      const out = Object.values(s.excluded).reduce((a, names) => a + (names?.length ?? 0), 0)
      expect(s.included + out).toBe(s.total)
    }
  })

  it('ship both licence texts in LICENSES.txt', () => {
    const txt = generated.files.at(-1)?.content ?? ''
    expect(txt).toMatch(/lucide-static 1\.49\.0 \(ISC\)/)
    expect(txt).toMatch(/ISC License/)
    expect(txt).toMatch(/Cole Bemis/)
    expect(txt).toMatch(/@tabler\/icons 3\.48\.0 \(MIT\)/)
    expect(txt).toMatch(/MIT License/)
  })

  it('are a pure function of the pinned packages: generated again, byte for byte the same, at the pinned checksum', () => {
    const again = generateIcons()
    expect(again.files.map((f) => f.name)).toEqual(generated.files.map((f) => f.name))
    expect(again.files.every((f, n) => f.content === generated.files[n]?.content)).toBe(true)
    const h = createHash('sha256')
    for (const f of generated.files) h.update(f.name).update('\0').update(f.content).update('\0')
    const versions = `lucide@${ICON_SET_PACKAGES.lucide.version}+tabler@${ICON_SET_PACKAGES.tabler.version}`
    expect(h.digest('hex'), versions).toBe(CHECKSUMS[versions])
  })
})
