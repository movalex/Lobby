// K7-2: text as an outline (./outline-parse.ts). The cases the acceptance names: headings plus nested lists,
// tabs and spaces, mixed bullets, the depth cap (4), the node cap (60), the per-topic length cap, and garbage
// that stays plain notes; plus the round trip with the outline export (./outline-core.ts).
import { describe, expect, it } from 'vitest'
import { buildTree } from './model.ts'
import { outlineMarkdown } from './outline.ts'
import {
  cleanTopicText,
  cutTopic,
  flattenOutline,
  OUTLINE_MAX_DEPTH,
  OUTLINE_MAX_TOPIC_CHARS,
  OUTLINE_MAX_TOPICS,
  OUTLINE_UNTITLED,
  type OutlineNode,
  offersMindmap,
  parseOutline,
  ringOutline,
} from './outline-parse.ts'
import { R, topic } from './test-trees.ts'

/** A tree as indented text: ["Root", ["A", ["A1"]], "B"] style, for readable expectations. */
const shape = (n: OutlineNode): unknown => (n.children.length ? [n.text, n.children.map(shape)] : n.text)
const parse = (text: string) => {
  const o = parseOutline(text)
  if (!o) throw new Error('not an outline')
  return o
}

describe('headings and nested lists', () => {
  it('a heading for the central topic, then a nested list (the outline export format)', () => {
    const o = parse('# Launch plan\n\n- Audience\n  - Leadership\n  - Fans\n- Channels\n')
    expect(shape(o.root)).toEqual(['Launch plan', [['Audience', ['Leadership', 'Fans']], 'Channels']])
    expect(o).toMatchObject({ topics: 5, depth: 2, nested: true, titled: true })
    expect(o.clipped).toEqual({ depth: 0, topics: 0, text: 0 })
  })

  it('headings alone nest by level, relative to the smallest used', () => {
    const one = parse('## Plan\n### Budget\n### Dates\n#### Fees')
    expect(shape(one.root)).toEqual(['Plan', ['Budget', ['Dates', ['Fees']]]])
    // two headings at the top level: no single title, so "Mind map" over both
    const two = parse('## Plan\n### Budget\n## Build\n### Crew\n#### Roles')
    expect(two.titled).toBe(false)
    expect(shape(two.root)).toEqual([
      OUTLINE_UNTITLED,
      [
        ['Plan', ['Budget']],
        ['Build', [['Crew', ['Roles']]]],
      ],
    ])
  })

  it('lists under each heading hang below that heading, deeper than it', () => {
    const o = parse('# Brief\n## Goals\n- Reach\n- Sales\n## Risks\n- Budget\n  - Overrun')
    expect(shape(o.root)).toEqual([
      'Brief',
      [
        ['Goals', ['Reach', 'Sales']],
        ['Risks', [['Budget', ['Overrun']]]],
      ],
    ])
  })

  it('a jump of two heading levels is one level', () => {
    const o = parse('# A\n### B\n#### C')
    expect(shape(o.root)).toEqual(['A', [['B', ['C']]]])
  })
})

describe('indentation: tabs, spaces, mixed', () => {
  const expected = ['Plan', [['Budget', ['Fees', 'Travel']], 'Dates']]
  it('tabs', () => {
    expect(shape(parse('Plan\n\tBudget\n\t\tFees\n\t\tTravel\n\tDates').root)).toEqual(expected)
  })
  it('two spaces', () => {
    expect(shape(parse('Plan\n  Budget\n    Fees\n    Travel\n  Dates').root)).toEqual(expected)
  })
  it('four spaces', () => {
    expect(shape(parse('Plan\n    Budget\n        Fees\n        Travel\n    Dates').root)).toEqual(expected)
  })
  it('a tab for the level a neighbour wrote with four spaces, and a shallower line closes back', () => {
    expect(shape(parse('- Plan\n    - Budget\n\t\t- Fees\n\t\t- Travel\n    - Dates').root)).toEqual(expected)
  })
  it('an odd dedent (between two levels) closes back to the level it matches or opens one', () => {
    const o = parse('- A\n      - B\n    - C\n- D')
    // C sits left of B but right of A: a level of its own under A, opened after B closes
    expect(shape(o.root)).toEqual([OUTLINE_UNTITLED, [['A', ['B', 'C']], 'D']])
  })
  it('Windows line endings, blank lines and trailing spaces', () => {
    const o = parse('Plan  \r\n\r\n  Budget\r\n  Dates\r\n')
    expect(shape(o.root)).toEqual(['Plan', ['Budget', 'Dates']])
  })
})

