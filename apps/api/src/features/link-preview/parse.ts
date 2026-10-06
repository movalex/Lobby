// Link previews (D2): what a page's <head> says about it. Untrusted HTML is never rendered or run: a
// tolerant scan of <title>, <meta> and <link> tags pulls out a title, a site name and icon links, and the
// text is decoded, stripped of control characters, collapsed and capped. The client shows it as text.
// The scan is linear in the page and reads a bounded head (see "the <head> scan" below): the page is
// whatever the other side serves, and it is parsed on the api's event loop.

export const MAX_TITLE_CHARS = 200
export const MAX_SITE_CHARS = 80

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
  egrave: 'è',
  aacute: 'á',
  agrave: 'à',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
  ccedil: 'ç',
  ntilde: 'ñ',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return ''
      return String.fromCodePoint(code)
    }
    return NAMED[body.toLowerCase()] ?? all
  })
}

/** Plain, single-line, bounded text (control and bidi-override characters removed). */
export function cleanText(raw: string, max: number): string | null {
  const s = decodeEntities(raw)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return null
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

type Attrs = Record<string, string>

function attrsOf(tag: string): Attrs {
  const out: Attrs = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  // skip the tag name
  const body = tag.replace(/^<\s*[a-zA-Z]+/, '').replace(/\/?>$/, '')
  for (const m of body.matchAll(re)) {
    const name = (m[1] ?? '').toLowerCase()
    if (!name || name in out) continue
    out[name] = m[3] ?? m[4] ?? m[5] ?? ''
  }
  return out
}

export interface IconLink {
  readonly href: string
  readonly rel: string
  readonly sizes: string
  readonly type: string
}

export interface PageMeta {
  readonly title: string | null
  readonly siteName: string | null
  readonly icons: readonly IconLink[]
  /** a <meta charset> or http-equiv charset, when the page names one */
  readonly charset: string | null
}

// ---- the <head> scan -----------------------------------------------------------------------------------
//
// The page is the other side's: any bytes at all, up to the fetch's own limit (512 KiB). The scan below
// is ONE left-to-right pass that never looks back: every `<` is visited once, each construct it opens is
// skipped to its end with `indexOf` (a comment to `-->`, a script to its closing tag, a tag to `>`), and
// the position only moves forward, so the cost is linear in the page whatever it holds. (It used to be
// five regexes, each retried from every `<`: a page of `<!--` or `<meta ` repeated cost the square of its
// size, 13 and 19 seconds of the api's event loop for a 512 KiB page. J4, LP-REDOS.) On top of that the
// scan reads at most MAX_HEAD_CHARS of the page, looks at no tag longer than MAX_TAG_CHARS, keeps at most
// MAX_TAGS meta/link tags and MAX_ICONS icon links, and a `<title>` is cut to MAX_TITLE_SOURCE_CHARS
// before it is cleaned.

/** Most characters of a page's markup the scan reads (the fetch reads up to 512 KiB; a head is far smaller). */
export const MAX_HEAD_CHARS = 256 * 1024
/** A `<meta>` or `<link>` longer than this is skipped (no real one is: an og:description is a few hundred). */
export const MAX_TAG_CHARS = 16 * 1024
export const MAX_TAGS = 2_000
export const MAX_ICONS = 64
const MAX_TITLE_SOURCE_CHARS = 16 * 1024

const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13)
const isWord = (c: number) =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95

/** Where `</name` + optional whitespace + `>` ends (just past the `>`), or -1: `/>` was already consumed by the caller. */
function closeTagEnd(s: string, at: number): number {
  let k = at
  while (k < s.length && isSpace(s.charCodeAt(k))) k++
  return s.charCodeAt(k) === 62 ? k + 1 : -1
}

/** The closing tag `</name\s*>` (ASCII case-insensitive) at or after `from`: its start and end, or null. */
function findClosing(s: string, name: string, from: number): { start: number; end: number } | null {
  for (let j = s.indexOf('</', from); j !== -1; j = s.indexOf('</', j + 2)) {
    const nameEnd = j + 2 + name.length
    if (s.slice(j + 2, nameEnd).toLowerCase() !== name) continue
    const end = closeTagEnd(s, nameEnd)
    if (end !== -1) return { start: j, end }
  }
  return null
}

