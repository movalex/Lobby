// Wave L (W3, L3-X): the words typed for a topic whose editor never opened are written without an editor, and
// then guarded for a few seconds against the cancelled editor's late clean-up (which can put the old words
// back). The guard must never undo what the person (or anyone) typed into that topic since: e2e
// mindmap-keyboard.spec.ts:201 lost the "!" typed after F2 when the topic's first words had come this way
// (the guard put "Detail one" back over "Detail one!").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MindmapKeyboard } from './keyboard.ts'
import type { MindmapRuntime } from './runtime.ts'

type Listener = (...args: never[]) => void

function board(opts: { holder?: string } = {}) {
  const listeners = new Map<string, Set<Listener>>()
  let editing: string | null = null
  let opens: ((ok: boolean) => void)[] = []
  const text = new Map<string, string>([['t1', '']])
  const writes: { id: string; text: string }[] = []
  let holder: string | null = null
  const canvas = {
    on(type: string, fn: Listener) {
      const set = listeners.get(type) ?? new Set<Listener>()
      listeners.set(type, set)
      set.add(fn)
      return () => set.delete(fn)
    },
    selection: ['t1'] as string[],
    select: () => {},
    editingId: () => editing,
    gesture: () => 'idle',
    readOnly: () => false,
    isLocked: () => false,
    isHidden: () => false,
    leaseHolder: () => (holder ? { sid: holder, uid: 'usr_other', name: 'Other' } : null),
    engine: { welcome: { sid: 'me' } },
    text: {
      canEdit: () => true,
      of: (id: string) => text.get(id) ?? '',
      editorElement: () => null,
      stop: () => {},
      edit: () => new Promise<boolean>((resolve) => opens.push(resolve)),
    },
  }
  const rt = {
    canvas,
    isTopic: (id: string | null | undefined) => id === 't1',
    fresh: null,
    textOf: (id: string) => text.get(id) ?? '',
    setTopicText: (id: string, t: string) => {
      writes.push({ id, text: t })
      text.set(id, t)
      return true
    },
    editorNeverOpened: () => {},
    whenEditorClosed: (cb: () => void) => cb,
    addChild: () => null,
    addSibling: () => null,
    promote: () => {},
  } as unknown as MindmapRuntime
  const emit = (type: string, ...args: unknown[]) => {
    for (const fn of [...(listeners.get(type) ?? [])]) (fn as (...a: unknown[]) => void)(...args)
  }
  return {
    rt,
    text,
    writes,
    /** the lease answers the pending open */
    answerOpen: (ok: boolean) => {
      const o = opens
      opens = []
      for (const r of o) r(ok)
    },
    setEditing: (id: string | null) => {
      editing = id
      emit('editingChanged', id)
    },
    setHolder: (sid: string | null) => {
      holder = sid ?? opts.holder ?? null
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A topic whose editor never opened, with "Detail one" typed for it: the replay writes the words. */
async function replayed() {
  const b = board()
  const keys = new MindmapKeyboard(b.rt)
  keys.install()
  keys.expectEditor('t1', 'fresh', [{ kind: 'text', text: 'Detail one' }])
  b.answerOpen(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(b.writes).toEqual([{ id: 't1', text: 'Detail one' }])
  return { b, keys }
}

describe('the words written without an editor are guarded, never against a later edit', () => {
  it('a late clean-up that puts the old words back is undone (the guard still works)', async () => {
    const { b } = await replayed()
    // the cancelled editor's submit lands late with the topic's old (empty) words
    b.text.set('t1', '')
    await vi.advanceTimersByTimeAsync(5_500)
    expect(b.writes.at(-1)).toEqual({ id: 't1', text: 'Detail one' })
    expect(b.text.get('t1')).toBe('Detail one')
  })

  it('an edit of the topic since (F2, then "!") is kept: they are not the old words, so the guard ends', async () => {
    const { b } = await replayed()
    await vi.advanceTimersByTimeAsync(300)
    // F2: this tab's editor opens on the topic, the person types "!", Escape
    b.setEditing('t1')
    b.text.set('t1', 'Detail one!')
    b.setEditing(null)
    const before = b.writes.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect(b.writes.slice(before)).toEqual([])
    expect(b.text.get('t1')).toBe('Detail one!')
  })

  it('words someone else typed into it since are kept too (only a revert to the old words is undone)', async () => {
    const { b } = await replayed()
    await vi.advanceTimersByTimeAsync(300)
    // another tab took the lease, typed, and let it go again before the guard looked
    b.setHolder('other')
    b.text.set('t1', 'Detail one, by Sam')
    b.setHolder(null)
    const before = b.writes.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect(b.writes.slice(before)).toEqual([])
    expect(b.text.get('t1')).toBe('Detail one, by Sam')
  })
})
