import { DOC_CARD_LIMITS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  type Block,
  docTitle,
  type Inline,
  inlineText,
  MAX_INLINE_DEPTH,
  parseMarkdownLite,
  safeHref,
  stripMarks,
  styledRuns,
  toggleCheck,
} from './markdown-lite.ts'

const blocks = (s: string) => parseMarkdownLite(s).blocks
const one = (s: string) => blocks(s)[0] as Block
/** the inline nodes without their offsets (styledRuns' test reads those) */
const inl = (s: string) =>
  JSON.parse(
    JSON.stringify((one(s) as { c: readonly Inline[] }).c, (k, v) => (k === 'at' ? undefined : v)),
  ) as Inline[]

describe('markdown-lite blocks', () => {
  it('reads headings, items, checklists, numbers, quotes, rules, blanks and paragraphs, one block per line', () => {
    const doc = [
      '# Title',
      '## Part',
      '### Small',
      '- one',
      '  * two',
      '- [ ] todo',
      '- [x] done',
      '3. third',
      '> said',
      '---',
      '',
      'plain words',
      '#nohashspace',
    ].join('\n')
    const b = blocks(doc)
    expect(b.map((x) => x.t)).toEqual([
      'heading',
      'heading',
      'heading',
      'item',
      'item',
      'item',
      'item',
      'item',
      'quote',
      'rule',
      'blank',
      'para',
      'para',
    ])
    expect(b.map((x) => x.line)).toEqual([...Array(13).keys()])
    expect(b.slice(0, 3).map((x) => (x as { level: number }).level)).toEqual([1, 2, 3])
    const items = b.filter((x) => x.t === 'item') as Extract<Block, { t: 'item' }>[]
    expect(items.map((x) => [x.list, x.checked, x.depth, x.number])).toEqual([
      ['bullet', false, 0, 0],
      ['bullet', false, 1, 0],
      ['check', false, 0, 0],
      ['check', true, 0, 0],
      ['number', false, 0, 3],
    ])
    expect(inlineText(items[0]?.c ?? [])).toBe('one')
  })

  it('caps the nesting of items at six levels', () => {
    const b = one(`${' '.repeat(40)}- deep`) as Extract<Block, { t: 'item' }>
    expect(b.depth).toBe(6)
  })

  it('keeps CRLF words readable (a pasted Windows text)', () => {
    expect(blocks('# A\r\n- b\r\n').map((x) => x.t)).toEqual(['heading', 'item', 'blank'])
  })
})

describe('markdown-lite inline marks', () => {
  it('reads **strong**, _em_, `code` and [links](https://…)', () => {
    expect(inl('a **b** c')).toEqual([
      { t: 'text', s: 'a ' },
      { t: 'strong', c: [{ t: 'text', s: 'b' }] },
      { t: 'text', s: ' c' },
    ])
    expect(inl('_x_')).toEqual([{ t: 'em', c: [{ t: 'text', s: 'x' }] }])
    expect(inl('run `npm i` now')[1]).toEqual({ t: 'code', s: 'npm i' })
    expect(inl('see [docs](https://example.com/a?b=1)')[1]).toEqual({
      t: 'link',
      href: 'https://example.com/a?b=1',
      c: [{ t: 'text', s: 'docs' }],
    })
  })

  it('leaves snake_case, lone stars and unclosed marks as they are', () => {
    expect(inlineText(inl('my_var_name and 2 * 3'))).toBe('my_var_name and 2 * 3')
    expect(inl('my_var_name')).toEqual([{ t: 'text', s: 'my_var_name' }])
    expect(inl('**open and `tick and [bracket')).toEqual([{ t: 'text', s: '**open and `tick and [bracket' }])
    expect(inl('** spaced **')).toEqual([{ t: 'text', s: '** spaced **' }])
  })

  it('code keeps its marks literal', () => {
    expect(inl('`**not bold**`')).toEqual([{ t: 'code', s: '**not bold**' }])
  })

  it('never passes HTML through: tags are words', () => {
    const b = inl('<script>alert(1)</script> <img src=x onerror=alert(1)> **<b>x</b>**')
    expect(inlineText(b)).toBe('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>x</b>')
    // and nothing in the tree is anything but plain data
    const walk = (n: readonly Inline[]): string[] =>
      n.flatMap((x) => (x.t === 'text' || x.t === 'code' ? [x.t] : [x.t, ...walk(x.c)]))
    expect(new Set(walk(b))).toEqual(new Set(['text', 'strong']))
  })
})

describe('markdown-lite links', () => {
  it('makes only https and Lobby-relative board paths clickable', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com/')
    expect(safeHref('/b/brd_123abc')).toBe('/b/brd_123abc')
    expect(safeHref('/b/brd_123abc?el=xyz#top')).toBe('/b/brd_123abc?el=xyz#top')
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'java\tscript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'DATA:image/png;base64,AAAA',
      'vbscript:x',
      'http://example.com',
      'mailto:a@b.c',
      'file:///etc/passwd',
      '//evil.example/b/x',
      '/b/../api/x',
      '/b/x\\y',
      '/api/boards',
      'relative/path',
      'https://user:pw@example.com',
      'https://',
      '',
    ])
      expect(safeHref(bad), bad).toBeNull()
  })

  it('a refused target keeps the words, with no href', () => {
    for (const href of ['javascript:alert`1`', 'data:text/html,x', 'http://x.y', 'JaVaScRiPt:void 0'])
      expect(inl(`[click](${href})`), href).toEqual([
        { t: 'link', href: null, c: [{ t: 'text', s: 'click' }] },
      ])
    // a target with its own parenthesis ends at the first one: still refused, the rest is words
    const b = inl('[click](javascript:alert(1))')
    expect(b[0]).toEqual({ t: 'link', href: null, c: [{ t: 'text', s: 'click' }] })
    expect(inlineText(b.slice(1))).toBe(')')
  })
})

