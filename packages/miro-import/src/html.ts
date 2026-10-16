/**
 * Miro's item content (HTML: `<p>`, `<br>`, `<strong>`, `<a href>`, lists, entities) as plain text. Linear in the
 * input (one tokenising pass, no backtracking pattern), so a hostile megabyte costs milliseconds:
 *  - `<p>`, `<div>`, `<li>`, `<br>` and headings end a line (a list item starts with "• ");
 *  - every other tag is dropped, and the content of `<script>`, `<style>`, `<template>` and comments too;
 *  - entities are decoded (named ones Miro writes, decimal and hex), anything unknown is kept as typed;
 *  - control and bidirectional characters are removed (line breaks kept), whitespace runs inside a line folded;
 *  - the result is capped at `maxChars` (then `truncated`).
 * `formatted` says whether bold, italics, underline, strike-through, colour or a link were dropped; `links` lists
 * the `href`s of the links in order (the caller checks them before keeping one). Pure.
 */

export interface PlainText {
  readonly text: string
  readonly formatted: boolean
  readonly truncated: boolean
  readonly links: readonly string[]
}

const BREAK_TAGS = new Set([
  'p',
  'div',
  'li',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'tr',
  'blockquote',
  'ul',
  'ol',
])
const FORMAT_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'mark',
  'a',
  'span',
  'font',
  'code',
])
const SKIP_CONTENT = new Set(['script', 'style', 'template', 'textarea', 'title'])

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
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  times: '×',
}

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const cp =
        body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ''
      return String.fromCodePoint(cp)
    }
    return NAMED[body] ?? whole
  })
}

/** Bidirectional controls and isolates, zero-width space, BOM (the controls go with `\p{Cc}`). */
const BIDI = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Text with control and bidi characters removed (line breaks kept) and each line's whitespace folded. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/\t/g, ' ')
        .replace(/\p{Cc}/gu, '')
        .replace(BIDI, '')
        .replace(/[ \u00a0]+/g, ' ')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const TOKEN = /<!--|<\/?([a-zA-Z][a-zA-Z0-9]{0,15})\b([^<>]{0,1024})>|<|[^<]+/g

/** Miro HTML (or plain text) as plain text; see the module comment. */
export function htmlToText(input: unknown, maxChars: number): PlainText {
  if (typeof input !== 'string' || input.length === 0)
    return { text: '', formatted: false, truncated: false, links: [] }
  let out = ''
  let formatted = false
  const links: string[] = []
  let skipUntil: string | null = null
  // a hard ceiling on the work: 4x the cap of input characters is plenty for any real content
  const limit = Math.min(input.length, Math.max(maxChars * 4, 64 * 1024))
  const src = input.slice(0, limit)
  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    const tok = m[0]
    if (tok === '<!--') {
      const end = src.indexOf('-->', TOKEN.lastIndex)
      TOKEN.lastIndex = end < 0 ? src.length : end + 3
      continue
    }
    const tag = m[1]?.toLowerCase()
    if (tag) {
      const closing = tok[1] === '/'
      if (skipUntil) {
        if (closing && tag === skipUntil) skipUntil = null
        continue
      }
      if (!closing && SKIP_CONTENT.has(tag)) {
        skipUntil = tag
        continue
      }
      if (BREAK_TAGS.has(tag)) {
        // a block starts and ends a line (once: `</p><p>` is one break); `<br>` is always one
        if (tag === 'br') out += '\n'
        else if (out && !out.endsWith('\n')) out += '\n'
        if (tag === 'li' && !closing) out += '• '
        continue
      }
      if (FORMAT_TAGS.has(tag)) formatted = true
      if (tag === 'a' && !closing) {
        const href = /\bhref\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})')/i.exec(m[2] ?? '')
        const value = href ? decodeEntities(href[1] ?? href[2] ?? '').trim() : ''
        if (value && links.length < 20) links.push(value)
      }
      continue
    }
    if (skipUntil) continue
    out += tok === '<' ? '<' : decodeEntities(tok)
    if (out.length > maxChars * 2 + 1024) break
  }
  let text = cleanText(out)
  const truncated = text.length > maxChars || limit < input.length
  if (text.length > maxChars) text = text.slice(0, maxChars)
  return { text, formatted, truncated, links }
}
