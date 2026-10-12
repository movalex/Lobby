// A small XML reader and writer for the SVG the canvas exports (wave N, N6-3): the PDF worker has no DOMParser,
// and the vector page needs the tree (transforms, clip paths, masks, symbols) rather than a string. The input is
// what XMLSerializer writes (well-formed XML, quoted attributes, escaped text), so this reads exactly that and
// refuses anything else: a document it cannot read is drawn as an image (the raster fallback), never guessed at.
// Pure (no DOM), so it runs in a worker and in Node.

export interface XElement {
  readonly name: string
  readonly attrs: Record<string, string>
  readonly children: XNode[]
}
export type XNode = XElement | string

export class SvgReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SvgReadError'
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** XML text or attribute value → the characters it stands for. */
export function decodeXml(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ref: string) => {
    if (ref[0] === '#') {
      const cp =
        ref[1] === 'x' || ref[1] === 'X'
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10)
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[ref] ?? m
  })
}

export const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const escapeAttr = (s: string) =>
  escapeText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')

// sticky: matched in place, so a multi-megabyte document (data: URLs) is never copied per tag
const NAME = /[A-Za-z_][\w.:-]*/y
const ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y

function nameAt(text: string, at: number): string | null {
  NAME.lastIndex = at
  return NAME.exec(text)?.[0] ?? null
}

/** Parses one XML document; returns its root element. Throws SvgReadError when it is not well formed. */
export function parseXml(text: string): XElement {
  let i = 0
  const n = text.length
  const stack: XElement[] = []
  const found: { root: XElement | null } = { root: null }
  const fail = (why: string): never => {
    throw new SvgReadError(`${why} at ${i}`)
  }
  const pushChild = (node: XNode) => {
    const top = stack[stack.length - 1]
    if (top) top.children.push(node)
    else if (typeof node !== 'string') {
      if (found.root) fail('a second root element')
      found.root = node
    } else if (node.trim()) fail('text outside the root element')
  }
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      pushChild(decodeXml(text.slice(i)))
      break
    }
    if (lt > i) pushChild(decodeXml(text.slice(i, lt)))
    i = lt
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      if (end < 0) fail('an unclosed comment')
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9)
      if (end < 0) fail('an unclosed CDATA section')
      pushChild(text.slice(i + 9, end))
      i = end + 3
      continue
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2)
      if (end < 0) fail('an unclosed processing instruction')
      i = end + 2
      continue
    }
    if (text.startsWith('<!', i)) {
      // a DOCTYPE: never internal subsets here (XMLSerializer writes none)
      const end = text.indexOf('>', i + 2)
      if (end < 0 || text.slice(i, end).includes('[')) fail('a DOCTYPE')
      i = end + 1
      continue
    }
    if (text[i + 1] === '/') {
      const name = nameAt(text, i + 2) ?? fail('a bad closing tag')
      const top = stack.pop()
      if (!top || top.name !== name) fail(`a closing </${name}> that matches no open element`)
      i += 2 + name.length
      while (i < n && /\s/.test(text[i] as string)) i++
      if (text[i] !== '>') fail('a bad closing tag')
      i++
      continue
    }
    const name = nameAt(text, i + 1) ?? fail('a bad tag')
    i += 1 + name.length
    const attrs: Record<string, string> = {}
    for (;;) {
      ATTR.lastIndex = i
      const a = ATTR.exec(text)
      if (!a) break
      const key = a[1] as string
      if (Object.hasOwn(attrs, key)) fail(`a repeated attribute ${key}`)
      attrs[key] = decodeXml(a[2] ?? a[3] ?? '')
      i += a[0].length
    }
    while (i < n && /\s/.test(text[i] as string)) i++
    const el: XElement = { name, attrs, children: [] }
    if (text.startsWith('/>', i)) {
      pushChild(el)
      i += 2
    } else if (text[i] === '>') {
      pushChild(el)
      stack.push(el)
      i++
    } else fail(`a bad tag <${name}>`)
  }
  if (stack.length) fail(`an unclosed <${stack[stack.length - 1]?.name}>`)
  if (!found.root) throw new SvgReadError('no root element')
  return found.root
}

/** The element as XML (children included), attributes in their order. */
export function serializeXml(el: XElement): string {
  let out = `<${el.name}`
  for (const [k, v] of Object.entries(el.attrs)) out += ` ${k}="${escapeAttr(v)}"`
  if (el.children.length === 0) return `${out}/>`
  out += '>'
  for (const c of el.children) out += typeof c === 'string' ? escapeText(c) : serializeXml(c)
  return `${out}</${el.name}>`
}

/** Every element with an `id`, by id (the first one wins, as in a browser). */
export function idMap(root: XElement): Map<string, XElement> {
  const out = new Map<string, XElement>()
  const walk = (el: XElement) => {
    const id = el.attrs.id
    if (id && !out.has(id)) out.set(id, el)
    for (const c of el.children) if (typeof c !== 'string') walk(c)
  }
  walk(root)
  return out
}

/** The text of an element and its descendants. */
export function textOf(el: XElement): string {
  let s = ''
  for (const c of el.children) s += typeof c === 'string' ? c : textOf(c)
  return s
}

/** The id an attribute such as `url(#a)` or `#a` refers to, or null. */
export function refId(value: string | undefined): string | null {
  if (!value) return null
  const v = value.trim()
  const m = /^url\(\s*["']?#([^"')]+)["']?\s*\)$/.exec(v) ?? /^#(.+)$/.exec(v)
  return m ? (m[1] as string) : null
}
