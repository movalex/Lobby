// Build-output analysis for spike checks A12 (host grep) and A13 (bundle size): route file sets from the
// Vite manifest (`vite build --manifest`), gzip sizes, and the foreign-host scan of the host-rewrite
// plugin (apps/web/build/excalidraw-host-rewrite.ts), applied to built files.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import {
  type HostHit,
  hostsInLiteral,
  literalRanges,
  NON_REQUEST_HOSTS,
  REWRITTEN_HOSTS,
} from '../../../apps/web/build/excalidraw-host-rewrite.ts'

export { NON_REQUEST_HOSTS, REWRITTEN_HOSTS }

/**
 * Foreign hosts named in a built file's literals (strings, templates, regexes), found with the same
 * parser and rules as the plugin; comments (license notices) are not code and are not counted. CSS:
 * url() values. A file that does not parse is scanned as plain text.
 */
export function hostsInFile(file: string, code: string): HostHit[] {
  if (file.endsWith('.css')) {
    return [...code.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)].flatMap((m) => hostsInLiteral(m[0]))
  }
  if (!/\.m?js$/.test(file)) return []
  const ranges = literalRanges(file, code)
  if (!ranges) return hostsInLiteral(code)
  return ranges.flatMap(([s, e]) => hostsInLiteral(code.slice(s, e)))
}

export interface ManifestChunk {
  file: string
  src?: string
  isEntry?: boolean
  isDynamicEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
  assets?: string[]
}
export type Manifest = Record<string, ManifestChunk>

export function readManifest(distDir: string): Manifest {
  return JSON.parse(readFileSync(join(distDir, '.vite', 'manifest.json'), 'utf8')) as Manifest
}

/** The manifest key whose source path ends with `suffix` (e.g. 'src/board/BoardPage.tsx'). */
export function keyFor(m: Manifest, suffix: string): string {
  const k = Object.keys(m).find((key) => key.replace(/\\/g, '/').endsWith(suffix))
  if (!k) throw new Error(`no manifest entry ends with ${suffix}`)
  return k
}

/**
 * Files a route loads: the static-import closure (JS + CSS) of `keys`. With `dynamic`, dynamic imports
 * are followed too (what the route can load later, on use).
 */
export function closure(m: Manifest, keys: string[], dynamic = false): { js: Set<string>; css: Set<string> } {
  const js = new Set<string>()
  const css = new Set<string>()
  const seen = new Set<string>()
  const visit = (key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    const c = m[key]
    if (!c) return
    if (c.file.endsWith('.js')) js.add(c.file)
    for (const f of c.css ?? []) css.add(f)
    for (const i of c.imports ?? []) visit(i)
    if (dynamic) for (const i of c.dynamicImports ?? []) visit(i)
  }
  for (const k of keys) visit(k)
  return { js, css }
}

export interface SizeRow {
  file: string
  raw: number
  gzip: number
  gzip9: number
  brotli: number
}

export function sizeOf(distDir: string, file: string): SizeRow {
  const buf = readFileSync(join(distDir, file))
  return {
    file,
    raw: buf.length,
    gzip: gzipSync(buf).length, // zlib default level (6)
    gzip9: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  }
}

export interface SizeSummary {
  files: number
  raw: number
  gzip: number
  gzip9: number
  brotli: number
  rows: SizeRow[]
}

export function sumSizes(distDir: string, files: Iterable<string>): SizeSummary {
  const rows = [...files].map((f) => sizeOf(distDir, f)).sort((a, b) => b.gzip - a.gzip)
  const sum = (k: 'raw' | 'gzip' | 'gzip9' | 'brotli') => rows.reduce((a, r) => a + r[k], 0)
  return {
    files: rows.length,
    raw: sum('raw'),
    gzip: sum('gzip'),
    gzip9: sum('gzip9'),
    brotli: sum('brotli'),
    rows,
  }
}

export const kib = (n: number) => Math.round((n / 1024) * 10) / 10

export function* walk(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

export interface HostInventory {
  /** host → { hits, files } */
  hosts: Record<string, { hits: number; files: string[]; kinds: string[] }>
}

/** Every foreign host (literal text, outside license comments) in the given files of a dist folder. */
export function inventory(distDir: string, files?: Iterable<string>): HostInventory {
  const list = files ? [...files].map((f) => join(distDir, f)) : [...walk(distDir)]
  const hosts: HostInventory['hosts'] = {}
  for (const p of list) {
    if (!/\.(m?js|css|html)$/.test(p)) continue
    const rel = relative(distDir, p).replace(/\\/g, '/')
    const hits = hostsInFile(p, readFileSync(p, 'utf8'))
    for (const h of hits) {
      const e = hosts[h.host] ?? { hits: 0, files: [], kinds: [] }
      hosts[h.host] = e
      e.hits++
      if (!e.files.includes(rel)) e.files.push(rel)
      if (!e.kinds.includes(h.kind)) e.kinds.push(h.kind)
    }
  }
  return { hosts }
}
