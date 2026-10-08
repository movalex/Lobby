// K7-1, K7-2, K7-3: the commands that add many topics at once (./commands.ts): addChildTopics (Expand with
// AI), pasteOutlineAsMindmap (Paste as mind map) and mindmapFromIdeas (Mind map from a prompt), each ONE undo
// step, on the in-memory canvas of ../test-canvas.ts.
import { describe, expect, it, vi } from 'vitest'
import { OUTLINE_MAX_TOPICS, parseOutline } from '../outline-parse.ts'
import { type El, fakeMapCanvas, lobbyOf, measure } from '../test-canvas.ts'
import { addChildTopics, type Mindmap, mindmapFromIdeas, pasteOutlineAsMindmap } from './commands.ts'
import { topicMetaOf } from './meta.ts'
import { MindmapRuntime } from './runtime.ts'

function setup(seed: El[] = []) {
  const f = fakeMapCanvas(seed)
  const rt = new MindmapRuntime(f.canvas, (text, fontSize) => measure(text, fontSize))
  rt.index.rebuild(f.canvas.items())
  const notify = vi.fn()
  const m = { rt, notify } as unknown as Mindmap
  const topics = () =>
    [...f.els.values()]
      .filter((e) => !e.isDeleted && e.type !== 'text' && topicMetaOf(e as never))
      .map((e) => ({ id: e.id, text: f.canvas.text.of(e.id), meta: topicMetaOf(e as never) }))
  return { f, rt, m, notify, topics }
}

const ANA = { by: 'usr_ana', kind: 'ai-topic' }

describe('addChildTopics: N children under a topic, tidied, as one transact', () => {
  function withMap() {
    const s = setup()
    const made = mindmapFromIdeas(s.m, 'Campaign', ['Audience', 'Channels', 'Budget'])
    if (!made) throw new Error('no map')
    const topic = s.topics().find((t) => t.text === 'Channels')
    if (!topic) throw new Error('no topic')
    s.f.transacts.length = 0
    return { ...s, topicId: topic.id }
  }

  it('adds the children, bound and tidy; the undo takes all of them back in one step', () => {
    const { f, m, topicId, topics } = withMap()
    const steps = f.steps()
    const before = f.snapshot()
    const made = addChildTopics(m, topicId, ['Instagram', 'TikTok', 'Podcasts', 'Email'], { stamp: ANA })
    expect(made?.children).toHaveLength(4)
    // one undo step: one transact, and the one that binds the lines joined to it
    expect(f.transacts.map((t) => t.joined)).toEqual([false, true])
    expect(f.steps()).toBe(steps + 1)
    const kids = topics().filter((t) => t.meta?.parentId === topicId)
    expect(kids.map((t) => t.text).sort()).toEqual(['Email', 'Instagram', 'Podcasts', 'TikTok'])
    expect(f.undo()).toBe(true)
    expect(f.snapshot()).toBe(before)
  })

  it('leaves out empty words and ones the topic already has (and cuts and cleans the rest)', () => {
    const { m, topicId, topics } = withMap()
    addChildTopics(m, topicId, ['Instagram'])
    const made = addChildTopics(m, topicId, [
      'instagram',
      '  ',
      '**Press** kit',
      'Press kit',
      'x'.repeat(300),
    ])
    expect(made?.children).toHaveLength(2)
    const kids = topics().filter((t) => t.meta?.parentId === topicId)
    expect(kids.map((t) => t.text).sort()).toContain('Press kit')
    expect(kids.find((t) => t.text.startsWith('xxx'))?.text).toHaveLength(120)
  })

  it('nothing new to add: no write, no step', () => {
    const { f, m, topicId } = withMap()
    addChildTopics(m, topicId, ['Instagram'])
    f.transacts.length = 0
    expect(addChildTopics(m, topicId, ['Instagram', ' instagram '])).toBeNull()
    expect(addChildTopics(m, topicId, [])).toBeNull()
    expect(f.transacts).toHaveLength(0)
  })

  it('refuses when the board has no room for the topics and their lines', () => {
    const { f, m, topicId, notify } = withMap()
    const filler: El[] = Array.from({ length: 20_000 }, (_, i) => ({
      id: `f${i}`,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }))
    for (const e of filler) f.els.set(e.id, { frameId: null, groupIds: [], isDeleted: false, angle: 0, ...e })
    expect(addChildTopics(m, topicId, ['One'])).toBeNull()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('too many objects'), 'error')
  })
})

describe('pasteOutlineAsMindmap: an outline is one map in one step', () => {
  const text = '# Brief\n- Goals\n  - Reach\n  - Sales\n- Risks\n  - Budget\n    - Overrun\n'

  it('builds the parsed outline with the right parent links, as one undo step', () => {
    const { f, m, topics } = setup()
    const outline = parseOutline(text)
    if (!outline) throw new Error('no outline')
    const rootId = pasteOutlineAsMindmap(m, outline)
    expect(rootId).not.toBeNull()
    const byText = new Map(topics().map((t) => [t.text, t]))
    expect(byText.size).toBe(outline.topics)
    const parentText = (t: string) => {
      const p = byText.get(t)?.meta?.parentId
      return topics().find((x) => x.id === p)?.text ?? null
    }
    expect(parentText('Brief')).toBeNull()
    expect(parentText('Goals')).toBe('Brief')
    expect(parentText('Reach')).toBe('Goals')
    expect(parentText('Overrun')).toBe('Budget')
    expect(f.transacts.map((t) => t.joined)).toEqual([false, true])
    expect(f.steps()).toBe(1)
    f.undo()
    expect(f.els.size).toBe(0)
  })

  it('keeps to the caps: a 60-topic outline makes 60 topics', () => {
    const { m, topics } = setup()
    const lines = ['# Big']
    for (let i = 0; i < 80; i++) lines.push(`- B${i}`)
    const outline = parseOutline(lines.join('\n'))
    if (!outline) throw new Error('no outline')
    pasteOutlineAsMindmap(m, outline)
    expect(topics()).toHaveLength(OUTLINE_MAX_TOPICS)
  })
})

describe('mindmapFromIdeas: the prompt is the centre, the ideas the first ring, in one transact', () => {
  it('makes the centre from the prompt and the ideas its children, stamped as AI-made', () => {
    const { f, m, topics } = setup()
    const made = mindmapFromIdeas(m, 'Launch party', ['Names', 'Venue', 'Music', 'Food'], { stamp: ANA })
    expect(made?.ids).toHaveLength(5)
    const all = topics()
    const root = all.find((t) => t.meta?.parentId === null)
    expect(root?.text).toBe('Launch party')
    expect(all.filter((t) => t.meta?.parentId === root?.id).map((t) => t.text)).toHaveLength(4)
    expect(f.transacts.map((t) => t.joined)).toEqual([false, true])
    expect(f.steps()).toBe(1)
    for (const t of all) {
      expect(lobbyOf(f.els.get(t.id)).ai).toEqual({ by: 'usr_ana' })
    }
  })

  it('draws nothing when no idea came back or the prompt is empty (never a half map)', () => {
    const { f, m } = setup()
    expect(mindmapFromIdeas(m, 'Party', [])).toBeNull()
    expect(mindmapFromIdeas(m, 'Party', ['  ', ''])).toBeNull()
    expect(mindmapFromIdeas(m, '  ', ['a'])).toBeNull()
    expect(f.transacts).toHaveLength(0)
    expect(f.els.size).toBe(0)
  })
})
