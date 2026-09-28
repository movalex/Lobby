import { describe, expect, it } from 'vitest'
import { buildTree, type MindmapTree } from './model.ts'
import { EMPTY_TOPIC, escapeMarkdown, outlineCsv, outlineMarkdown, outlineRows } from './outline.ts'
import { R, topic } from './test-trees.ts'

const texts: Record<string, string> = {
  [R]: 'Launch plan',
  'shape:r1': 'Audience',
  'shape:r11': 'Leadership',
  'shape:r2': 'Channels',
  'shape:l1': '=HYPERLINK("x")',
  'shape:l2': '',
}

const map = (): MindmapTree => {
  const t = buildTree(R, [
    topic(R, null, { w: 200, h: 80 }),
    topic('shape:r1', R, { y: -100 }),
    topic('shape:r11', 'shape:r1', { y: -100 }, { collapsed: false }),
    topic('shape:r2', R, { y: 100 }, { collapsed: true }),
    topic('shape:l1', R, { y: -100 }, { side: 'left' }),
    topic('shape:l2', R, { y: 100 }, { side: 'left' }),
  ])
  if (!t) throw new Error('no tree')
  return t
}
const textOf = (id: string) => texts[id] ?? ''

describe('outline', () => {
  it('lists topics depth-first, branches clockwise from the top right, collapsed parts included', () => {
    expect(outlineRows(map(), textOf).map((r) => [r.level, r.text])).toEqual([
      [0, 'Launch plan'],
      [1, 'Audience'],
      [2, 'Leadership'],
      [1, 'Channels'],
      [1, EMPTY_TOPIC],
      [1, '=HYPERLINK("x")'],
    ])
  })

  it('Markdown: a heading, then a nested list, with markup escaped', () => {
    expect(outlineMarkdown(map(), textOf)).toBe(
      [
        '# Launch plan',
        '',
        '- Audience',
        '  - Leadership',
        '- Channels',
        `- ${EMPTY_TOPIC}`,
        '- =HYPERLINK("x")',
        '',
      ].join('\n'),
    )
  })

  it('escapes what Markdown would read as structure or formatting', () => {
    expect(escapeMarkdown('# not a heading')).toBe('\\# not a heading')
    expect(escapeMarkdown('- not a list')).toBe('\\- not a list')
    expect(escapeMarkdown('1. not numbered')).toBe('1\\. not numbered')
    expect(escapeMarkdown('*bold* _it_ [link](x) <b>')).toBe('\\*bold\\* \\_it\\_ \\[link\\](x) \\<b\\>')
    expect(escapeMarkdown('Q3 - plan #1')).toBe('Q3 - plan #1')
  })

  it('line breaks inside a topic become spaces', () => {
    const t = buildTree(R, [topic(R, null)])
    if (!t) throw new Error('no tree')
    expect(outlineMarkdown(t, () => 'two\nlines  here')).toBe('# two lines here\n\n')
  })

  it('CSV: level, topic, parent, path; RFC 4180 quoting and formula neutralization', () => {
    const csv = outlineCsv(map(), textOf)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('level,topic,parent,path')
    expect(lines[1]).toBe('0,Launch plan,,Launch plan')
    expect(lines[3]).toBe('2,Leadership,Audience,Launch plan > Audience > Leadership')
    // A formula-looking topic is neutralized and quoted (it has quotes), in its own cell and the path.
    expect(lines[6]).toBe(`1,"'=HYPERLINK(""x"")",Launch plan,"Launch plan > =HYPERLINK(""x"")"`)
    expect(csv.endsWith('\r\n')).toBe(true)
  })
})
