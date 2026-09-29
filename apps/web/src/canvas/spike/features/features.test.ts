// Spike B (O5): the features' rules in Node, on a fake port (every write through `transact`) and a fake
// engine core (`doc()`/`setDoc()`, the CR). The browser halves are B1.2/U1/U2 (O3's and O2's specs, with
// these features on the board page), R2, B7 and B12 (e2e/spike-b/tests/b5-r2-*, b7-*, b12-*).
import { describe, expect, it } from 'vitest'
import type { CanvasElement, CanvasPort, CanvasTx } from '../../port.ts'
import { createRegistries } from '../../registries.ts'
import {
  collapsePatch,
  commentAnchorFor,
  hasChildren,
  mindmapHidden,
  plusOnePatch,
  plusOnesOf,
  tagsOf,
  tagWrite,
  voteRefOf,
  voteTargetOf,
} from './model.ts'
import { boardIdFromPath, FeatureRuntime } from './runtime.ts'
import { plusOne, tagElements, untagElements } from './tags.tsx'

const el = (id: string, type: string, extra: Record<string, unknown> = {}): CanvasElement =>
  ({
    id,
    type,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: 'a0',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    ...extra,
  }) as unknown as CanvasElement

/** A port over a map: `transact` records each step's updates and applies them (per `customData.lobby` key). */
function fakePort(
  elements: CanvasElement[],
  you = { uid: 'usr_me', name: 'Me', color: '#000', role: 'editor' as const, guest: false },
) {
  const map = new Map(elements.map((e) => [e.id, e]))
  const steps: { label: string; updates: [string, Record<string, unknown>][] }[] = []
  const doc = new Map<string, unknown>()
  const docWrites: Record<string, unknown>[] = []
  const engine = {
    welcome: { you },
    doc: () => doc,
    setDoc: (set: Record<string, unknown>) => {
      docWrites.push(set)
      for (const [k, v] of Object.entries(set)) {
        if (v === null) doc.delete(k)
        else doc.set(k, v)
      }
    },
  }
  const port = {
    items: () => [...map.values()].filter((e) => !e.isDeleted),
    get: (id: string) => map.get(id),
    engine,
    transact<T>(label: string, fn: (tx: CanvasTx) => T): T {
      const updates: [string, Record<string, unknown>][] = []
      const tx: CanvasTx = {
        create: () => {
          throw new Error('not in this test')
        },
        update: (id, patch) => {
          updates.push([id, patch as Record<string, unknown>])
          const cur = map.get(id) as unknown as Record<string, unknown>
          const lobby = {
            ...((cur.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}),
          }
          const p = (patch as { customData?: { lobby?: Record<string, unknown> } }).customData?.lobby ?? {}
          for (const [k, v] of Object.entries(p)) {
            if (v === null) delete lobby[k]
            else lobby[k] = v
          }
          map.set(id, { ...cur, customData: { lobby } } as unknown as CanvasElement)
        },
        delete: () => {},
      }
      const r = fn(tx)
      steps.push({ label, updates })
      return r
    },
  } as unknown as CanvasPort
  const rt = new FeatureRuntime(port, createRegistries(), 'b-spikeboard')
  return { port, rt, steps, doc, docWrites, map }
}

describe('tags (B1.2, U2): tagDef first, then the element key, one undo step', () => {
  it('defines a new tag on the board, then tags every target in one transact step', () => {
    const { rt, steps, docWrites, port } = fakePort([el('n1', 'stickynote'), el('n2', 'stickynote')])
    const r = tagElements(rt, ['n1', 'n2', 'missing'], '  #Research ')
    expect(r).toEqual({ ok: true, key: 'research' })
    expect(docWrites).toEqual([{ 'tagDef:research': { name: 'Research', color: 'blue' } }])
    expect(steps).toHaveLength(1)
    expect(steps[0]?.updates.map(([id]) => id)).toEqual(['n1', 'n2'])
    expect(tagsOf(port.get('n1'))).toEqual([{ key: 'research', name: 'Research', color: 'blue' }])
    // the same tag again: no second doc write, and its colour is the board's
    tagElements(rt, ['n2'], 'research', 'red')
    expect(docWrites).toHaveLength(1)
    expect(tagsOf(port.get('n2'))[0]?.color).toBe('blue')
    // a second tag takes the next colour of the rotation
    tagElements(rt, ['n1'], 'Ideas')
    expect(docWrites.at(-1)).toEqual({ 'tagDef:ideas': { name: 'Ideas', color: 'green' } })
    untagElements(rt, ['n1', 'n2'], 'research')
    expect(tagsOf(port.get('n1')).map((t) => t.key)).toEqual(['ideas'])
    expect(tagsOf(port.get('n2'))).toEqual([])
  })

  it('refuses an empty or too long name, and nothing selected', () => {
    const { rt, steps, docWrites } = fakePort([el('n1', 'stickynote')])
    expect(tagElements(rt, ['n1'], '   ').ok).toBe(false)
    expect(tagElements(rt, ['n1'], 'x'.repeat(40)).ok).toBe(false)
    expect(tagElements(rt, [], 'fine').ok).toBe(false)
    expect(steps).toEqual([])
    expect(docWrites).toEqual([])
    expect(tagWrite('#Two  Words')).toMatchObject({
      ok: true,
      key: 'two-words',
      value: { name: 'Two Words' },
    })
  })

  it('reads only valid tags (a key that does not match its name is ignored)', () => {
    const n = el('n', 'stickynote', {
      customData: {
        lobby: {
          'tag:ok': { name: 'OK', color: 'red' },
          'tag:wrong': { name: 'Other', color: 'red' },
          'tag:badcolor': { name: 'badcolor', color: '#123456' },
          'plusOne:usr_a': true,
        },
      },
    })
    expect(tagsOf(n).map((t) => t.key)).toEqual(['ok'])
  })
})

