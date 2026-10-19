// OWNER: WS1 (wave W, doc cards). The panel's format toolbar and keys as pure edits of the textarea's value and
// selection: they insert Markdown-lite marks (./markdown-lite.ts), never anything else. Each returns the new value and
// selection; the panel hands the value to its lease client like any typing.

export interface TextEdit {
  readonly value: string
  readonly start: number
  readonly end: number
}

export type InlineMark = 'bold' | 'italic' | 'code'
export type LineMark = 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'check' | 'quote'
export type FormatAction = InlineMark | LineMark | 'link' | 'rule'

const MARKS: Readonly<Record<InlineMark, string>> = { bold: '**', italic: '_', code: '`' }
const PLACEHOLDER: Readonly<Record<InlineMark | 'link', string>> = {
  bold: 'bold text',
  italic: 'italic text',
  code: 'code',
  link: 'link text',
}

/** `**`, `_` or a backtick around the selection (a placeholder selected when there is none); again, they go. */
export function toggleInline(e: TextEdit, mark: InlineMark): TextEdit {
  const m = MARKS[mark]
  const { value, start, end } = e
  const sel = value.slice(start, end)
  // already marked around the selection: unmark
  if (value.slice(start - m.length, start) === m && value.slice(end, end + m.length) === m)
    return {
      value: value.slice(0, start - m.length) + sel + value.slice(end + m.length),
      start: start - m.length,
      end: end - m.length,
    }
  if (sel.length > 2 * m.length && sel.startsWith(m) && sel.endsWith(m))
    return {
      value: value.slice(0, start) + sel.slice(m.length, -m.length) + value.slice(end),
      start,
      end: end - 2 * m.length,
    }
  const words = sel || PLACEHOLDER[mark]
  return {
    value: `${value.slice(0, start)}${m}${words}${m}${value.slice(end)}`,
    start: start + m.length,
    end: start + m.length + words.length,
  }
}

/** `[selection](https://)` with the address selected to type over. */
export function insertLink(e: TextEdit): TextEdit {
  const { value, start, end } = e
  const words = value.slice(start, end) || PLACEHOLDER.link
  const url = 'https://'
  const before = `${value.slice(0, start)}[${words}](`
  return {
    value: `${before}${url})${value.slice(end)}`,
    start: before.length,
    end: before.length + url.length,
  }
}

/** A rule on its own line at the caret. */
export function insertRule(e: TextEdit): TextEdit {
  const { value, start, end } = e
  const head = value.slice(0, start)
  const lead = head === '' || head.endsWith('\n') ? '' : '\n'
  const ins = `${lead}---\n`
  return { value: head + ins + value.slice(end), start: start + ins.length, end: start + ins.length }
}

const LINE_PREFIX =
  /^([ \t]*)(?:#{1,3}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+|>[ \t]?)?/

function prefixOf(mark: LineMark, n: number): string {
  switch (mark) {
    case 'h1':
      return '# '
    case 'h2':
      return '## '
    case 'h3':
      return '### '
    case 'bullet':
      return '- '
    case 'number':
      return `${n}. `
    case 'check':
      return '- [ ] '
    case 'quote':
      return '> '
  }
}

function hasMark(line: string, mark: LineMark): boolean {
  const body = line.replace(/^[ \t]*/, '')
  switch (mark) {
    case 'h1':
      return /^#[ \t]/.test(body)
    case 'h2':
      return /^##[ \t]/.test(body)
    case 'h3':
      return /^###[ \t]/.test(body)
    case 'check':
      return /^[-*+][ \t]+\[[ xX]\][ \t]/.test(body)
    case 'bullet':
      return /^[-*+][ \t]/.test(body) && !/^[-*+][ \t]+\[[ xX]\][ \t]/.test(body)
    case 'number':
      return /^\d{1,9}[.)][ \t]/.test(body)
    case 'quote':
      return /^>/.test(body)
  }
}

