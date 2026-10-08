// K7-1, K7-2, K7-3: the mind map's bulk writes (./runtime.ts addChildren, createMapFromOutline) on an in-memory
// canvas (../test-canvas.ts): a whole outline, or a batch of children, is ONE undo step (one transact, plus
// the second one that binds the lines, joined to it), laid out, with every line bound to its parent and child,
// never overlapping, and nothing written when the person cannot edit. The browser path (the server accepting
// every element, the arrows' ends derived by it) is e2e/excalidraw/k7-*.spec.ts.
import { describe, expect, it } from 'vitest'
import type { OutlineNode } from '../outline-parse.ts'
import { type El, fakeMapCanvas, lobbyOf, measure } from '../test-canvas.ts'
import { edgeMetaOf, topicMetaOf } from './meta.ts'
import { MindmapRuntime } from './runtime.ts'

const leaf = (text: string): OutlineNode => ({ text, children: [] })
const node = (text: string, ...children: OutlineNode[]): OutlineNode => ({ text, children })

function setup(
  seed: El[] = [],
  viewport?: { x: number; y: number; width: number; height: number; zoom: number },
) {
  const f = fakeMapCanvas(seed, viewport ? { viewport } : {})
  const rt = new MindmapRuntime(f.canvas, (text, fontSize) => measure(text, fontSize))
  rt.index.rebuild(f.canvas.items())
  return { f, rt }
}

type Topic = { id: string; text: string; el: El; meta: NonNullable<ReturnType<typeof topicMetaOf>> }
function topics(f: ReturnType<typeof fakeMapCanvas>): Topic[] {
  const out: Topic[] = []
  for (const e of f.els.values()) {
    if (e.isDeleted || e.type === 'text') continue
    const meta = topicMetaOf(e as never)
    if (!meta) continue
    out.push({ id: e.id, el: e, meta, text: f.canvas.text.of(e.id) })
  }
  return out
}
const lines = (f: ReturnType<typeof fakeMapCanvas>) =>
  [...f.els.values()].filter((e) => !e.isDeleted && e.type === 'arrow' && edgeMetaOf(e as never))
/** "parent > child" pairs by text, sorted: a structure fingerprint independent of ids. */
function structure(f: ReturnType<typeof fakeMapCanvas>): string[] {
  const all = topics(f)
  const text = new Map(all.map((t) => [t.id, t.text]))
  return all
    .map((t) => (t.meta.parentId ? `${text.get(t.meta.parentId)} > ${t.text}` : `(root) ${t.text}`))
    .sort()
}
const overlap = (a: El, b: El) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5
function problems(f: ReturnType<typeof fakeMapCanvas>): string[] {
  const out: string[] = []
  const all = topics(f)
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      if (overlap((all[i] as Topic).el, (all[j] as Topic).el))
        out.push(`"${(all[i] as Topic).text}" overlaps "${(all[j] as Topic).text}"`)
  const ls = lines(f)
  for (const t of all) {
    if (!t.meta.parentId) continue
    const mine = ls.filter((l) => edgeMetaOf(l as never)?.childId === t.id)
    if (mine.length !== 1) out.push(`"${t.text}" has ${mine.length} lines`)
    const l = mine[0] as El & {
      startBinding?: { elementId: string } | null
      endBinding?: { elementId: string } | null
    }
    if (l && (l.startBinding?.elementId !== t.meta.parentId || l.endBinding?.elementId !== t.id))
      out.push(`the line to "${t.text}" is not bound to its parent and to it`)
  }
  return out
}

const OUTLINE = node(
  'Launch plan',
  node('Audience', leaf('Leadership'), leaf('Fans')),
  node('Channels', leaf('Social'), leaf('Press')),
  leaf('Budget'),
  node('Timeline', leaf('Teaser'), leaf('Premiere')),
)

