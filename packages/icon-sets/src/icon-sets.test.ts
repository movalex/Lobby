// The wave Q dependency commit (OWNER: WS1 after the foundation): the two pinned icon packages are installed at the
// catalog's exact versions, carry their stated licence and no install script or dependency, hold the data files the
// generator reads where ./index.ts says, and their licence texts ship in this package byte for byte.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ICON_SET_IDS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { ICON_SETS_ROOT, iconSetFile, iconSetRoot, readIconSetJson } from './files.ts'
import { ICON_SET_PACKAGES, type IconNode, type TablerIconMeta } from './index.ts'

const text = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

/** The catalog's pin of a package (pnpm-workspace.yaml). */
function catalogPin(name: string): string | undefined {
  const yaml = text(join(ICON_SETS_ROOT, '../../pnpm-workspace.yaml'))
  const quoted = name.startsWith('@') ? `'${name}'` : name
  const line = yaml.split('\n').find((l) => l.startsWith(`  ${quoted}: `))
  return line?.slice(`  ${quoted}: `.length).trim()
}

describe('the pinned icon packages', () => {
  it('cover both sets, each an exact catalog pin this package depends on through catalog:', () => {
    expect(Object.keys(ICON_SET_PACKAGES).sort()).toEqual([...ICON_SET_IDS].sort())
    const own = json(join(ICON_SETS_ROOT, 'package.json')) as { dependencies: Record<string, string> }
    for (const id of ICON_SET_IDS) {
      const p = ICON_SET_PACKAGES[id]
      expect(p.id).toBe(id)
      expect(catalogPin(p.packageName), p.packageName).toBe(p.version)
      expect(own.dependencies[p.packageName], p.packageName).toBe('catalog:')
    }
    expect(ICON_SET_PACKAGES.lucide.version).toBe('1.49.0')
    expect(ICON_SET_PACKAGES.tabler.version).toBe('3.48.0')
  })

  it('are installed at that version with that licence, no dependencies and no install scripts', () => {
    for (const id of ICON_SET_IDS) {
      const p = ICON_SET_PACKAGES[id]
      const pkg = json(join(iconSetRoot(id), 'package.json')) as {
        name: string
        version: string
        license: string
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
        bin?: unknown
      }
      expect(pkg.name).toBe(p.packageName)
      expect(pkg.version).toBe(p.version)
      expect(pkg.license).toBe(p.licence)
      for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'])
        expect(pkg.scripts?.[hook], `${p.packageName} ${hook}`).toBeUndefined()
      for (const deps of [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies])
        expect(Object.keys(deps ?? {}), p.packageName).toEqual([])
      expect(pkg.bin, p.packageName).toBeUndefined()
    }
  })

  it('ship their LICENSE texts here, byte for byte (line endings aside)', () => {
    for (const id of ICON_SET_IDS) {
      const p = ICON_SET_PACKAGES[id]
      const shipped = text(join(ICON_SETS_ROOT, p.licenceFile))
      expect(shipped, p.packageName).toBe(text(iconSetFile(id, 'LICENSE')))
    }
    expect(text(join(ICON_SETS_ROOT, ICON_SET_PACKAGES.lucide.licenceFile))).toMatch(/^ISC License/)
    // Lucide's Feather-derived icons are MIT, in the same file
    expect(text(join(ICON_SETS_ROOT, ICON_SET_PACKAGES.lucide.licenceFile))).toMatch(/Cole Bemis/)
    expect(text(join(ICON_SETS_ROOT, ICON_SET_PACKAGES.tabler.licenceFile))).toMatch(/^MIT License/)
  })

  it('keep their data where index.ts says: Lucide nodes and tags; Tabler outline nodes, categories and tags', () => {
    const lucideNodes = readIconSetJson('lucide', ICON_SET_PACKAGES.lucide.nodesFile) as Record<
      string,
      IconNode[]
    >
    const lucideTags = readIconSetJson('lucide', ICON_SET_PACKAGES.lucide.metaFile) as Record<
      string,
      string[]
    >
    // 1.49.0: 1,857 icons, every one tagged; no categories in the package
    expect(Object.keys(lucideNodes)).toHaveLength(1857)
    expect(Object.keys(lucideTags).sort()).toEqual(Object.keys(lucideNodes).sort())
    const lucideElements = new Set(Object.values(lucideNodes).flatMap((n) => n.map(([el]) => el)))
    expect([...lucideElements].sort()).toEqual([
      'circle',
      'ellipse',
      'line',
      'path',
      'polygon',
      'polyline',
      'rect',
    ])
    const tablerNodes = readIconSetJson('tabler', ICON_SET_PACKAGES.tabler.nodesFile) as Record<
      string,
      IconNode[]
    >
    const tablerMeta = readIconSetJson('tabler', ICON_SET_PACKAGES.tabler.metaFile) as Record<
      string,
      TablerIconMeta
    >
    // 3.48.0: 5,166 outline icons in 41 categories (376 of them are brand logos, category 'Brand')
    expect(Object.keys(tablerNodes)).toHaveLength(5166)
    expect(Object.keys(tablerMeta).sort()).toEqual(Object.keys(tablerNodes).sort())
    const categories = new Set(Object.values(tablerMeta).map((m) => m.category))
    expect(categories.size).toBe(41)
    expect(Object.values(tablerMeta).every((m) => m.styles.outline !== undefined)).toBe(true)
    expect(Object.values(tablerMeta).filter((m) => m.category === 'Brand')).toHaveLength(376)
    const tablerElements = new Set(Object.values(tablerNodes).flatMap((n) => n.map(([el]) => el)))
    expect([...tablerElements]).toEqual(['path'])
  })
})