describe('+1 (U1, F13): only my own key, one step, refused while a vote runs', () => {
  it('toggles plusOne:<my uid> = true / null', () => {
    const { rt, steps, port } = fakePort([
      el('n', 'stickynote', { customData: { lobby: { 'plusOne:usr_bob': true } } }),
    ])
    expect(plusOne(rt, 'n')).toBe(true)
    expect(plusOnesOf(port.get('n'))).toEqual(['usr_bob', 'usr_me'])
    expect(steps[0]?.updates).toEqual([['n', { customData: { lobby: { 'plusOne:usr_me': true } } }]])
    expect(plusOne(rt, 'n', true)).toBe(false) // already set: nothing written
    expect(plusOne(rt, 'n')).toBe(true)
    expect(plusOnesOf(port.get('n'))).toEqual(['usr_bob'])
    expect(steps.at(-1)?.updates).toEqual([['n', { customData: { lobby: { 'plusOne:usr_me': null } } }]])
    // while a vote runs: no new +1 (taking one back is still allowed)
    expect(plusOne(rt, 'n', true, true)).toBe(false)
    expect(steps).toHaveLength(2)
    expect(rt.currentToast()).toBe('+1 is off while a vote runs')
    rt.dispose()
  })

  it('never on a label, an arrow or a frame', () => {
    expect(plusOnePatch(el('t', 'text', { containerId: 'n' }), 'u')).not.toBeNull() // the patch itself is pure
    const { rt } = fakePort([el('t', 'text', { containerId: 'n' }), el('a', 'arrow'), el('F', 'frame')])
    expect(plusOne(rt, 't')).toBe(false)
    expect(plusOne(rt, 'a')).toBe(false)
    expect(plusOne(rt, 'F')).toBe(false)
    rt.dispose()
  })
})

describe('votes and comment pins: targets', () => {
  const note = el('n', 'stickynote', { x: 100, y: 100, width: 200, height: 100 })
  const label = el('n.t', 'text', { containerId: 'n' })
  const get = (id: string) => ({ n: note, 'n.t': label })[id as 'n']
  it('a bound label votes for its note; arrows, lines and strokes take no vote', () => {
    expect(voteTargetOf(label, get)?.id).toBe('n')
    expect(voteTargetOf(el('a', 'arrow'), get)).toBeNull()
    expect(voteTargetOf(null, get)).toBeNull()
    expect(voteRefOf(note)).toBe('shape:n')
    expect(voteRefOf(el('converted.o', 'line'))).toBeNull() // the vote id pattern has no '.'
  })
  it('a pin on an object is anchored in its box (it follows it); elsewhere at the board point', () => {
    expect(commentAnchorFor({ x: 150, y: 125 }, note)).toEqual({
      kind: 'shape',
      shapeId: 'shape:n',
      u: 0.25,
      v: 0.25,
    })
    expect(commentAnchorFor({ x: 10.4, y: -3.6 }, null)).toEqual({ kind: 'point', x: 10, y: -4 })
  })
})

describe('mind-map collapse prototype (B12, §4.7)', () => {
  const topic = (id: string, parentId: string | null, collapsed = false) =>
    el(id, 'rectangle', {
      customData: { lobby: { mindmap: { rootId: 'root', parentId, side: 'right', collapsed } } },
    })
  const edge = (id: string, parentId: string, childId: string) =>
    el(id, 'arrow', { customData: { lobby: { mindmapEdge: { rootId: 'root', parentId, childId } } } })
  const tree = (collapsedA: boolean) => [
    topic('root', null),
    topic('a', 'root', collapsedA),
    topic('a1', 'a'),
    topic('a1x', 'a1'),
    topic('b', 'root'),
    edge('e-root-a', 'root', 'a'),
    edge('e-a-a1', 'a', 'a1'),
    edge('e-a1-a1x', 'a1', 'a1x'),
    edge('e-root-b', 'root', 'b'),
  ]
  it('hides every descendant of a collapsed topic and the edges into them; the topic itself stays', () => {
    expect([...mindmapHidden(tree(true))].sort()).toEqual(['a1', 'a1x', 'e-a-a1', 'e-a1-a1x'])
    expect(mindmapHidden(tree(false)).size).toBe(0)
    expect(hasChildren(tree(true), 'a')).toBe(true)
    expect(hasChildren(tree(true), 'b')).toBe(false)
  })
  it('only `collapsed` changes, on the parent', () => {
    const a = topic('a', 'root')
    expect(collapsePatch(a, true)).toEqual({
      mindmap: { rootId: 'root', parentId: 'root', side: 'right', collapsed: true },
    })
    expect(collapsePatch(a, false)).toBeNull()
    expect(collapsePatch(el('x', 'rectangle'), true)).toBeNull()
  })
})

describe('runtime', () => {
  it('reads the board id from /b/:boardId; who I am from the welcome', () => {
    expect(boardIdFromPath('/b/b-abc123')).toBe('b-abc123')
    expect(boardIdFromPath('/b/b-abc123/x')).toBe('b-abc123')
    expect(boardIdFromPath('/boards/x')).toBeNull()
    const guest = fakePort([], {
      uid: 'usr_g',
      name: 'Sam (guest)',
      color: '#000',
      role: 'editor',
      guest: true,
    })
    expect(guest.rt.canEdit()).toBe(true)
    expect(guest.rt.canFacilitate()).toBe(false) // a name-only guest never facilitates
    const viewer = fakePort([], {
      uid: 'usr_v',
      name: 'V',
      color: '#000',
      role: 'viewer' as never,
      guest: false,
    })
    expect(viewer.rt.canEdit()).toBe(false)
  })
})