describe('markdown-lite budgets and adversarial words', () => {
  it('a 20,000-character line parses in linear time', () => {
    const line = 'word **bold** _em_ `c` [l](https://a.b) '.repeat(500).slice(0, DOC_CARD_LIMITS.maxChars)
    const t0 = performance.now()
    const p = parseMarkdownLite(line)
    const ms = performance.now() - t0
    expect(p.blocks).toHaveLength(1)
    expect(ms).toBeLessThan(500)
  })

  it('pathological delimiters (every opener without a closer) stay linear', () => {
    for (const s of [
      `x${'*'.repeat(19_999)}`,
      '_a'.repeat(10_000),
      '['.repeat(20_000),
      '[a]('.repeat(5_000),
      '`'.repeat(20_000),
      '**a '.repeat(5_000),
      '_a _'.repeat(5_000),
    ]) {
      const t0 = performance.now()
      const p = parseMarkdownLite(s)
      expect(performance.now() - t0, s.slice(0, 8)).toBeLessThan(500)
      expect(
        p.blocks.map((b) => (b.t === 'plain' ? b.s : inlineText((b as { c: readonly Inline[] }).c))).join(''),
      ).toBe(s)
    }
  })

  it('nesting deeper than the cap is words, not deeper nodes', () => {
    const deep = `${'**_'.repeat(20)}x${'_**'.repeat(20)}`
    let depth = 0
    const measure = (n: readonly Inline[], d: number) => {
      for (const x of n) {
        if (x.t === 'text' || x.t === 'code') continue
        depth = Math.max(depth, d + 1)
        measure(x.c, d + 1)
      }
    }
    measure(inl(deep), 0)
    expect(depth).toBeLessThanOrEqual(MAX_INLINE_DEPTH + 1)
    expect(inlineText(inl(deep))).toContain('x')
  })

  it('past the block budget the rest is plain words, all of them', () => {
    const words = Array.from({ length: 2_100 }, (_, i) => `- item ${i}`).join('\n')
    const p = parseMarkdownLite(words)
    expect(p.truncated).toBe(true)
    expect(p.blocks.filter((b) => b.t === 'item')).toHaveLength(DOC_CARD_LIMITS.maxBlocks)
    expect(p.blocks.filter((b) => b.t === 'plain')).toHaveLength(100)
    expect((p.blocks.at(-1) as { s: string }).s).toBe('- item 2099')
  })

  it('past the inline budget the rest is plain words', () => {
    const p = parseMarkdownLite('**a** '.repeat(50), { maxBlocks: 100, maxInlineNodes: 10 })
    const c = (p.blocks[0] as unknown as { c: readonly Inline[] }).c
    const strong = c.filter((n) => n.t === 'strong').length
    expect(strong).toBeGreaterThan(0)
    expect(strong).toBeLessThanOrEqual(5)
    // every character is still there: the formatted ones without their marks, the rest literally
    expect(inlineText(c)).toBe(`${'a '.repeat(strong)}${'**a** '.repeat(50 - strong)}`)
    expect(parseMarkdownLite('**a**\n**b**', { maxBlocks: 100, maxInlineNodes: 1 }).truncated).toBe(true)
  })
})

describe('styled runs keep their place in the line', () => {
  it('each run starts where its words are in the source line', () => {
    const line = '- [ ] see **the** [plan](https://a.b) `now`'
    const runs = styledRuns(one(line))
    for (const r of runs) expect(line.slice(r.from, r.from + r.s.length)).toBe(r.s)
    expect(runs.map((r) => [r.s, r.strong, r.link, r.code])).toEqual([
      ['see ', false, false, false],
      ['the', true, false, false],
      [' ', false, false, false],
      ['plan', false, true, false],
      [' ', false, false, false],
      ['now', false, false, true],
    ])
    const h = '### Big **deal**'
    for (const r of styledRuns(one(h))) expect(h.slice(r.from, r.from + r.s.length)).toBe(r.s)
  })
})

describe('plain readings and edits', () => {
  it('stripMarks keeps the words and drops the marks, line for line', () => {
    expect(stripMarks('# Plan\n- [ ] **ship** it\n1. [docs](https://a.b)\n---\n> q')).toBe(
      'Plan\n☐ ship it\n1. docs\n\nq',
    )
  })

  it('docTitle is the first heading, else the first line', () => {
    expect(docTitle('intro\n# **Real** title')).toBe('Real title')
    expect(docTitle('\n\n- first _item_')).toBe('• first item')
    expect(docTitle('')).toBe('')
  })

  it('toggleCheck ticks and unticks one line, nothing else', () => {
    const w = 'a\n- [ ] one\n  * [x] two\n- not'
    expect(toggleCheck(w, 1)).toBe('a\n- [x] one\n  * [x] two\n- not')
    expect(toggleCheck(w, 2)).toBe('a\n- [ ] one\n  * [ ] two\n- not')
    expect(toggleCheck(w, 0)).toBeNull()
    expect(toggleCheck(w, 3)).toBeNull()
    expect(toggleCheck(w, 9)).toBeNull()
  })
})
