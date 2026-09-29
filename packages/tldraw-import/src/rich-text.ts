/**
 * tldraw rich text (TipTap JSON, `props.richText`) → the plain lines Excalidraw stores
 * (docs/EXCALIDRAW-MIGRATION.md §5.1 "text (rich)"): one line per paragraph and hard break, lists as
 * "• " and "1. " (nested items indented with spaces), the first link kept as the element's `link`.
 * Everything else (bold, italic, headings, code, more than one link) is reported as dropped formatting
 * (`rich-text-formatting`, §5.2). Ported from [DATA]'s prototype (`data/proto/text.ts`).
 *
 * The result never leaves the converter as a report: `formatted` names mark and block TYPES only, never
 * any of the text.
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export interface PlainText {
  /** the text, one entry per line (at least one entry) */
  readonly lines: string[]
  /** the dropped mark and block types, sorted (null when nothing was dropped) */
  readonly formatted: string | null
  /** the first link's href, or null */
  readonly link: string | null
}

/** Depth bound for hostile or corrupt documents. */
const MAX_DEPTH = 64

export function plainLines(rich: unknown): PlainText {
  const lines: string[] = []
  const marks = new Set<string>()
  const links: string[] = []
  const blocks = new Set<string>()

  const inline = (nodes: readonly unknown[], depth: number): string => {
    if (depth > MAX_DEPTH) return ''
    let out = ''
    for (const n of nodes) {
      if (!isObj(n)) continue
      if (n.type === 'text' && typeof n.text === 'string') {
        out += n.text
        for (const m of Array.isArray(n.marks) ? n.marks : []) {
          if (!isObj(m)) continue
          if (m.type === 'link' && isObj(m.attrs) && typeof m.attrs.href === 'string') {
            if (!links.includes(m.attrs.href)) links.push(m.attrs.href)
          } else marks.add(String(m.type))
        }
      } else if (n.type === 'hardBreak') out += '\n'
      else if (Array.isArray(n.content)) out += inline(n.content, depth + 1)
    }
    return out
  }

  const walk = (node: Record<string, unknown>, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) return
    const content: readonly unknown[] = Array.isArray(node.content) ? node.content : []
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      blocks.add(String(node.type))
      let i = 1
      for (const item of content)
        if (isObj(item)) walk(item, node.type === 'bulletList' ? '• ' : `${i++}. `, depth + 1)
      return
    }
    if (node.type === 'heading' || node.type === 'codeBlock' || node.type === 'blockquote')
      blocks.add(String(node.type))
    if (content.some((c) => isObj(c) && (c.type === 'text' || c.type === 'hardBreak'))) {
      for (const l of inline(content, depth + 1).split('\n')) lines.push(prefix + l)
      return
    }
    if (content.length === 0) {
      if (node.type === 'paragraph' || node.type === 'heading') lines.push(prefix)
      return
    }
    let first = true
    for (const c of content) {
      if (!isObj(c)) continue
      walk(c, first ? prefix : prefix.replace(/./g, ' '), depth + 1)
      first = false
    }
  }

  if (typeof rich === 'string') return { lines: rich.split(/\r\n?|\n/), formatted: null, link: null }
  if (isObj(rich)) walk(rich, '', 0)
  const dropped = [...marks, ...blocks].sort()
  if (links.length > 1) dropped.push('links')
  return {
    lines: lines.length ? lines : [''],
    formatted: dropped.length ? dropped.join(',') : null,
    link: links[0] ?? null,
  }
}

/** Whether the plain text has anything but whitespace. */
export const hasText = (t: PlainText): boolean => t.lines.join('').trim().length > 0
