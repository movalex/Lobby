// OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2). Markdown-lite: the words of a doc card's label, read as
// a small Markdown subset. Pure and dependency-free: it returns a tree of plain data (never HTML), which DocFace.tsx
// turns into React nodes and export.ts into SVG text. Nothing here ever builds markup from the words.
//
// What it reads, one source line at a time (a doc card's words are plain text everywhere else: an old tab, exports,
// search and Ask read the same characters):
//   `# `, `## `, `### `  headings (level 1 to 3)
//   `- `, `* `, `+ `      bullet items; `- [ ] ` and `- [x] ` checklist items; `1. ` (or `1) `) numbered items;
//                         two spaces (or a tab) of indent per nesting level, at most MAX_INDENT levels
//   `> `                  a quote line
//   `---` (or `***`, `___`, three or more alone on a line)  a rule
//   anything else         a paragraph line; an empty line is an empty line (the plain-text layout keeps it too)
// and inside a line: `**strong**`, `_emphasis_` (at word edges, so snake_case stays as it is), `` `code` ``, and
// `[text](url)`. A link is clickable only for `https:` URLs and Lobby-relative board paths (`/b/…`): `safeHref`;
// any other target (javascript:, data:, http:, mailto:, a relative path) stays plain text, and nothing is fetched.
//
// Budgets (contracts DOC_CARD_LIMITS): at most `maxBlocks` blocks and `maxInlineNodes` inline nodes; past either, the
// rest of the words are plain text lines (still all there, unformatted). Linear time: every scan of a line uses
// next-occurrence tables built once per line, and inline nesting is at most MAX_INLINE_DEPTH deep, so a pathological
// 20,000-character line costs a few passes over it, never a quadratic search.
import { DOC_CARD_LIMITS } from '@draftroom/contracts'

/** `at`: where the node's words start in the block's inline content (the line minus its `start`), for export.ts. */
export type Inline =
  | { readonly t: 'text'; readonly s: string; readonly at: number }
  | { readonly t: 'strong'; readonly c: readonly Inline[] }
  | { readonly t: 'em'; readonly c: readonly Inline[] }
  | { readonly t: 'code'; readonly s: string; readonly at: number }
  /** `href` is the safe target (`safeHref`), or null: the link is shown as its words, not clickable */
  | { readonly t: 'link'; readonly href: string | null; readonly c: readonly Inline[] }

/** `line`: the source line; `start`: where the inline content starts in it (after `# `, `- [ ] `, `> `…). */
export type Block =
  | {
      readonly t: 'heading'
      readonly level: 1 | 2 | 3
      readonly c: readonly Inline[]
      readonly line: number
      readonly start: number
    }
  | { readonly t: 'para'; readonly c: readonly Inline[]; readonly line: number; readonly start: number }
  | { readonly t: 'blank'; readonly line: number }
  | { readonly t: 'rule'; readonly line: number }
  | { readonly t: 'quote'; readonly c: readonly Inline[]; readonly line: number; readonly start: number }
  | {
      readonly t: 'item'
      /** `bullet`, `number` (with its own number) or `check` (with its state) */
      readonly list: 'bullet' | 'number' | 'check'
      readonly checked: boolean
      readonly number: number
      /** nesting level, 0 at the margin */
      readonly depth: number
      readonly c: readonly Inline[]
      readonly line: number
      readonly start: number
    }
  /** past a budget: the rest of the words, unformatted (one block per remaining line) */
  | { readonly t: 'plain'; readonly s: string; readonly line: number }

export interface ParsedDoc {
  readonly blocks: readonly Block[]
  /** a budget ran out: the blocks from `plain` on are unformatted */
  readonly truncated: boolean
}

export const MAX_INLINE_DEPTH = 4
export const MAX_INDENT = 6