describe('mixed bullets and markdown inside topics', () => {
  it('-, *, +, •, numbers and checkboxes are all list items', () => {
    const o = parse('# Day\n- one\n* two\n+ three\n• four\n1. five\n2) six\n- [ ] seven\n- [x] eight')
    expect(o.root.children.map((c) => c.text)).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
    ])
  })

  it('reduces emphasis, code and links to the words; keeps escaped characters', () => {
    expect(cleanTopicText('**Bold** and _it_ and `code` and ~~gone~~')).toBe('Bold and it and code and gone')
    expect(cleanTopicText('[the site](https://example.com/a?b=1) and ![logo](x.png)')).toBe(
      'the site and logo',
    )
    expect(cleanTopicText('\\# not a heading, \\*not bold\\*, snake_case_name, 2 * 3 * 4')).toBe(
      '# not a heading, *not bold*, snake_case_name, 2 * 3 * 4',
    )
  })

  it('reads back what the outline export wrote, escapes included', () => {
    const tree = buildTree(R, [
      topic(R, null, { w: 200, h: 80 }),
      topic('shape:a', R, { y: -100 }),
      topic('shape:a1', 'shape:a', { y: -100 }),
      topic('shape:b', R, { y: 100 }),
    ])
    if (!tree) throw new Error('no tree')
    const words: Record<string, string> = {
      [R]: 'Q3 *launch*',
      'shape:a': '# not a heading',
      'shape:a1': '1. not numbered',
      'shape:b': 'a [link](x) <b>',
    }
    const md = outlineMarkdown(tree, (id) => words[id] ?? '')
    const o = parse(md)
    expect(shape(o.root)).toEqual([
      'Q3 *launch*',
      [['# not a heading', ['1. not numbered']], 'a [link](x) <b>'],
    ])
  })
})

describe('no title in the text', () => {
  it('several lines at the top level hang from a central topic called "Mind map"', () => {
    const o = parse('- Reach\n  - Fans\n- Sales')
    expect(o).toMatchObject({ titled: false, nested: true, topics: 4 })
    expect(shape(o.root)).toEqual([OUTLINE_UNTITLED, [['Reach', ['Fans']], 'Sales']])
  })

  it('a flat list has no hierarchy: not nested, so no mind map is offered', () => {
    const o = parse('- one\n- two\n- three')
    expect(o.nested).toBe(false)
    expect(offersMindmap('- one\n- two\n- three')).toBeNull()
    expect(offersMindmap('one\ntwo\nthree\nfour')).toBeNull()
  })

  it('a title with a single child is an outline but not worth offering (under three topics)', () => {
    expect(parseOutline('Title\n  only child')?.nested).toBe(true)
    expect(offersMindmap('Title\n  only child')).toBeNull()
    expect(offersMindmap('Title\n  a\n  b')).not.toBeNull()
  })
})