/**
 * The line mark on every line the selection touches: added (replacing another heading, list or quote mark), or taken
 * off when every one of those lines has it already. Numbered lines count up from 1.
 */
export function toggleLines(e: TextEdit, mark: LineMark): TextEdit {
  const { value, start, end } = e
  const from = value.lastIndexOf('\n', start - 1) + 1
  const nl = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end)
  const to = nl === -1 ? value.length : nl
  const lines = value.slice(from, to).split('\n')
  const off = lines.every((l) => hasMark(l, mark))
  let n = 0
  const next = lines.map((l) => {
    const m = LINE_PREFIX.exec(l)
    const indent = m?.[1] ?? ''
    const rest = l.slice(m?.[0].length ?? 0)
    if (off) return indent + rest
    n++
    return indent + prefixOf(mark, n) + rest
  })
  const block = next.join('\n')
  const value2 = value.slice(0, from) + block + value.slice(to)
  // keep the caret on the same words: a collapsed selection moves by what the first line gained or lost
  if (start === end) {
    const delta = (next[0]?.length ?? 0) - (lines[0]?.length ?? 0)
    const at = Math.max(from, Math.min(from + block.length, start + delta))
    return { value: value2, start: at, end: at }
  }
  return { value: value2, start: from, end: from + block.length }
}

export function applyFormat(e: TextEdit, action: FormatAction): TextEdit {
  if (action === 'bold' || action === 'italic' || action === 'code') return toggleInline(e, action)
  if (action === 'link') return insertLink(e)
  if (action === 'rule') return insertRule(e)
  return toggleLines(e, action)
}

/**
 * Enter at the end of a list item continues the list (the same mark, a checklist box unticked, the next number); Enter
 * on an empty item ends the list (its mark goes). Null: an ordinary Enter.
 */
export function continueList(e: TextEdit): TextEdit | null {
  const { value, start, end } = e
  if (start !== end) return null
  const from = value.lastIndexOf('\n', start - 1) + 1
  const nl = value.indexOf('\n', start)
  const to = nl === -1 ? value.length : nl
  const line = value.slice(from, to)
  if (start !== to) return null
  const m = /^([ \t]*)(?:([-*+])[ \t]+(\[[ xX]\][ \t]+)?|(\d{1,9})([.)])[ \t]+|(>)[ \t]?)(.*)$/.exec(line)
  if (!m) return null
  const [, indent = '', bullet, box, num, sep, quote, rest = ''] = m
  if (rest.trim() === '') {
    // an empty item: the list ends here (the line keeps only its indent)
    const value2 = value.slice(0, from) + indent + value.slice(to)
    const at = from + indent.length
    return { value: value2, start: at, end: at }
  }
  const prefix = bullet
    ? `${indent}${bullet} ${box ? '[ ] ' : ''}`
    : num
      ? `${indent}${Number(num) + 1}${sep} `
      : quote
        ? `${indent}> `
        : indent
  const ins = `\n${prefix}`
  return {
    value: value.slice(0, start) + ins + value.slice(end),
    start: start + ins.length,
    end: start + ins.length,
  }
}

/** The format keys inside the panel's textarea (Ctrl on Windows and Linux, Cmd on a Mac). */
export function formatKey(e: {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  mac: boolean
}): FormatAction | null {
  const mod = e.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) return null
  const k = e.key.toLowerCase()
  if (e.altKey && !e.shiftKey) {
    if (e.code === 'Digit1') return 'h1'
    if (e.code === 'Digit2') return 'h2'
    if (e.code === 'Digit3') return 'h3'
    return null
  }
  if (e.altKey) return null
  if (e.shiftKey) {
    if (e.code === 'Digit7') return 'number'
    if (e.code === 'Digit8') return 'bullet'
    if (e.code === 'Digit9') return 'check'
    return null
  }
  if (k === 'b') return 'bold'
  if (k === 'i') return 'italic'
  if (k === 'e') return 'code'
  if (k === 'k') return 'link'
  return null
}
