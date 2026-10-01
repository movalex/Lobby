import { describe, expect, it } from 'vitest'
import { plainTextOf } from './index.ts'

const p = (...content: unknown[]) => ({ type: 'paragraph', content })
const t = (text: string, marks?: unknown[]) =>
  marks ? { type: 'text', text, marks } : { type: 'text', text }
const doc = (...content: unknown[]) => ({ type: 'doc', content })

describe('plainTextOf over TipTap documents', () => {
  it('drops marks (bold, italic, link, highlight, code)', () => {
    const rich = doc(
      p(
        t('Hello', [{ type: 'bold' }]),
        t(' brave ', [{ type: 'italic' }, { type: 'highlight', attrs: { color: 'yellow' } }]),
        t('new', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        t(' world', [{ type: 'code' }]),
      ),
    )
    expect(plainTextOf(rich)).toBe('Hello brave new world')
  })

  it('joins paragraphs and headings with newlines and turns hard breaks into newlines', () => {
    const rich = doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('Agenda')] },
      p(t('line one'), { type: 'hardBreak' }, t('line two')),
      { type: 'paragraph' },
      p(t('after the gap')),
    )
    expect(plainTextOf(rich)).toBe('Agenda\nline one\nline two\n\nafter the gap')
  })

  it('reads bullet and ordered lists (nested too) one item per line, without markers', () => {
    const li = (...content: unknown[]) => ({ type: 'listItem', content })
    const rich = doc(
      p(t('Todo:')),
      {
        type: 'bulletList',
        content: [li(p(t('one'))), li(p(t('two')), { type: 'bulletList', content: [li(p(t('nested')))] })],
      },
      { type: 'orderedList', attrs: { start: 1 }, content: [li(p(t('first'))), li(p(t('second')))] },
    )
    expect(plainTextOf(rich)).toBe('Todo:\none\ntwo\nnested\nfirst\nsecond')
  })

  it('treats every empty-document encoding as empty text', () => {
    expect(plainTextOf(doc())).toBe('')
    expect(plainTextOf(doc({ type: 'paragraph' }))).toBe('')
    expect(plainTextOf(doc(p()))).toBe('')
  })

  it('returns legacy plain strings unchanged', () => {
    expect(plainTextOf('already plain')).toBe('already plain')
  })
})

describe('plainTextOf never throws on garbage', () => {
  const cyclic: Record<string, unknown> = { type: 'doc' }
  cyclic.content = [cyclic]
  let deep: Record<string, unknown> = p(t('bottom'))
  for (let i = 0; i < 10_000; i++) deep = { type: 'blockquote', content: [deep] }
  const throwing = {
    type: 'doc',
    get content(): unknown[] {
      throw new Error('boom')
    },
  }
  const proxy = new Proxy(
    {},
    {
      get() {
        throw new Error('trap')
      },
    },
  )
  const cases: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['array', [1, 2]],
    ['empty object', {}],
    ['doc without content', { type: 'doc' }],
    ['content not an array', { type: 'doc', content: 'text' }],
    ['junk children', doc(null, 1, 'x', { type: 'text', text: 5 }, p(null, t('ok')))],
    ['cyclic', cyclic],
    ['10k deep', deep],
    ['throwing getter', throwing],
    ['throwing proxy', proxy],
  ]
  it.each(cases)('%s', (_name, input) => {
    expect(() => plainTextOf(input)).not.toThrow()
    expect(typeof plainTextOf(input)).toBe('string')
  })

  it('still reads the valid parts of mixed garbage', () => {
    expect(plainTextOf(doc(null, 1, 'x', { type: 'text', text: 5 }, p(null, t('ok'))))).toBe('ok')
  })

  it('stops descending past the depth cap instead of overflowing the stack', () => {
    expect(plainTextOf(deep)).toBe('')
  })
})

describe('plainTextOf adversarial review', () => {
  it('stays bounded on shared/cyclic wide content (work is charged per scanned child)', () => {
    const wide: Record<string, unknown> = { type: 'doc' }
    wide.content = new Array(5000).fill(wide)
    const shared = { type: 'bulletList', content: new Array(5000).fill({ type: 'listItem', content: [] }) }
    const fanOut = doc(...new Array(5000).fill(shared))
    const start = Date.now()
    expect(plainTextOf(wide)).toBe('')
    expect(plainTextOf(fanOut)).toBe('')
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