const HEADING = /^(#{1,3})[ \t]+(.*)$/
const RULE = /^[ \t]{0,3}(?:-[ \t]*){3,}$|^[ \t]{0,3}(?:\*[ \t]*){3,}$|^[ \t]{0,3}(?:_[ \t]*){3,}$/
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/
const CHECK = /^\[([ xX])\](?:[ \t]+(.*))?$/
const NUMBER = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/
const QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/

/** Indent in levels: two spaces or one tab each, at most MAX_INDENT. */
function depthOf(indent: string): number {
  let cols = 0
  for (const ch of indent) cols += ch === '\t' ? 2 : 1
  return Math.min(MAX_INDENT, Math.floor(cols / 2))
}

// A Lobby board path, exactly the shapes the app itself makes, and nothing else (no further path segment, so no dot
// segment or encoded slash can ever reach another route):
//   /b/<board id>                      contracts BOARD_ID_PATTERN
//   ?el=<id>[,<id>…]                   an element link (board-links BOARD_LINK_PATH_PATTERN; lib/deep-link.ts `el`)
//   ?view=<x>,<y>,<w>,<h>              a scene rectangle (lib/deep-link.ts `view`)
//   ?file=<ver>&page=<n>               a search hit inside a file (contracts FILE_HIT_QUERY)
//   ?thread=<thr id>                   a comment thread (notifications)
//   #<fragment>                        the element id charset
const LOBBY_BOARD_ID = '[a-z0-9][a-z0-9_-]{2,63}'
const LOBBY_ELEMENT_ID = '[A-Za-z0-9_.:-]{1,120}'
const LOBBY_NUM = '-?\\d{1,10}(?:\\.\\d{1,6})?'
const LOBBY_QUERY = [
  `el=${LOBBY_ELEMENT_ID}(?:,${LOBBY_ELEMENT_ID}){0,49}`,
  `view=${LOBBY_NUM},${LOBBY_NUM},${LOBBY_NUM},${LOBBY_NUM}`,
  'file=ver_[0-9A-Za-z]{10,40}&page=[1-9][0-9]{0,3}',
  'thread=thr_[0-9A-Za-z]{10,40}',
].join('|')
export const LOBBY_BOARD_HREF = new RegExp(
  `^/b/${LOBBY_BOARD_ID}(?:\\?(?:${LOBBY_QUERY}))?(?:#${LOBBY_ELEMENT_ID})?$`,
)

/**
 * The link targets made clickable: an absolute `https:` URL (no credentials), or a Lobby-relative board path that,
 * once percent-decoded, is exactly one of the app's own board shapes (`LOBBY_BOARD_HREF`); the decoded form is the
 * href. Everything else (another same-origin route, `.%2e` dot segments, `%2f`/`%5c`, `//`) is null: plain words.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim()
  if (!url || url.length > 2_048) return null
  // control characters and spaces never belong in a target (a `java\tscript:` trick, a smuggled newline)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000- \u007f\\]/.test(url)) return null
  if (url.startsWith('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(url)
    } catch {
      return null
    }
    // the strict shape has no `%`, so a doubly encoded target (`%252e`) is refused too
    return LOBBY_BOARD_HREF.test(decoded) ? decoded : null
  }
  if (!/^https:\/\//i.test(url)) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null
    return u.href
  } catch {
    return null
  }
}

/** The next index ≥ i (for each i) where `pred` holds, or `n` (one pass, right to left). */
function nextTable(n: number, pred: (i: number) => boolean): Int32Array {
  const out = new Int32Array(n + 2)
  let next = n
  out[n] = n
  out[n + 1] = n
  for (let i = n - 1; i >= 0; i--) {
    if (pred(i)) next = i
    out[i] = next
  }
  return out
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)
const isSpace = (c: string | undefined) => c === undefined || c === ' ' || c === '\t'

/** One line's scanning tables (positions of each delimiter that may open or close). */
interface LineScan {
  readonly s: string
  readonly n: number
  /** next `**` start */
  readonly star2: Int32Array
  /** next `_` that may close (not followed by a word character, not after a space) */
  readonly underClose: Int32Array
  /** next backtick */
  readonly tick: Int32Array
  /** next `]` followed by `(` */
  readonly bracketParen: Int32Array
  /** next `)` */
  readonly paren: Int32Array
}

function scanLine(s: string): LineScan {
  const n = s.length
  return {
    s,
    n,
    star2: nextTable(n, (i) => s[i] === '*' && s[i + 1] === '*'),
    underClose: nextTable(n, (i) => s[i] === '_' && !isSpace(s[i - 1]) && !isWordChar(s[i + 1])),
    tick: nextTable(n, (i) => s[i] === '`'),
    bracketParen: nextTable(n, (i) => s[i] === ']' && s[i + 1] === '('),
    paren: nextTable(n, (i) => s[i] === ')'),
  }
}

/** Inline budget shared by one parse (counts every node made). */
interface Budget {
  nodes: number
  readonly max: number
}

/**
 * The inline nodes of `scan.s[from, to)`. `depth` is the nesting so far; past MAX_INLINE_DEPTH the range is text.
 * A delimiter with no partner in range is text. Each opener looks its partner up in O(1) (the tables), and a
 * character is visited once per nesting level at most.
 */
function inlines(scan: LineScan, from: number, to: number, depth: number, budget: Budget): Inline[] {
  const { s } = scan
  const out: Inline[] = []
  let text = ''
  let textAt = from
  const pushText = () => {
    if (!text) return
    const last = out[out.length - 1]
    if (last?.t === 'text' && last.at + last.s.length === textAt)
      out[out.length - 1] = { t: 'text', s: last.s + text, at: last.at }
    else {
      out.push({ t: 'text', s: text, at: textAt })
      budget.nodes++
    }
    text = ''
  }
  const addChar = (at: number, chars: string) => {
    if (!text) textAt = at
    text += chars
  }
  if (depth > MAX_INLINE_DEPTH || budget.nodes >= budget.max) {
    if (from < to) {
      out.push({ t: 'text', s: s.slice(from, to), at: from })
      budget.nodes++
    }
    return out
  }
  let i = from
  while (i < to) {
    if (budget.nodes >= budget.max) {
      addChar(i, s.slice(i, to))
      break
    }
    const c = s[i] as string
    if (c === '`') {
      const end = scan.tick[i + 1] as number
      if (end < to && end > i + 1) {
        pushText()
        out.push({ t: 'code', s: s.slice(i + 1, end), at: i + 1 })
        budget.nodes++
        i = end + 1
        continue
      }
    } else if (c === '*' && s[i + 1] === '*' && i + 2 < to && !isSpace(s[i + 2])) {
      const end = scan.star2[i + 2] as number
      if (end + 1 < to && end > i + 2 && !isSpace(s[end - 1])) {
        pushText()
        budget.nodes++
        out.push({ t: 'strong', c: inlines(scan, i + 2, end, depth + 1, budget) })
        i = end + 2
        continue
      }
    } else if (c === '_' && !isWordChar(s[i - 1]) && i + 1 < to && !isSpace(s[i + 1])) {
      const end = scan.underClose[i + 1] as number
      if (end < to && end > i + 1) {
        pushText()
        budget.nodes++
        out.push({ t: 'em', c: inlines(scan, i + 1, end, depth + 1, budget) })
        i = end + 1
        continue
      }
    } else if (c === '[') {
      const close = scan.bracketParen[i + 1] as number
      if (close + 1 < to) {
        const end = scan.paren[close + 2] as number
        if (end < to) {
          pushText()
          budget.nodes++
          out.push({
            t: 'link',
            href: safeHref(s.slice(close + 2, end)),
            c: inlines(scan, i + 1, close, depth + 1, budget),
          })
          i = end + 1
          continue
        }
      }
    }
    addChar(i, c)
    i++
  }
  pushText()
  return out
}

/** Parses a doc card's words (see the header). `limits` defaults to the contracts' budgets. */
export function parseMarkdownLite(
  words: string,
  limits: { maxBlocks: number; maxInlineNodes: number } = DOC_CARD_LIMITS,
): ParsedDoc {
  const lines = words.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  const budget: Budget = { nodes: 0, max: limits.maxInlineNodes }
  let truncated = false
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line] as string
    if (blocks.length >= limits.maxBlocks || budget.nodes >= budget.max) {
      truncated = true
      blocks.push({ t: 'plain', s: raw, line })
      continue
    }
    blocks.push(blockOf(raw, line, budget))
  }
  return { blocks, truncated }
}

