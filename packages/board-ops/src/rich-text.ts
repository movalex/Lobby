import { type TLRichText, toRichText } from '@tldraw/tlschema'
import { truncateText } from './board-index.ts'

/** Nesting deeper than this is ignored (TipTap lists nest a few levels; garbage can nest arbitrarily). */
const MAX_DEPTH = 64
/** Upper bound on visited nodes so hostile input cannot make extraction unbounded. */
const MAX_NODES = 200_000
/** Upper bound on produced characters. */
const MAX_OUTPUT_CHARS = 1_000_000

/** Block types that render as a (possibly empty) line even when they have no content. */
const TEXTBLOCK_TYPES = new Set(['paragraph', 'heading', 'codeBlock'])

interface Budget {
  nodes: number
  chars: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInline(node: Record<string, unknown>): boolean {
  return node.type === 'text' || node.type === 'hardBreak'
}

/**
 * The part of a node's `content` the node budget still allows, charged to the budget up front: every
 * child is scanned at least once below, so shared or cyclic arrays (possible in in-memory input) cannot
 * multiply the work beyond `MAX_NODES` in total.
 */
function affordable(content: unknown, budget: Budget): unknown[] {
  if (!Array.isArray(content)) return []
  const remaining = Math.max(0, MAX_NODES - budget.nodes)
  const part = content.length > remaining ? content.slice(0, remaining) : content
  budget.nodes += part.length
  return part
}

/** Serializes the inline children of a textblock (text, hard breaks, and text nested in unknown inline wrappers). */
function inlineText(content: unknown[], depth: number, budget: Budget): string {
  let out = ''
  for (const child of content) {
    if (budget.chars > MAX_OUTPUT_CHARS) break
    if (!isRecord(child)) continue
    if (child.type === 'text') {
      if (typeof child.text === 'string') {
        out += child.text
        budget.chars += child.text.length
      }
    } else if (child.type === 'hardBreak') {
      out += '\n'
      budget.chars += 1
    } else if (depth < MAX_DEPTH) {
      out += inlineText(affordable(child.content, budget), depth + 1, budget)
    }
  }
  return out
}

function collectLines(node: Record<string, unknown>, depth: number, lines: string[], budget: Budget): void {
  if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES || budget.chars > MAX_OUTPUT_CHARS) return
  const content = affordable(node.content, budget)
  if (content.some((child) => isRecord(child) && isInline(child))) {
    // A textblock (paragraph, heading, ...): one line; hard breaks become '\n' inside it.
    lines.push(inlineText(content, depth + 1, budget))
    return
  }
  if (content.length === 0) {
    if (typeof node.type === 'string' && TEXTBLOCK_TYPES.has(node.type)) lines.push('')
    return
  }
  // A container (doc, bulletList, orderedList, listItem, blockquote, ...): recurse into block children.
  for (const child of content) {
    if (isRecord(child)) collectLines(child, depth + 1, lines, budget)
  }
}

/**
 * TipTap/ProseMirror JSON (tldraw `TLRichText`) to plain text.
 *
 * Every textblock (paragraph, heading, list-item paragraph, ...) becomes one line and lines are joined
 * with `\n`; `hardBreak` nodes become `\n`; marks (bold, links, highlight, ...) are dropped. List
 * bullets/numbers are not rendered (same as tldraw's `renderPlaintextFromRichText`). A string input is
 * returned as-is (legacy plain `text` props). Never throws: garbage, cycles and hostile nesting yield
 * `''` or whatever text could be read within the depth/node/length caps.
 */
export function plainTextOf(richText: unknown): string {
  try {
    if (typeof richText === 'string') return truncateText(richText, MAX_OUTPUT_CHARS)
    if (!isRecord(richText)) return ''
    if (richText.type === 'text') return typeof richText.text === 'string' ? richText.text : ''
    const lines: string[] = []
    collectLines(richText, 0, lines, { nodes: 0, chars: 0 })
    const text = lines.join('\n')
    return truncateText(text, MAX_OUTPUT_CHARS)
  } catch {
    // Throwing getters / proxies in untrusted input.
    return ''
  }
}

/**
 * Plain text to a TipTap doc: one paragraph per line (CRLF / CR are normalized to LF first), empty
 * lines become empty paragraphs, no empty text nodes. `plainTextOf(richTextFrom(s))` returns `s` with
 * normalized line endings.
 */
export function richTextFrom(text: string): TLRichText {
  const value = typeof text === 'string' ? text : ''
  return toRichText(value.replace(/\r\n?/g, '\n'))
}
