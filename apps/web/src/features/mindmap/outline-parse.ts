// Text as an outline (pure): the other direction of ./outline-core.ts. A Markdown outline (a heading for the
// central topic, then headings and nested lists), or plain indented lines (tabs, 2 or 4 spaces, mixed), becomes
// a tree of topics for a new mind map ("Paste as mind map", and the first ring of "Mind map from a prompt").
//
// What it accepts, in the order the lines read:
//  - headings (`#` to `######`): a heading's level relative to the smallest one used is its depth;
//  - list items (`-`, `*`, `+`, `•`, `1.`, `1)`, optional `[ ]` / `[x]`) and plain lines: their indentation
//    (a tab, or spaces, mixed freely; deeper than the line above = a child) gives the depth under the
//    heading above them;
//  - inline Markdown (emphasis, code, links, backslash escapes: what ./outline-core.ts `escapeMarkdown`
//    writes) is reduced to the words.
// The central topic is the heading or the lone first line everything hangs from; with several lines at the
// top level there is no title in the text, and the topic is called "Mind map" (`titled: false`).
//
// Caps, so a paste of any size makes a map the canvas and the server take: OUTLINE_MAX_DEPTH levels under the
// central topic (deeper lines join their ancestor at the last level: nothing is lost but their nesting),
// OUTLINE_MAX_TOPICS topics (the first ones in reading order; the rest are counted in `clipped.topics`) and
// OUTLINE_MAX_TOPIC_CHARS characters a topic (cut with an ellipsis). Garbage (control characters, JSON or
// HTML, a table of tab-separated cells, nothing readable) is not an outline: null, so the paste stays notes
// or text. `nested` says whether the text itself had a hierarchy: only then is "Paste as mind map" offered.
// Pure: no DOM, no editor.

/** Levels under the central topic. */
export const OUTLINE_MAX_DEPTH = 4
/** Topics in a pasted map, the central topic included. */
export const OUTLINE_MAX_TOPICS = 60
/** Characters of one topic's words. */
export const OUTLINE_MAX_TOPIC_CHARS = 120
/** Characters of a paste that are looked at, and lines. */
export const OUTLINE_MAX_INPUT_CHARS = 60_000
export const OUTLINE_MAX_LINES = 600
/**
 * Characters of one line that are cleaned (wave K integration, the K7 review): the link and image patterns are
 * quadratic on a hostile line ('[' x 59,000 took about 1 s); a topic keeps OUTLINE_MAX_TOPIC_CHARS anyway.
 */
export const OUTLINE_MAX_LINE_CHARS = 2_000
/** What a map without a title in its text is called. */
export const OUTLINE_UNTITLED = 'Mind map'
/** A paste offers "Paste as mind map" from this many topics. */
export const OUTLINE_MIN_TOPICS = 3

export interface OutlineNode {
  text: string
  children: OutlineNode[]
}

export interface Outline {
  root: OutlineNode
  /** Topics after the caps, the central topic included. */
  topics: number
  /** The deepest level (the central topic is 0). */
  depth: number
  /** The text had a hierarchy of its own (a heading over lines, or indentation). */
  nested: boolean
  /** The central topic's words come from the text (else it is called "Mind map"). */
  titled: boolean
  /** What the caps cut: lines flattened into their level, topics left out, topics shortened. */
  clipped: { depth: number; topics: number; text: number }
}

// ---- words -----------------------------------------------------------------------------------------

/** Control characters other than tab and line breaks: binary, not text. */
const hasControl = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) return true
  }
  return false
}
const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!|<>~])/g
const PLACE = '\u0001'

/** One topic's words from a line of Markdown: markup reduced, whitespace collapsed. */
export function cleanTopicText(raw: string): string {
  const kept: string[] = []
  const line = raw.length > OUTLINE_MAX_LINE_CHARS ? raw.slice(0, OUTLINE_MAX_LINE_CHARS) : raw
  // escapes first (they are what the outline export writes), restored last
  let s = line.replace(ESCAPABLE, (_, c: string) => `${PLACE}${kept.push(c) - 1}${PLACE}`)
  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/~~(\S(?:.*?\S)?)~~/g, '$1')
    .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/(^|[^\w_])_(\S(?:[^_]*?\S)?)_(?=[^\w_]|$)/g, '$1$2')
  s = s.replace(new RegExp(`${PLACE}(\\d+)${PLACE}`, 'g'), (_, i: string) => kept[Number(i)] ?? '')
  return s.replace(/\s+/g, ' ').trim()
}