function blockOf(raw: string, line: number, budget: Budget): Block {
  if (/^[ \t]*$/.test(raw)) return { t: 'blank', line }
  const inline = (s: string) => {
    const scan = scanLine(s)
    return inlines(scan, 0, scan.n, 0, budget)
  }
  // every content group below is a suffix of the line: its start is the line's length minus its own
  const startOf = (content: string) => raw.length - content.length
  const h = HEADING.exec(raw)
  if (h) {
    const content = h[2] as string
    return {
      t: 'heading',
      level: (h[1] as string).length as 1 | 2 | 3,
      c: inline(content),
      line,
      start: startOf(content),
    }
  }
  if (RULE.test(raw)) return { t: 'rule', line }
  const b = BULLET.exec(raw)
  if (b) {
    const depth = depthOf(b[1] as string)
    const rest = b[2] as string
    const check = CHECK.exec(rest)
    if (check) {
      const content = check[2] ?? ''
      return {
        t: 'item',
        list: 'check',
        checked: check[1] !== ' ',
        number: 0,
        depth,
        c: inline(content),
        line,
        start: startOf(content),
      }
    }
    return {
      t: 'item',
      list: 'bullet',
      checked: false,
      number: 0,
      depth,
      c: inline(rest),
      line,
      start: startOf(rest),
    }
  }
  const num = NUMBER.exec(raw)
  if (num) {
    const content = num[3] as string
    return {
      t: 'item',
      list: 'number',
      checked: false,
      number: Number(num[2]),
      depth: depthOf(num[1] as string),
      c: inline(content),
      line,
      start: startOf(content),
    }
  }
  const q = QUOTE.exec(raw)
  if (q) {
    const content = q[1] as string
    return { t: 'quote', c: inline(content), line, start: startOf(content) }
  }
  return { t: 'para', c: inline(raw), line, start: 0 }
}

