// Lobby's own `@font-face` rules for SVG export (docs/EXCALIDRAW-MIGRATION.md §2.10.4 "Fonts in SVG",
// §2.12; spike A12). Excalidraw's own font inlining subsets glyphs in WebAssembly through Emscripten glue
// that calls `new Function` (chunk-Z5NKEFVG), so under Lobby's CSP it would need `'unsafe-eval'`. Lobby
// does not add that: the exporter calls `exportToSvg` with `skipInliningFonts: true` and adds these
// rules itself, embedding as `data:` URLs only the self-hosted woff2 files whose `unicode-range` covers
// the exported characters: subsetting by FILE, with no WebAssembly and no eval.
//
// Pure (no DOM, no engine import): the face list is read from the engine at export time (svg.ts reads
// `Fonts.registered`: the same faces Excalidraw registers, with their same-origin URLs after the host
// rewrite) and handed in here as plain data, so this file is unit-tested in Node.

/**
 * Lobby's families (§3.5: the server refuses any other `fontFamily`): the server's own allowlist, so this list
 * cannot fall behind it (it said [5, 6, 8] after D3 added Lilita One, 7, at wave 5).
 */
export { LOBBY_FONT_FAMILIES } from '@draftroom/canvas-schema/limits'

/** One registered face as the exporter needs it. */
export interface FaceInfo {
  /** the CSS family name the SVG's `font-family` attribute uses (`Nunito`, `Excalifont`, `Comic Shanns`, `Xiaolai`) */
  readonly family: string
  /** its first URL (Lobby's self-hosted `/excalidraw-assets/fonts/…` file) */
  readonly url: string
  /** CSS unicode-range, e.g. `U+20-7e, U+a1-a6` (empty: the whole range) */
  readonly unicodeRange: string
  readonly weight: string
  readonly style: string
}

/** A registered family (by Excalidraw's numeric id): its faces, and whether it is a local (system) font. */
export interface FamilyInfo {
  readonly faces: readonly FaceInfo[]
  readonly local: boolean
}

export type Ranges = readonly (readonly [number, number])[]

/** Parses a CSS `unicode-range` (`U+20-7e`, `U+00A0`, `U+4??`), case-insensitive; empty = everything. */
export function parseUnicodeRange(range: string): Ranges {
  const out: [number, number][] = []
  for (const raw of range.split(',')) {
    const part = raw.trim().toUpperCase()
    if (!part) continue
    const m = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/.exec(part)
    if (!m?.[1]) continue
    if (m[1].includes('?')) {
      out.push([Number.parseInt(m[1].replace(/\?/g, '0'), 16), Number.parseInt(m[1].replace(/\?/g, 'F'), 16)])
    } else {
      const lo = Number.parseInt(m[1], 16)
      out.push([lo, m[2] ? Number.parseInt(m[2], 16) : lo])
    }
  }
  return out.length ? out : [[0, 0x10ffff]]
}

export const inRanges = (cp: number, ranges: Ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

/** The text of the exported text elements per family (bound labels included; `originalText`, as Excalidraw's own). */
export function charsPerFamily(
  elements: Iterable<{ type: string; isDeleted?: boolean; fontFamily?: unknown; originalText?: unknown }>,
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>()
  for (const el of elements) {
    if (el.type !== 'text' || el.isDeleted || typeof el.fontFamily !== 'number') continue
    if (typeof el.originalText !== 'string') continue
    const set = out.get(el.fontFamily) ?? new Set<string>()
    for (const ch of el.originalText) if (!/\s/u.test(ch)) set.add(ch)
    out.set(el.fontFamily, set)
  }
  return out
}

/**
 * The faces to embed: for each exported family, and then each of its fallbacks in the order the SVG's
 * `font-family` list names them (Excalifont's is Xiaolai, for CJK), every face whose range covers a
 * character no earlier family covered. A character no face covers is left to the viewer's fonts.
 */
export function selectFaces(
  chars: ReadonlyMap<number, ReadonlySet<string>>,
  registered: ReadonlyMap<number, FamilyInfo>,
  fallbacksOf: (family: number) => readonly number[],
): FaceInfo[] {
  const picked = new Map<string, FaceInfo>()
  for (const [family, set] of chars) {
    let left = [...set]
    for (const fam of [family, ...fallbacksOf(family)]) {
      if (!left.length) break
      const info = registered.get(fam)
      if (!info || info.local) continue
      const covered = new Set<string>()
      for (const face of info.faces) {
        const ranges = parseUnicodeRange(face.unicodeRange)
        const hits = left.filter((ch) => inRanges(ch.codePointAt(0) ?? 0, ranges))
        if (!hits.length) continue
        picked.set(`${face.family}|${face.url}`, face)
        for (const h of hits) covered.add(h)
      }
      left = left.filter((ch) => !covered.has(ch))
    }
  }
  return [...picked.values()]
}

const cssString = (s: string) => `"${s.replace(/["\\\n\r]/g, '')}"`

/** One `@font-face` rule with the woff2 embedded as a `data:` URL. */
export function fontFaceRule(face: FaceInfo, dataUrl: string): string {
  const range = face.unicodeRange.trim()
  return (
    `@font-face { font-family: ${cssString(face.family)}; src: url("${dataUrl}") format("woff2"); ` +
    `font-weight: ${face.weight || '400'}; font-style: ${face.style || 'normal'}; font-display: swap;` +
    `${range ? ` unicode-range: ${range};` : ''} }`
  )
}

const okRef = (ref: string) =>
  !ref || ref.startsWith('data:') || ref.startsWith('#') || ref.startsWith('http://www.w3.org/')

const urlRefs = (css: string) =>
  [...css.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/g)].map((m) => (m[2] ?? '').trim())