/** `text` cut to `max` characters (code points) with an ellipsis. */
export function cutTopic(text: string, max = OUTLINE_MAX_TOPIC_CHARS): string {
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`
}

// ---- lines -----------------------------------------------------------------------------------------

/** Columns of leading whitespace; a tab advances to the next multiple of 4. */
function indentOf(line: string): { col: number; rest: string } {
  let col = 0
  let i = 0
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === ' ') col++
    else if (c === '\t') col += 4 - (col % 4)
    else break
  }
  return { col, rest: line.slice(i) }
}

const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const BULLET = /^(?:[-*+•▪◦‣–—][ \t]+|\d{1,4}[.)][ \t]+)/
const RULE = /^(?:-{3,}|\*{3,}|_{3,}|={3,})$/
const CHECKBOX = /^\[[ xX]\][ \t]+/

type Line = { kind: 'heading'; level: number; text: string } | { kind: 'item'; col: number; text: string }

/** Whether the paste is JSON or HTML or a table of cells rather than an outline. */
function looksLikeData(trimmed: string, lines: readonly string[]): boolean {
  if (/^<[a-z!/?]/i.test(trimmed)) return true
  if (/^[{[]/.test(trimmed)) {
    try {
      JSON.parse(trimmed)
      return true
    } catch {
      // not JSON: a bracket at the start is only a character
    }
  }
  // tab-separated cells (a spreadsheet selection), not indentation
  return lines.some((l) => /\S[ \t]*\t[ \t]*\S/.test(l.replace(/^[ \t]+/, '').replace(BULLET, '')))
}

function readLines(raw: string): Line[] | null {
  if (typeof raw !== 'string') return null
  const text = raw.length > OUTLINE_MAX_INPUT_CHARS ? raw.slice(0, OUTLINE_MAX_INPUT_CHARS) : raw
  if (hasControl(text)) return null
  const trimmed = text.trim()
  if (!trimmed) return null
  const all = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  if (looksLikeData(trimmed, all)) return null
  const lines: Line[] = []
  let fenced = false
  for (const line of all) {
    if (lines.length >= OUTLINE_MAX_LINES) break
    const { col, rest } = indentOf(line)
    const body = rest.trimEnd()
    if (!body) continue
    if (/^(```|~~~)/.test(body)) {
      fenced = !fenced
      continue
    }
    if (fenced || RULE.test(body)) continue
    const h = col < 4 ? HEADING.exec(body) : null
    if (h) {
      const words = cleanTopicText(h[2] ?? '')
      if (words) lines.push({ kind: 'heading', level: (h[1] ?? '#').length, text: words })
      continue
    }
    const words = cleanTopicText(body.replace(BULLET, '').replace(CHECKBOX, ''))
    // a line of punctuation alone is not a topic
    if (words && /[\p{L}\p{N}]/u.test(words)) lines.push({ kind: 'item', col, text: words })
  }
  return lines
}

// ---- the tree --------------------------------------------------------------------------------------

interface Entry {
  /** Levels under the nearest entry above that is shallower (0: nothing above it is). */
  level: number
  text: string
}

/** Every line's level in the outline: headings by their heading level, items by indentation under them. */
function entriesOf(lines: readonly Line[]): Entry[] {
  const headings = lines.filter((l): l is Extract<Line, { kind: 'heading' }> => l.kind === 'heading')
  const minHeading = headings.length ? Math.min(...headings.map((l) => l.level)) : 1
  const raw: { depth: number; text: string }[] = []
  let base = 0
  let stack: number[] = []
  for (const line of lines) {
    if (line.kind === 'heading') {
      const depth = line.level - minHeading
      raw.push({ depth, text: line.text })
      base = depth + 1
      stack = []
      continue
    }
    // Python-style: a deeper indent opens a level, a shallower one closes back to the level it matches
    while (stack.length && (stack[stack.length - 1] as number) > line.col) stack.pop()
    if (!stack.length || (stack[stack.length - 1] as number) < line.col) stack.push(line.col)
    raw.push({ depth: base + stack.length - 1, text: line.text })
  }
  // A jump of two levels is one: a line is a child of the nearest line above it that is shallower.
  const out: Entry[] = []
  const chain: number[] = []
  for (const e of raw) {
    while (chain.length && (chain[chain.length - 1] as number) >= e.depth) chain.pop()
    out.push({ level: chain.length, text: e.text })
    chain.push(e.depth)
  }
  return out
}

