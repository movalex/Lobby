// Link previews (D2): what a page's <head> says about it. Untrusted HTML is never rendered or run: a
// tolerant scan of <title>, <meta> and <link> tags pulls out a title, a site name and icon links, and the
// text is decoded, stripped of control characters, collapsed and capped. The client shows it as text.

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

/** The <head> facts of `html` (only what comes before </head> or the first 512 KiB is read). */
export function parseHead(html: string): PageMeta {
  const end = html.search(/<\/head\s*>|<body[\s>]/i)
  const head = end >= 0 ? html.slice(0, end) : html
  // comments and scripts can hold anything that looks like a tag
  const scan = head
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const metas: Attrs[] = []
  const icons: IconLink[] = []
  let charset: string | null = null
  for (const m of scan.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    const a = attrsOf(m[0])
    if ((m[1] ?? '').toLowerCase() === 'meta') {
      metas.push(a)
      if (a.charset) charset = a.charset
      else if ((a['http-equiv'] ?? '').toLowerCase() === 'content-type') {
        charset = /charset=([\w.:-]+)/i.exec(a.content ?? '')?.[1] ?? charset
      }
      continue
    }
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/)
    if (a.href && (rel.includes('icon') || rel.includes('apple-touch-icon'))) {
      icons.push({
        href: a.href,
        rel: rel.join(' '),
        sizes: (a.sizes ?? '').toLowerCase(),
        type: a.type ?? '',
      })
    }
  }
  const meta = (key: string) =>
    metas.find((a) => (a.property ?? a.name ?? '').toLowerCase() === key && typeof a.content === 'string')
      ?.content ?? null
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(scan)?.[1] ?? null
  const rawTitle = meta('og:title') ?? meta('twitter:title') ?? titleTag
  const rawSite = meta('og:site_name') ?? meta('application-name')
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

/** Decodes a page's bytes with its charset (header first, then <meta>), UTF-8 when unknown. */
export function decodeHtml(body: Buffer, headerCharset: string | null): string {
  const sniff = body.subarray(0, 4096).toString('latin1')
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(sniff)?.[1] ?? null
  for (const label of [headerCharset, metaCharset, 'utf-8']) {
    if (!label) continue
    try {
      return new TextDecoder(label.toLowerCase(), { fatal: false }).decode(body)
    } catch {}
  }
  return body.toString('utf8')
}