/** The <head> facts of `html` (what comes before </head> or <body>, and never more than MAX_HEAD_CHARS). */
export function parseHead(html: string): PageMeta {
  const s = html.length > MAX_HEAD_CHARS ? html.slice(0, MAX_HEAD_CHARS) : html
  const n = s.length
  const metas: Attrs[] = []
  const icons: IconLink[] = []
  let charset: string | null = null
  let titleRaw: string | null = null
  let titleLooked = false
  let tags = 0

  const meta = (a: Attrs) => {
    metas.push(a)
    if (a.charset) charset = a.charset
    else if ((a['http-equiv'] ?? '').toLowerCase() === 'content-type') {
      charset = /charset=([\w.:-]+)/i.exec(a.content ?? '')?.[1] ?? charset
    }
  }
  const link = (a: Attrs) => {
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/)
    if (a.href && (rel.includes('icon') || rel.includes('apple-touch-icon')) && icons.length < MAX_ICONS) {
      icons.push({
        href: a.href,
        rel: rel.join(' '),
        sizes: (a.sizes ?? '').toLowerCase(),
        type: a.type ?? '',
      })
    }
  }

  scan: for (let i = s.indexOf('<'); i !== -1 && i < n; ) {
    // a comment holds anything that looks like a tag; one that never ends swallows the rest (as a browser reads it)
    if (s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 4)
      if (e === -1) break
      i = s.indexOf('<', e + 3)
      continue
    }
    const closing = s.charCodeAt(i + 1) === 47
    let j = i + (closing ? 2 : 1)
    const nameStart = j
    while (j < n && isWord(s.charCodeAt(j))) j++
    const name = s.slice(nameStart, j).toLowerCase()
    if (closing) {
      if (name === 'head' && closeTagEnd(s, j) !== -1) break // the head is over
      i = s.indexOf('<', j)
      continue
    }
    switch (name) {
      case 'body':
        if (isSpace(s.charCodeAt(j)) || s.charCodeAt(j) === 62) break scan // the head is over
        break
      case 'script':
      case 'style':
      case 'noscript': {
        // their content is not markup; one that is never closed runs to the end of the page
        const close = findClosing(s, name, j)
        if (!close) break scan
        i = s.indexOf('<', close.end)
        continue
      }
      case 'meta':
      case 'link': {
        const gt = s.indexOf('>', j)
        if (gt === -1) break scan
        if (gt - i < MAX_TAG_CHARS && ++tags <= MAX_TAGS) {
          const a = attrsOf(s.slice(i, gt + 1))
          if (name === 'meta') meta(a)
          else link(a)
        }
        i = s.indexOf('<', gt + 1)
        continue
      }
      case 'title': {
        const gt = s.indexOf('>', j)
        if (gt === -1) break scan
        if (!titleLooked) {
          // the first <title> only; with no closing tag there is no title (and none is looked for again)
          titleLooked = true
          const close = findClosing(s, 'title', gt + 1)
          if (close) {
            titleRaw = s.slice(gt + 1, Math.min(close.start, gt + 1 + MAX_TITLE_SOURCE_CHARS))
            i = s.indexOf('<', close.end)
            continue
          }
        }
        i = s.indexOf('<', gt + 1)
        continue
      }
    }
    i = s.indexOf('<', j)
  }

  const find = (key: string) =>
    metas.find((a) => (a.property ?? a.name ?? '').toLowerCase() === key && typeof a.content === 'string')
      ?.content ?? null
  const rawTitle = find('og:title') ?? find('twitter:title') ?? titleRaw
  const rawSite = find('og:site_name') ?? find('application-name')
  return {
    title: rawTitle === null ? null : cleanText(rawTitle, MAX_TITLE_CHARS),
    siteName: rawSite === null ? null : cleanText(rawSite, MAX_SITE_CHARS),
    icons,
    charset,
  }
}

/**
 * The icon to fetch, best first: a PNG or ICO `icon` of 16-64 px, any other `icon`, then the
 * apple-touch-icon; `/favicon.ico` when the page names none. Absolute http(s) URLs only.
 */
export function iconCandidates(meta: PageMeta, base: URL): string[] {
  const score = (i: IconLink) => {
    const px = Number(/^(\d+)x\d+$/.exec(i.sizes.split(/\s+/)[0] ?? '')?.[1] ?? 0)
    const svg = /svg/i.test(i.type) || /\.svg(\?|$)/i.test(i.href)
    if (svg) return 9 // never fetched (see the route): last
    if (i.rel.includes('apple-touch-icon')) return 5
    if (px >= 16 && px <= 64) return 1
    if (px === 0) return 2
    return 3
  }
  const out: string[] = []
  for (const i of [...meta.icons].sort((a, b) => score(a) - score(b))) {
    if (score(i) === 9) continue
    try {
      const u = new URL(decodeEntities(i.href.trim()), base)
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !out.includes(u.href)) out.push(u.href)
    } catch {}
    if (out.length >= 2) break
  }
  const fallback = new URL('/favicon.ico', base).href
  if (!out.includes(fallback)) out.push(fallback)
  return out
}

/** The image type of an icon's bytes from their signature (never from the server's header), or null. */
export function iconType(b: Buffer): string | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp'
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4] ?? 0) > 0)
    return 'image/x-icon'
  return null
}

/**
 * The charset a `<meta>` in the first bytes names (`<meta charset=…>` or http-equiv), or null. One pass over
 * the tags, each looked at on its own (a pattern with `[^>]+` retried from every `<meta` is quadratic in
 * the 4 KiB it is given: J4, LP-REDOS).
 */
function sniffMetaCharset(sniff: string): string | null {
  for (let i = sniff.indexOf('<'); i !== -1; ) {
    if (sniff.slice(i + 1, i + 5).toLowerCase() === 'meta') {
      const gt = sniff.indexOf('>', i + 5)
      const tag = sniff.slice(i + 5, gt === -1 ? sniff.length : gt)
      const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(tag)
      if (m?.[1] && m.index > 0) return m[1]
      if (gt === -1) return null
      i = sniff.indexOf('<', gt + 1)
    } else i = sniff.indexOf('<', i + 1)
  }
  return null
}

/** Decodes a page's bytes with its charset (header first, then <meta>), UTF-8 when unknown. */
export function decodeHtml(body: Buffer, headerCharset: string | null): string {
  const metaCharset = sniffMetaCharset(body.subarray(0, 4096).toString('latin1'))
  for (const label of [headerCharset, metaCharset, 'utf-8']) {
    if (!label) continue
    try {
      return new TextDecoder(label.toLowerCase(), { fatal: false }).decode(body)
    } catch {}
  }
  return body.toString('utf8')
}
