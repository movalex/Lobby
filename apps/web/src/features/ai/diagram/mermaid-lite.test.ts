// L4-3: the Mermaid flowchart subset Paste as diagram reads (./mermaid-lite.ts). 30 fixtures that parse,
// garbage and every refused form that does not, the caps, and K7-2's outline text (which stays a mind map).
import { describe, expect, it } from 'vitest'
import { outlineOfPaste } from '../../canvas-ux/bulk-paste.ts'
import { DIAGRAM_MAX_EDGES, DIAGRAM_MAX_NODES } from './graph.ts'
import { parseMermaidLite } from './mermaid-lite.ts'

/** A parse as plain lines: "direction", "id:kind:label" per node, "from>to[:label][ dashed][ open]" per edge. */
function lines(text: string): string[] | null {
  const g = parseMermaidLite(text)
  if (!g) return null
  return [
    g.direction,
    ...g.nodes.map((n) => `${n.id}:${n.kind}:${n.label}`),
    ...g.edges.map(
      (e) =>
        `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}${e.dashed ? ' dashed' : ''}${e.open ? ' open' : ''}`,
    ),
  ]
}

const FIXTURES: readonly [string, string, string[]][] = [
  ['the smallest chart', 'flowchart TD\nA --> B', ['down', 'A:process:A', 'B:process:B', 'A>B']],
  ['graph is the same keyword', 'graph TD\nA-->B', ['down', 'A:process:A', 'B:process:B', 'A>B']],
  ['TB reads down', 'flowchart TB\nA --> B', ['down', 'A:process:A', 'B:process:B', 'A>B']],
  ['LR reads right', 'flowchart LR\nA --> B', ['right', 'A:process:A', 'B:process:B', 'A>B']],
  ['lower-case direction', 'flowchart lr\nA --> B', ['right', 'A:process:A', 'B:process:B', 'A>B']],
  [
    'rectangles with labels',
    'flowchart TD\nA[Brief] --> B[Concept]',
    ['down', 'A:process:Brief', 'B:process:Concept', 'A>B'],
  ],
  [
    'a decision diamond',
    'flowchart TD\nA[Review] --> B{Approved?}',
    ['down', 'A:process:Review', 'B:decision:Approved?', 'A>B'],
  ],
  [
    'a terminal circle',
    'flowchart TD\nS((Start)) --> A[Work]',
    ['down', 'S:terminal:Start', 'A:process:Work', 'S>A'],
  ],
  [
    'a stadium is a terminal',
    'flowchart TD\nS([Start]) --> E([End])',
    ['down', 'S:terminal:Start', 'E:terminal:End', 'S>E'],
  ],
  [
    'a rounded box is a process',
    'flowchart TD\nA(Draft) --> B(Edit)',
    ['down', 'A:process:Draft', 'B:process:Edit', 'A>B'],
  ],
  [
    'parallelograms are io',
    'flowchart TD\nI[/Upload brief/] --> O[\\Export\\]',
    ['down', 'I:io:Upload brief', 'O:io:Export', 'I>O'],
  ],
  [
    'a chain',
    'flowchart LR\nA --> B --> C --> D',
    ['right', 'A:process:A', 'B:process:B', 'C:process:C', 'D:process:D', 'A>B', 'B>C', 'C>D'],
  ],
  ['a dotted link', 'flowchart TD\nA -.-> B', ['down', 'A:process:A', 'B:process:B', 'A>B dashed']],
  ['a texted link', 'flowchart TD\nA -- yes --> B', ['down', 'A:process:A', 'B:process:B', 'A>B:yes']],
  ['a pipe label', 'flowchart TD\nA -->|no| B', ['down', 'A:process:A', 'B:process:B', 'A>B:no']],
  [
    'a dotted texted link',
    'flowchart TD\nA -. maybe .-> B',
    ['down', 'A:process:A', 'B:process:B', 'A>B:maybe dashed'],
  ],
  [
    'a thick link',
    'flowchart TD\nA ==> B\nB == done ==> C',
    ['down', 'A:process:A', 'B:process:B', 'C:process:C', 'A>B', 'B>C:done'],
  ],
  ['an open link', 'flowchart TD\nA --- B', ['down', 'A:process:A', 'B:process:B', 'A>B open']],
  [
    'semicolons between statements',
    'graph TD;A-->B;B-->C;',
    ['down', 'A:process:A', 'B:process:B', 'C:process:C', 'A>B', 'B>C'],
  ],
  [
    'comments and styling are skipped',
    'flowchart TD\n%% the flow\nA --> B\nstyle A fill:#f9f\nclassDef hot fill:#f00\nclass B hot\nlinkStyle 0 stroke:#333',
    ['down', 'A:process:A', 'B:process:B', 'A>B'],
  ],
  [
    'a quoted label keeps its punctuation',
    'flowchart TD\nA["Brief; (v2)"] --> B',
    ['down', 'A:process:Brief; (v2)', 'B:process:B', 'A>B'],
  ],
  [
    'a line break in a label',
    'flowchart TD\nA[Client<br>review] --> B',
    ['down', 'A:process:Client\nreview', 'B:process:B', 'A>B'],
  ],
  [
    'the first label of a node wins; a bare mention keeps it',
    'flowchart TD\nA[Brief] --> B\nA --> C\nB[Concept]',
    ['down', 'A:process:Brief', 'B:process:Concept', 'C:process:C', 'A>B', 'A>C'],
  ],
  [
    'a cycle is kept as written',
    'flowchart TD\nA --> B\nB --> C\nC -->|rejected| A',
    ['down', 'A:process:A', 'B:process:B', 'C:process:C', 'A>B', 'B>C', 'C>A:rejected'],
  ],
  [
    'a repeated link is drawn once',
    'flowchart TD\nA --> B\nA --> B',
    ['down', 'A:process:A', 'B:process:B', 'A>B'],
  ],
  ['a self-loop is dropped', 'flowchart TD\nA --> A\nA --> B', ['down', 'A:process:A', 'B:process:B', 'A>B']],
  ['nodes without links', 'flowchart TD\nA[One]\nB[Two]', ['down', 'A:process:One', 'B:process:Two']],
  [
    'indentation and Windows line ends',
    'flowchart TD\r\n    A[Start] --> B{Ok?}\r\n    B -->|yes| C((Done))\r\n',
    ['down', 'A:process:Start', 'B:decision:Ok?', 'C:terminal:Done', 'A>B', 'B>C:yes'],
  ],
  [
    'no spaces around links',
    'flowchart LR\nA[x]-->B{y}-.->C((z))',
    ['right', 'A:process:x', 'B:decision:y', 'C:terminal:z', 'A>B', 'B>C dashed'],
  ],
  [
    'the producer flow from the brief',
    [
      'flowchart TD',
      '  brief[Brief] --> concept[Concept]',
      '  concept --> internal[Internal review]',
      '  internal --> client{Client review}',
      '  client -->|rejected| concept',
      '  client -->|approved| prod((Production))',
    ].join('\n'),
    [
      'down',
      'brief:process:Brief',
      'concept:process:Concept',
      'internal:process:Internal review',
      'client:decision:Client review',
      'prod:terminal:Production',
      'brief>concept',
      'concept>internal',
      'internal>client',
      'client>concept:rejected',
      'client>prod:approved',
    ],
  ],
]