describe('createMapFromOutline: a pasted outline is one map, in one undo step', () => {
  it('makes every topic with its words, the parent links, bound lines and a tidy layout', () => {
    const { f, rt } = setup()
    const built = rt.createMapFromOutline(OUTLINE)
    expect(built?.ids).toHaveLength(11)
    expect(structure(f)).toEqual(
      [
        '(root) Launch plan',
        'Launch plan > Audience',
        'Launch plan > Channels',
        'Launch plan > Budget',
        'Launch plan > Timeline',
        'Audience > Leadership',
        'Audience > Fans',
        'Channels > Social',
        'Channels > Press',
        'Timeline > Teaser',
        'Timeline > Premiere',
      ].sort(),
    )
    // one central topic that names itself root, every other topic names that root
    const all = topics(f)
    const root = all.find((t) => !t.meta.parentId) as Topic
    expect(root.meta.rootId).toBe(root.id)
    expect(all.every((t) => t.meta.rootId === root.id)).toBe(true)
    expect(lines(f)).toHaveLength(10)
    expect(problems(f)).toEqual([])
    // each topic's words are its bound label
    for (const t of all) {
      const label = (t.el.boundElements as { id: string; type: string }[] | null)?.find(
        (b) => b.type === 'text',
      )
      expect(label).toBeDefined()
      expect((f.els.get(label?.id as string) as El).containerId).toBe(t.id)
    }
    expect(f.selected).toEqual([root.id])
  })

  it('is ONE undo step: one transact and the second one that binds the lines, joined; undo leaves nothing', () => {
    const { f, rt } = setup()
    const before = f.snapshot()
    rt.createMapFromOutline(OUTLINE)
    expect(f.transacts.map((t) => t.joined)).toEqual([false, true])
    expect(f.steps()).toBe(1)
    expect(f.undo()).toBe(true)
    expect(f.snapshot()).toBe(before)
    expect(f.els.size).toBe(0)
  })

  it('the first ring is balanced between the sides and read clockwise (the export order)', () => {
    const { f, rt } = setup()
    rt.createMapFromOutline(node('Hub', leaf('A'), leaf('B'), leaf('C'), leaf('D'), leaf('E'), leaf('F')))
    const ring = topics(f).filter((t) => t.meta.parentId !== null)
    const right = ring.filter((t) => t.meta.side === 'right').sort((a, b) => a.el.y - b.el.y)
    const left = ring.filter((t) => t.meta.side === 'left').sort((a, b) => a.el.y - b.el.y)
    expect(right.map((t) => t.text)).toEqual(['A', 'B', 'C'])
    // the left side reads bottom to top: D is the lowest, F the highest
    expect(left.map((t) => t.text)).toEqual(['F', 'E', 'D'])
    // every line leaves the parent on the side of its branch
    expect(problems(f)).toEqual([])
  })

  it('colours the branches apart and keeps a deeper topic in its branch colour', () => {
    const { f, rt } = setup()
    rt.createMapFromOutline(OUTLINE)
    const all = topics(f)
    const stroke = (text: string) => all.find((t) => t.text === text)?.el.strokeColor
    expect(new Set(['Audience', 'Channels', 'Budget', 'Timeline'].map(stroke)).size).toBe(4)
    expect(stroke('Leadership')).toBe(stroke('Audience'))
    expect(stroke('Social')).toBe(stroke('Channels'))
    expect(stroke('Launch plan')).not.toBe(stroke('Audience'))
  })

  it('lands where a new map goes: clear of what is there, at the view centre', () => {
    const wall: El = { id: 'wall', type: 'rectangle', x: -300, y: -200, width: 600, height: 400 }
    const { f, rt } = setup([wall])
    rt.createMapFromOutline(OUTLINE)
    for (const t of topics(f)) expect(overlap(t.el, wall)).toBe(false)
    expect(problems(f)).toEqual([])
    // a free board puts it around the centre of the view
    const free = setup()
    free.rt.createMapFromOutline(OUTLINE, { center: { x: 5000, y: 3000 } })
    const boxes = topics(free.f).map((t) => t.el)
    const cx = (Math.min(...boxes.map((b) => b.x)) + Math.max(...boxes.map((b) => b.x + b.width))) / 2
    const cy = (Math.min(...boxes.map((b) => b.y)) + Math.max(...boxes.map((b) => b.y + b.height))) / 2
    expect(Math.abs(cx - 5000)).toBeLessThan(200)
    expect(Math.abs(cy - 3000)).toBeLessThan(200)
  })

  it('brings a map larger than the view into view, zooming out only', () => {
    const { f, rt } = setup([], { x: 0, y: 0, width: 300, height: 200, zoom: 1 })
    rt.createMapFromOutline(OUTLINE)
    expect(f.zoomTo).toHaveLength(1)
    expect((f.zoomTo[0]?.opts as { maxZoom: number } | undefined)?.maxZoom).toBe(1)
  })

  it('a stamp marks every topic and line made (create-only keys, set in the write that makes them)', () => {
    const { f, rt } = setup()
    rt.createMapFromOutline(node('Theme', leaf('One'), leaf('Two')), {
      stamp: { by: 'usr_ana', kind: 'ai-topic' },
    })
    for (const t of topics(f)) {
      const lobby = (t.el.customData as { lobby: Record<string, unknown> }).lobby
      expect(lobby.ai).toEqual({ by: 'usr_ana' })
      expect(lobby.kind).toBe('ai-topic')
      expect(lobby.mindmap).toBeDefined()
    }
    for (const l of lines(f)) {
      const lobby = (l.customData as { lobby: Record<string, unknown> }).lobby
      expect(lobby.ai).toEqual({ by: 'usr_ana' })
      expect(lobby.kind).toBeUndefined()
    }
  })

  it('writes nothing for someone who cannot edit', () => {
    const { f, rt } = setup()
    f.setReadOnly(true)
    expect(rt.createMapFromOutline(OUTLINE)).toBeNull()
    expect(f.transacts).toHaveLength(0)
    expect(f.els.size).toBe(0)
  })

  it('a long list is still one tidy map: 59 branches, one step', () => {
    const { f, rt } = setup()
    const wide = node('Big', ...Array.from({ length: 29 }, (_, i) => node(`B${i}`, leaf(`L${i}`))))
    const built = rt.createMapFromOutline(wide)
    expect(built?.ids).toHaveLength(59)
    expect(f.steps()).toBe(1)
    expect(problems(f)).toEqual([])
  })
})