describe('caps', () => {
  it('a depth cap of 4: deeper lines join the last level, and are counted', () => {
    const text = ['Root', '  L1', '    L2', '      L3', '        L4', '          L5', '            L6'].join(
      '\n',
    )
    const o = parse(text)
    expect(OUTLINE_MAX_DEPTH).toBe(4)
    expect(o.depth).toBe(4)
    expect(shape(o.root)).toEqual(['Root', [['L1', [['L2', [['L3', ['L4', 'L5', 'L6']]]]]]]])
    expect(o.clipped.depth).toBe(2)
    expect(o.topics).toBe(7)
  })

  it('a node cap of 60 in reading order; the rest are counted, with their descendants', () => {
    const lines = ['# Big']
    for (let i = 0; i < 40; i++) lines.push(`- Branch ${i}`, `  - Leaf ${i}`)
    const o = parse(lines.join('\n'))
    expect(OUTLINE_MAX_TOPICS).toBe(60)
    expect(o.topics).toBe(60)
    expect(flattenOutline(o.root)).toHaveLength(60)
    // 1 + 40 + 40 = 81 lines: 21 are left out
    expect(o.clipped.topics).toBe(21)
    // the first ones stay, in order: branch 0 with its leaf, up to branch 29
    expect(o.root.children[0]).toEqual({ text: 'Branch 0', children: [{ text: 'Leaf 0', children: [] }] })
    expect(o.root.children.at(-1)?.text).toBe('Branch 29')
  })

  it('a per-topic length cap with an ellipsis, counted', () => {
    const long = 'x'.repeat(OUTLINE_MAX_TOPIC_CHARS + 30)
    const o = parse(`# ${long}\n- short\n- ${'é'.repeat(500)}`)
    expect(Array.from(o.root.text)).toHaveLength(OUTLINE_MAX_TOPIC_CHARS)
    expect(o.root.text.endsWith('…')).toBe(true)
    expect(Array.from(o.root.children[1]?.text ?? '')).toHaveLength(OUTLINE_MAX_TOPIC_CHARS)
    expect(o.clipped.text).toBe(2)
    expect(cutTopic('short')).toBe('short')
    // code points, never half of an emoji
    expect(Array.from(cutTopic('😀'.repeat(200))).at(-1)).toBe('…')
  })

  it('a huge paste is read only so far (lines and characters), and never throws', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `  item ${i}`)
    const o = parse(`Top\n${lines.join('\n')}`)
    expect(o.topics).toBe(60)
  })
})

describe('garbage and look-alikes stay plain notes (null)', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '  \n\t \n'],
    ['one line', 'just one line'],
    ['punctuation only', '---\n***\n___\n!!!\n???'],
    ['control characters', 'Title\n  child\u0000\n  other'],
    ['json', '{\n  "a": {\n    "b": 1\n  }\n}'],
    ['json array', '[\n  "a",\n  "b"\n]'],
    ['html', '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>'],
    ['a table of cells (tab separated)', 'name\trole\nAna\tlead\nBo\tdesign'],
    ['a table with indented rows', 'name\trole\n\tAna\tlead\n\tBo\tdesign'],
  ])('%s', (_name, text) => {
    expect(parseOutline(text)).toBeNull()
    expect(offersMindmap(text)).toBeNull()
  })

  it('code fences and rules are skipped, not topics', () => {
    const o = parse('# Notes\n---\n```\n- not a topic\n```\n- real')
    expect(shape(o.root)).toEqual(['Notes', ['real']])
  })

  it('non-strings are not outlines', () => {
    expect(parseOutline(undefined as unknown as string)).toBeNull()
    expect(parseOutline(42 as unknown as string)).toBeNull()
  })

  it('random printable noise never throws and never claims a hierarchy it cannot read', () => {
    let seed = 7
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const alphabet = ' \t\n#-*+1.)(abc[]_`<>\\~é😀'
    for (let n = 0; n < 300; n++) {
      const text = Array.from({ length: 1 + Math.floor(next() * 200) }, () =>
        alphabet.charAt(Math.floor(next() * alphabet.length)),
      ).join('')
      const o = parseOutline(text)
      if (o) {
        expect(o.topics).toBeLessThanOrEqual(OUTLINE_MAX_TOPICS)
        expect(o.depth).toBeLessThanOrEqual(OUTLINE_MAX_DEPTH)
        expect(flattenOutline(o.root)).toHaveLength(o.topics)
      }
    }
  })
})

describe('ringOutline: a title and its branches (Mind map from a prompt)', () => {
  it('the prompt is the centre, the ideas its children, in order', () => {
    const o = ringOutline('Launch party', ['Names', '  Venue  ', '', 'Music'])
    expect(o && shape(o.root)).toEqual(['Launch party', ['Names', 'Venue', 'Music']])
    expect(o).toMatchObject({ topics: 4, depth: 1, nested: true })
  })
  it('nothing to draw without a title or any branch', () => {
    expect(ringOutline('  ', ['a'])).toBeNull()
    expect(ringOutline('t', [' ', ''])).toBeNull()
  })
  it('keeps to the topic cap', () => {
    const o = ringOutline(
      't',
      Array.from({ length: 100 }, (_, i) => `b${i}`),
    )
    expect(o?.topics).toBe(OUTLINE_MAX_TOPICS)
  })
})