/**
 * Why an exported SVG would not stand alone: every `href`/`src` attribute and every CSS `url()` (in
 * `<style>` and `style=""`) must be a `data:` URL or a same-document `#ref`. Returns the offending
 * references (at most 80 characters each), or []. Text content is never scanned: XMLSerializer escapes
 * `<` in text nodes, so tags are only markup.
 */
export function selfContainedProblems(svgText: string): string[] {
  const problems: string[] = []
  const add = (ref: string) => {
    if (!okRef(ref)) problems.push(ref.slice(0, 80))
  }
  for (const tag of svgText.matchAll(/<[^!?/][^>]*>/g)) {
    const t = tag[0]
    for (const m of t.matchAll(/\s(?:[\w-]+:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      add((m[1] ?? m[2] ?? '').trim())
    for (const m of t.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      for (const r of urlRefs(m[1] ?? m[2] ?? '')) add(r)
  }
  for (const m of svgText.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
    for (const r of urlRefs(m[1] ?? '')) add(r)
  return problems
}

/**
 * Wave N (WS6, the vector PDF): the id of the `<metadata>` element a `fonts: 'names'` SVG carries instead of
 * `@font-face` rules. Its text is JSON `{"v":1,"faces":[FaceInfo…]}`: the faces `fontFaceRules` would embed, with
 * their same-origin paths, so the PDF worker fetches and embeds (subsets of) exactly those files itself.
 */
export const FACES_METADATA_ID = 'lobby-pdf-faces'

/**
 * The faces whose files are on `origin`, with their URLs as same-origin PATHS (the 'names' face table; a foreign
 * face, which the host rewrite never leaves, is dropped: no request ever leaves Lobby's origin).
 */
export function sameOriginFaces<F extends FaceInfo>(faces: readonly F[], origin: string): F[] {
  const out: F[] = []
  for (const face of faces) {
    const url = face.url
    if (url.startsWith('/') && !url.startsWith('//')) {
      out.push(face)
      continue
    }
    try {
      const u = new URL(url)
      if (u.origin === origin) out.push({ ...face, url: u.pathname })
    } catch {
      // not a URL: left out
    }
  }
  return out
}

/** A face of the 'names' table; `any`: a last resort for characters no family of their own covers (CJK). */
export interface NamedFace extends FaceInfo {
  readonly any?: true
}

/**
 * The faces of a 'names' SVG: `selectFaces`' (each family and its own fallbacks, as the 'embedded' SVG), then, for
 * characters still uncovered, the faces of `lastResort` families marked `any` (Lobby's own CJK font for text in
 * Nunito or Lilita One, whose CJK the board draws with a system font: the PDF then has real, searchable CJK text in
 * Lobby's CJK font instead of a picture of it).
 */
export function namedFacesOf(
  chars: ReadonlyMap<number, ReadonlySet<string>>,
  registered: ReadonlyMap<number, FamilyInfo>,
  fallbacksOf: (family: number) => readonly number[],
  lastResort: readonly number[],
): NamedFace[] {
  const own = selectFaces(chars, registered, fallbacksOf)
  const ranges = new Map(own.map((f) => [f, parseUnicodeRange(f.unicodeRange)]))
  const covered = (family: number, ch: string) => {
    const names = new Set(
      [family, ...fallbacksOf(family)].flatMap((id) => registered.get(id)?.faces.map((f) => f.family) ?? []),
    )
    const cp = ch.codePointAt(0) ?? 0
    return own.some((f) => names.has(f.family) && inRanges(cp, ranges.get(f) as Ranges))
  }
  const left = new Map<number, Set<string>>()
  for (const [family, set] of chars) {
    const rest = new Set([...set].filter((ch) => !covered(family, ch)))
    if (rest.size) left.set(-1 - left.size, rest)
  }
  const extra = left.size ? selectFaces(left, registered, () => lastResort) : []
  const seen = new Set(own.map((f) => `${f.family}|${f.url}`))
  // every face of a last-resort family is marked, also one a family listed itself (Excalifont's Xiaolai)
  const resort = new Set(lastResort.flatMap((id) => registered.get(id)?.faces.map((f) => f.family) ?? []))
  return [...own, ...extra.filter((f) => !seen.has(`${f.family}|${f.url}`))].map(
    (f): NamedFace => (resort.has(f.family) ? { ...f, any: true } : f),
  )
}

/** The face table a 'names' SVG carries (JSON in its FACES_METADATA_ID element). */
export function facesTable(faces: readonly NamedFace[]): { v: 1; faces: NamedFace[] } {
  return {
    v: 1,
    faces: faces.map((f) => ({
      family: f.family,
      url: f.url,
      unicodeRange: f.unicodeRange,
      weight: f.weight,
      style: f.style,
      ...(f.any ? { any: true as const } : {}),
    })),
  }
}

/** ArrayBuffer → `data:font/woff2;base64,…` (no FileReader needed). */
export function woff2DataUrl(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return `data:font/woff2;base64,${btoa(bin)}`
}