/** The tree of `entries` (levels close up, so a line's parent is the last line one level above it). */
function treeOf(entries: readonly Entry[]): { root: OutlineNode; titled: boolean; hierarchy: boolean } {
  const single = entries.filter((e) => e.level === 0).length === 1
  const shift = single ? 0 : 1
  const root: OutlineNode = { text: single ? (entries[0] as Entry).text : OUTLINE_UNTITLED, children: [] }
  const path: OutlineNode[] = [root]
  let hierarchy = false
  for (const [i, e] of entries.entries()) {
    if (single && i === 0) continue
    if (e.level > 0) hierarchy = true
    const level = e.level + shift
    const node: OutlineNode = { text: e.text, children: [] }
    path[level - 1]?.children.push(node)
    path.length = level
    path.push(node)
  }
  return { root, titled: single, hierarchy }
}

function countBelow(n: OutlineNode): number {
  let c = 0
  for (const k of n.children) c += 1 + countBelow(k)
  return c
}

/** Applies the depth, topic and length caps, in reading order. */
function capped(source: OutlineNode): Pick<Outline, 'root' | 'topics' | 'depth' | 'clipped'> {
  const clipped = { depth: 0, topics: 0, text: 0 }
  const cut = (text: string) => {
    const words = cutTopic(text)
    if (words !== text) clipped.text++
    return words
  }
  const root: OutlineNode = { text: cut(source.text), children: [] }
  let topics = 1
  let deepest = 0
  const visit = (kids: readonly OutlineNode[], level: number, into: OutlineNode, flattened: boolean) => {
    for (const k of kids) {
      if (topics >= OUTLINE_MAX_TOPICS) {
        clipped.topics += 1 + countBelow(k)
        continue
      }
      topics++
      if (flattened) clipped.depth++
      const node: OutlineNode = { text: cut(k.text), children: [] }
      into.children.push(node)
      deepest = Math.max(deepest, level)
      // a line past the last level joins it as a sibling of the line it hangs from
      if (level >= OUTLINE_MAX_DEPTH) visit(k.children, level, into, true)
      else visit(k.children, level + 1, node, flattened)
    }
  }
  visit(source.children, 1, root, false)
  return { root, topics, depth: deepest, clipped }
}

/**
 * The outline in `raw`, or null when it is not one (empty, binary, JSON or HTML, a table of cells, or fewer
 * than two readable lines). `nested` says whether it has a hierarchy of its own.
 */
export function parseOutline(raw: string): Outline | null {
  const lines = readLines(raw)
  if (!lines || lines.length < 2) return null
  const { root, titled, hierarchy } = treeOf(entriesOf(lines))
  const made = capped(root)
  if (made.topics < 2) return null
  return { ...made, nested: hierarchy, titled }
}

/** The outline of a paste worth "Paste as mind map": a hierarchy of its own and a few topics. */
export function offersMindmap(raw: string): Outline | null {
  const o = parseOutline(raw)
  return o?.nested && o.topics >= OUTLINE_MIN_TOPICS ? o : null
}

/** A one-ring map from a title and its branches (the prompt and the ideas AI drafted for it). */
export function ringOutline(title: string, branches: readonly string[]): Outline | null {
  const text = cutTopic(cleanTopicText(title))
  const kids = branches
    .map((b) => cutTopic(cleanTopicText(b)))
    .filter(Boolean)
    .slice(0, OUTLINE_MAX_TOPICS - 1)
  if (!text || !kids.length) return null
  return {
    root: { text, children: kids.map((t) => ({ text: t, children: [] })) },
    topics: kids.length + 1,
    depth: 1,
    nested: true,
    titled: true,
    clipped: { depth: 0, topics: 0, text: 0 },
  }
}

/** The topics of a tree in reading order (the central topic first), with their level. */
export function flattenOutline(root: OutlineNode): { text: string; level: number }[] {
  const out: { text: string; level: number }[] = []
  const visit = (n: OutlineNode, level: number) => {
    out.push({ text: n.text, level })
    for (const k of n.children) visit(k, level + 1)
  }
  visit(root, 0)
  return out
}