describe('mermaid-lite: the flowchart subset', () => {
  it('has 30 fixtures', () => {
    expect(FIXTURES).toHaveLength(30)
  })
  for (const [name, text, want] of FIXTURES)
    it(name, () => {
      expect(lines(text)).toEqual(want)
    })
})

describe('mermaid-lite: everything else is not a diagram (null)', () => {
  const NOT: readonly [string, string][] = [
    ['empty', ''],
    ['spaces', '   \n  '],
    ['plain words', 'Buy milk and eggs'],
    ['a sentence with an arrow', 'Brief --> Concept'],
    ['no header', 'A --> B\nB --> C'],
    ['another diagram type', 'sequenceDiagram\nAlice->>Bob: Hi'],
    ['a class diagram', 'classDiagram\nAnimal <|-- Duck'],
    ['an unsupported direction', 'flowchart RL\nA --> B'],
    ['a header with no statements', 'flowchart TD'],
    ['one node only', 'flowchart TD\nA[Alone]'],
    ['a subgraph', 'flowchart TD\nsubgraph one\nA --> B\nend'],
    ['a click handler', 'flowchart TD\nA --> B\nclick A callback'],
    ['a fan-out with &', 'flowchart TD\nA --> B & C'],
    ['an unclosed shape', 'flowchart TD\nA[Brief --> B'],
    ['an unclosed quote', 'flowchart TD\nA["Brief] --> B'],
    ['a link to nothing', 'flowchart TD\nA -->'],
    ['two ids with no link', 'flowchart TD\nA B'],
    ['an unknown link', 'flowchart TD\nA ~~> B'],
    ['a texted link without its end', 'flowchart TD\nA -- yes B'],
    ['JSON', '{"nodes": [1, 2]}'],
    ['an empty pipe label is fine but a stray pipe is not', 'flowchart TD\nA -->|oops B'],
  ]
  for (const [name, text] of NOT)
    it(name, () => {
      expect(parseMermaidLite(text)).toBeNull()
    })

  it('garbage of every shape is null, never a throw', () => {
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const alphabet = 'AB12 -->.|[](){}/\\"%;\n=&flowchart TD'
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rnd() * 80)
      let s = ''
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)]
      const text = rnd() < 0.5 ? `flowchart TD\n${s}` : s
      expect(() => parseMermaidLite(text)).not.toThrow()
      const g = parseMermaidLite(text)
      if (g) {
        expect(g.nodes.length).toBeGreaterThanOrEqual(2)
        expect(g.nodes.length).toBeLessThanOrEqual(DIAGRAM_MAX_NODES)
        expect(g.edges.length).toBeLessThanOrEqual(DIAGRAM_MAX_EDGES)
      }
    }
  })
})

