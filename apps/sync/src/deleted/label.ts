// A short plain-text label for a deleted shape (the "Recently deleted" list). Bounded work on
// untrusted record content: a fixed node budget, a fixed output length.

const MAX_LABEL = 80
const MAX_NODES = 2_000

/** Plain text of a TipTap rich-text doc (paragraphs joined by spaces), at most `max` characters. */
export function richTextToPlain(richText: unknown, max = MAX_LABEL): string {
  let out = ''
  let nodes = 0
  const walk = (node: unknown, depth: number): boolean => {
    if (++nodes > MAX_NODES || depth > 32 || out.length >= max) return false
    if (typeof node !== 'object' || node === null) return true
    const n = node as { type?: unknown; text?: unknown; content?: unknown }
    if (typeof n.text === 'string') out += n.text
    if (Array.isArray(n.content)) {
      for (const child of n.content) if (!walk(child, depth + 1)) return false
      if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') out += ' '
    }
    return true
  }
  walk(richText, 0)
  return collapse(out, max)
}

function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Frame and file names, text/label content, image alt text; '' when the shape has none. */
export function shapeLabel(record: unknown): string {
  if (typeof record !== 'object' || record === null) return ''
  const props = (record as { props?: unknown }).props
  if (typeof props !== 'object' || props === null) return ''
  const p = props as Record<string, unknown>
  if (typeof p.name === 'string' && p.name.trim()) return collapse(p.name, MAX_LABEL)
  if (p.richText !== undefined) {
    const text = richTextToPlain(p.richText)
    if (text) return text
  }
  if (typeof p.altText === 'string' && p.altText.trim()) return collapse(p.altText, MAX_LABEL)
  return ''
}