// ---- styled runs with their place in the line (export.ts lays them on the label's wrapped lines) -------------------

export interface StyledRun {
  /** the run's words */
  readonly s: string
  /** where they start in the source line */
  readonly from: number
  readonly strong: boolean
  readonly em: boolean
  readonly code: boolean
  readonly link: boolean
}

/** A block's words as styled runs, each with its offset in the source line (marks are not in any run). */
export function styledRuns(b: Block): StyledRun[] {
  if (b.t === 'plain')
    return b.s ? [{ s: b.s, from: 0, strong: false, em: false, code: false, link: false }] : []
  if (!('c' in b)) return []
  const out: StyledRun[] = []
  const walk = (nodes: readonly Inline[], st: { strong: boolean; em: boolean; link: boolean }) => {
    for (const n of nodes) {
      if (n.t === 'text' || n.t === 'code')
        out.push({ s: n.s, from: b.start + n.at, ...st, code: n.t === 'code' })
      else if (n.t === 'strong') walk(n.c, { ...st, strong: true })
      else if (n.t === 'em') walk(n.c, { ...st, em: true })
      else walk(n.c, { ...st, link: true })
    }
  }
  walk(b.c, { strong: false, em: false, link: false })
  return out
}

// ---- reading it back as plain text -----------------------------------------------------------------------------

/** The words of inline nodes without their marks (`**a**` is `a`, a link is its words). */
export function inlineText(nodes: readonly Inline[]): string {
  let out = ''
  for (const n of nodes) out += n.t === 'text' || n.t === 'code' ? n.s : inlineText(n.c)
  return out
}

/** The marker a list item shows in front of its words (what export and the plain reading draw). */
export function itemMarker(b: Extract<Block, { t: 'item' }>): string {
  if (b.list === 'check') return b.checked ? '☑' : '☐'
  if (b.list === 'number') return `${b.number}.`
  return '•'
}

/** One line of the doc as plain words, its marks taken out (a heading's `#`, `**`, a link's target…). */
export function blockText(b: Block): string {
  switch (b.t) {
    case 'blank':
    case 'rule':
      return ''
    case 'plain':
      return b.s
    case 'item':
      return `${'  '.repeat(b.depth)}${itemMarker(b)} ${inlineText(b.c)}`
    default:
      return inlineText(b.c)
  }
}

/** The doc's words without their marks, line for line (a rule is an empty line). */
export function stripMarks(words: string): string {
  return parseMarkdownLite(words)
    .blocks.map((b) => blockText(b))
    .join('\n')
}

/** What the card is called: its first heading, else its first non-empty line, marks taken out (≤ 80 chars). */
export function docTitle(words: string): string {
  const firstLines = words.replace(/\r\n?/g, '\n').split('\n', 200)
  const parsed = parseMarkdownLite(firstLines.join('\n'))
  const heading = parsed.blocks.find((b) => b.t === 'heading')
  const first = heading ?? parsed.blocks.find((b) => b.t !== 'blank' && b.t !== 'rule')
  const text = first ? blockText(first).replace(/\s+/g, ' ').trim() : ''
  return [...text].slice(0, 80).join('')
}

// ---- edits on the words -------------------------------------------------------------------------------------------

/**
 * The words with the checklist item on `line` ticked or unticked (`- [ ]` ↔ `- [x]`), or null when that line is not
 * a checklist item. Nothing else of the words changes.
 */
export function toggleCheck(words: string, line: number): string | null {
  const lines = words.split('\n')
  const raw = lines[line]
  if (raw === undefined) return null
  const m = /^([ \t]*[-*+][ \t]+\[)([ xX])(\].*)$/.exec(raw.replace(/\r$/, ''))
  if (!m) return null
  lines[line] = `${m[1]}${m[2] === ' ' ? 'x' : ' '}${m[3]}${raw.endsWith('\r') ? '\r' : ''}`
  return lines.join('\n')
}