describe('mermaid-lite: the caps', () => {
  it(`takes ${DIAGRAM_MAX_NODES} nodes and refuses one more`, () => {
    const chain = (n: number) =>
      ['flowchart TD', ...Array.from({ length: n - 1 }, (_, i) => `N${i} --> N${i + 1}`)].join('\n')
    const at = parseMermaidLite(chain(DIAGRAM_MAX_NODES))
    expect(at?.nodes).toHaveLength(DIAGRAM_MAX_NODES)
    expect(at?.edges).toHaveLength(DIAGRAM_MAX_NODES - 1)
    expect(parseMermaidLite(chain(DIAGRAM_MAX_NODES + 1))).toBeNull()
  })

  it(`takes ${DIAGRAM_MAX_EDGES} links and refuses one more`, () => {
    // 11 nodes, every link from a lower to a higher one: 55, then more pairs both ways
    const pairs: string[] = []
    for (let a = 0; a < 11 && pairs.length < DIAGRAM_MAX_EDGES + 1; a++)
      for (let b = 0; b < 11 && pairs.length < DIAGRAM_MAX_EDGES + 1; b++)
        if (a !== b) pairs.push(`N${a} --> N${b}`)
    const at = parseMermaidLite(['flowchart TD', ...pairs.slice(0, DIAGRAM_MAX_EDGES)].join('\n'))
    expect(at?.edges).toHaveLength(DIAGRAM_MAX_EDGES)
    expect(parseMermaidLite(['flowchart TD', ...pairs].join('\n'))).toBeNull()
  })

  it('a long label is cut to the label cap', () => {
    const g = parseMermaidLite(`flowchart TD\nA[${'word '.repeat(40)}] --> B`)
    expect([...(g?.nodes[0]?.label ?? '')].length).toBeLessThanOrEqual(60)
    expect(g?.nodes[0]?.label.endsWith('…')).toBe(true)
  })

  it('a very long paste is not read at all', () => {
    expect(parseMermaidLite(`flowchart TD\nA --> B\n${'%% x\n'.repeat(5000)}`)).toBeNull()
  })
})

describe('K7-2 outline text is not Mermaid (it stays a mind map paste)', () => {
  const OUTLINES = [
    [
      '# Launch plan',
      '- Audience',
      '  - Leadership',
      '  - Fans',
      '- Channels',
      '  - Social',
      '- Budget',
    ].join('\n'),
    'Plan\n\tBudget\n\t\tFees\n\t\tTravel\n\tDates',
    '* Plan\n  + Budget\n    1. Fees\n    2. Travel\n  - Dates\n',
    '# flowchart TD\n- A --> B\n- B --> C',
  ]
  for (const text of OUTLINES)
    it(JSON.stringify(text.slice(0, 24)), () => {
      expect(outlineOfPaste(text)).not.toBeNull()
      expect(parseMermaidLite(text)).toBeNull()
    })
})
