// Bytes per npm package (or Lobby source folder) inside built chunks, from their source maps (the
// source-map-explorer method): every generated span is attributed to the source of its mapping segment;
// a chunk's gzip size is split in proportion to raw bytes. Used by A13 to estimate what a board route
// weighs once tldraw has left the app shell.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

/** Decodes one mappings line into segments [genCol, srcIndex?] (absolute values). */
function* segments(mappings: string): Generator<{ line: number; col: number; src: number | null }> {
  let line = 0
  let col = 0
  let src = 0
  let i = 0
  const fields: number[] = []
  while (i <= mappings.length) {
    const ch = mappings[i]
    if (ch === undefined || ch === ',' || ch === ';') {
      if (fields.length) {
        col += fields[0] ?? 0
        if (fields.length >= 4) {
          src += fields[1] ?? 0
          yield { line, col, src }
        } else yield { line, col, src: null }
      }
      fields.length = 0
      if (ch === ';') {
        line++
        col = 0
      }
      i++
      continue
    }
    // one VLQ value
    let value = 0
    let shift = 0
    for (;;) {
      const d = B64_INDEX.get(mappings[i++] ?? '') ?? 0
      value += (d & 31) << shift
      shift += 5
      if (!(d & 32)) break
    }
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
  }
}

/** node_modules/.pnpm/<x>/node_modules/@scope/name/... → @scope/name; Lobby code → lobby:<path part>. */
export function packageOf(source: string): string {
  const s = source.replace(/\\/g, '/')
  const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(s)
  if (m?.[1]) return m[1]
  const w = /(?:apps\/web\/)?src\/([^/]+)/.exec(s)
  if (w?.[1]) return `lobby:${w[1]}`
  const p = /packages\/([^/]+)/.exec(s)
  if (p?.[1]) return `lobby-pkg:${p[1]}`
  return s.startsWith('\0') || s.includes('vite/') || s.includes('rolldown')
    ? 'bundler-runtime'
    : `other:${s.slice(-40)}`
}

export interface Attribution {
  file: string
  raw: number
  gzip: number
  /** package → { raw bytes, estimated gzip bytes } */
  packages: Record<string, { raw: number; gzip: number }>
}

export function attribute(distDir: string, file: string): Attribution {
  const code = readFileSync(join(distDir, file), 'utf8')
  const raw = Buffer.byteLength(code)
  const gzip = gzipSync(code).length
  const mapFile = join(distDir, `${file}.map`)
  const packages: Attribution['packages'] = {}
  if (!existsSync(mapFile)) {
    packages['(no source map)'] = { raw, gzip }
    return { file, raw, gzip, packages }
  }
  const map = JSON.parse(readFileSync(mapFile, 'utf8')) as { sources: string[]; mappings: string }
  const lines = code.split('\n')
  const perSource = new Map<number, number>()
  let unmapped = 0
  const byLine = new Map<number, { col: number; src: number | null }[]>()
  for (const seg of segments(map.mappings)) {
    const list = byLine.get(seg.line) ?? []
    list.push(seg)
    byLine.set(seg.line, list)
  }
  lines.forEach((text, n) => {
    const segs = (byLine.get(n) ?? []).sort((a, b) => a.col - b.col)
    let covered = 0
    segs.forEach((s, k) => {
      const end = segs[k + 1]?.col ?? text.length
      const len = Math.max(0, Buffer.byteLength(text.slice(s.col, end)))
      covered += end - s.col
      if (s.src === null) unmapped += len
      else perSource.set(s.src, (perSource.get(s.src) ?? 0) + len)
    })
    const lead = segs[0]?.col ?? text.length
    if (lead > 0) unmapped += Buffer.byteLength(text.slice(0, lead))
    if (!segs.length && covered === 0) unmapped += 0
    unmapped += 1 // the newline
  })
  for (const [src, len] of perSource) {
    const pkg = packageOf(map.sources[src] ?? '')
    const e = packages[pkg] ?? { raw: 0, gzip: 0 }
    packages[pkg] = e
    e.raw += len
  }
  if (unmapped) packages['(unmapped)'] = { raw: unmapped, gzip: 0 }
  const total = Object.values(packages).reduce((a, p) => a + p.raw, 0) || 1
  for (const p of Object.values(packages)) p.gzip = Math.round((p.raw / total) * gzip)
  return { file, raw, gzip, packages }
}

/** The source package of each given UTF-16 offset of a built file (via its source map). */
export function packagesAtOffsets(distDir: string, file: string, offsets: number[]): string[] {
  const code = readFileSync(join(distDir, file), 'utf8')
  const mapFile = join(distDir, `${file}.map`)
  if (!existsSync(mapFile)) return offsets.map(() => '(no source map)')
  const map = JSON.parse(readFileSync(mapFile, 'utf8')) as { sources: string[]; mappings: string }
  const lineStarts = [0]
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const byLine = new Map<number, { col: number; src: number | null }[]>()
  for (const seg of segments(map.mappings)) {
    const list = byLine.get(seg.line) ?? []
    list.push(seg)
    byLine.set(seg.line, list)
  }
  for (const list of byLine.values()) list.sort((a, b) => a.col - b.col)
  return offsets.map((off) => {
    let line = 0
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((lineStarts[mid] ?? 0) <= off) {
        line = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    const col = off - (lineStarts[line] ?? 0)
    const segs = byLine.get(line) ?? []
    let best: { col: number; src: number | null } | undefined
    for (const s of segs) {
      if (s.col > col) break
      best = s
    }
    return best?.src === null || best === undefined ? '(unmapped)' : packageOf(map.sources[best.src] ?? '')
  })
}

/** Sum of attributions over files: package → gzip bytes. */
export function packagesOf(
  distDir: string,
  files: Iterable<string>,
): Record<string, { raw: number; gzip: number }> {
  const out: Record<string, { raw: number; gzip: number }> = {}
  for (const f of files) {
    if (!f.endsWith('.js')) continue
    for (const [pkg, v] of Object.entries(attribute(distDir, f).packages)) {
      const e = out[pkg] ?? { raw: 0, gzip: 0 }
      out[pkg] = e
      e.raw += v.raw
      e.gzip += v.gzip
    }
  }
  return out
}