describe('addChildren: Expand with AI adds N children under a topic in one undo step', () => {
  function mapWith() {
    const s = setup()
    const built = s.rt.createMapFromOutline(
      node('Hub', node('Left one', leaf('x')), node('Right one'), leaf('Third')),
    )
    const byText = (t: string) => topics(s.f).find((x) => x.text === t) as Topic
    // the setup is its own step: start counting from here
    s.f.transacts.length = 0
    return { ...s, built, byText }
  }

  it('adds the children after the topic, bound to it and tidy, as ONE transact (and the joined one that binds)', () => {
    const { f, rt, byText } = mapWith()
    const before = structure(f)
    const topic = byText('Right one')
    const made = rt.addChildren(topic.id, [leaf('Idea 1'), leaf('Idea 2'), leaf('Idea 3'), leaf('Idea 4')])
    expect(made?.children).toHaveLength(4)
    expect(f.transacts.map((t) => t.joined)).toEqual([false, true])
    expect(structure(f)).toEqual(
      [
        ...before,
        'Right one > Idea 1',
        'Right one > Idea 2',
        'Right one > Idea 3',
        'Right one > Idea 4',
      ].sort(),
    )
    expect(problems(f)).toEqual([])
    // they sit on the topic's side and read top to bottom in the order given
    const kids = (made?.children ?? []).map((id) => f.els.get(id) as El)
    expect(
      new Set(
        topics(f)
          .filter((t) => made?.children.includes(t.id))
          .map((t) => t.meta.side),
      ),
    ).toEqual(new Set([topic.meta.side]))
    expect([...kids].sort((a, b) => a.y - b.y).map((e) => f.canvas.text.of(e.id))).toEqual([
      'Idea 1',
      'Idea 2',
      'Idea 3',
      'Idea 4',
    ])
    // selected, so the next step starts from them
    expect(f.selected.sort()).toEqual([...(made?.children ?? [])].sort())
  })

  it('one undo removes all of them: topics, labels and lines', () => {
    const { f, rt, byText } = mapWith()
    const before = f.snapshot()
    rt.addChildren(byText('Third').id, [leaf('a'), leaf('b'), leaf('c')])
    expect(f.steps()).toBe(2) // the map, and the children
    expect(f.snapshot()).not.toBe(before)
    f.undo()
    expect(f.snapshot()).toBe(before)
  })

  it('under the central topic a new branch goes to the lighter side', () => {
    const s = setup()
    s.rt.createMapFromOutline(node('Hub', leaf('R1'), leaf('R2')))
    // two branches: one each side. Add three more: the sides stay level (3 and 2, not 5 and 0)
    const hub = topics(s.f).find((t) => t.text === 'Hub') as Topic
    const made = s.rt.addChildren(hub.id, [leaf('N1'), leaf('N2'), leaf('N3')])
    const sides = (made?.children ?? []).map(
      (id) => (topicMetaOf(s.f.els.get(id) as never) as { side: string }).side,
    )
    const all = topics(s.f).filter((t) => t.meta.parentId === hub.id)
    const right = all.filter((t) => t.meta.side === 'right').length
    const left = all.filter((t) => t.meta.side === 'left').length
    expect(Math.abs(right - left)).toBeLessThanOrEqual(1)
    expect(new Set(sides).size).toBe(2)
    expect(problems(s.f)).toEqual([])
  })

  it('opens a collapsed topic and keeps the existing children where they were in the order', () => {
    const { f, rt, byText } = mapWith()
    const topic = byText('Left one')
    const meta = topicMetaOf(topic.el as never) as NonNullable<ReturnType<typeof topicMetaOf>>
    f.canvas.items() // keep the fake warm
    f.els.set(topic.id, {
      ...(topic.el as El),
      customData: { lobby: { mindmap: { ...meta, collapsed: true } } },
    })
    rt.index.rebuild(f.canvas.items())
    rt.addChildren(topic.id, [leaf('fresh')])
    expect(topicMetaOf(f.els.get(topic.id) as never)?.collapsed).toBe(false)
    const kids = topics(f)
      .filter((t) => t.meta.parentId === topic.id)
      .sort((a, b) => a.el.y - b.el.y)
      .map((t) => t.text)
    expect(kids).toEqual(['x', 'fresh'])
  })

  it('a stamp marks the new topics and lines; the ones that were there stay as they were', () => {
    const { f, rt, byText } = mapWith()
    const made = rt.addChildren(byText('Third').id, [leaf('ai one')], {
      stamp: { by: 'usr_ana', kind: 'ai-topic' },
    })
    const id = made?.children[0] as string
    expect(lobbyOf(f.els.get(id)).ai).toEqual({ by: 'usr_ana' })
    expect(lobbyOf(byText('Right one').el).ai).toBeUndefined()
  })

  it('nothing to add, a missing topic, or a viewer: null and no write', () => {
    const { f, rt, byText } = mapWith()
    expect(rt.addChildren(byText('Third').id, [])).toBeNull()
    expect(rt.addChildren('nope', [leaf('a')])).toBeNull()
    f.setReadOnly(true)
    expect(rt.addChildren(byText('Third').id, [leaf('a')])).toBeNull()
    expect(f.transacts).toHaveLength(0)
  })

  it('several levels at once: children with their own children, one step', () => {
    const { f, rt, byText } = mapWith()
    const topic = byText('Third')
    const made = rt.addChildren(topic.id, [node('a', leaf('a1'), leaf('a2')), leaf('b')])
    expect(made?.ids).toHaveLength(4)
    expect(made?.children).toHaveLength(2)
    expect(f.steps()).toBe(2)
    expect(structure(f)).toContain('a > a1')
    expect(problems(f)).toEqual([])
  })
})
