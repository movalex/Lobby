import { PLUS_ONES_MAX, readPlusOnes } from '@draftroom/contracts'
import type { Editor, TLShapeId } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { canPlusOne, PlusOneIntents, togglePlusOne, watchPlusOneIntents, writePlusOne } from './plus-ones.ts'

const A = 'usr_aaaaaaaaaaaa'
const B = 'usr_bbbbbbbbbbbb'
const C = 'usr_cccccccccccc'

describe('readPlusOnes (contracts)', () => {
  it('reads the array in order, drops malformed and repeated ids, caps the count', () => {
    expect(readPlusOnes({ plusOnes: [B, A] })).toEqual([B, A])
    expect(readPlusOnes({ plusOnes: [A, 'nope', 7, null, A, B] })).toEqual([A, B])
    expect(readPlusOnes({})).toEqual([])
    expect(readPlusOnes(null)).toEqual([])
    expect(readPlusOnes({ plusOnes: 'usr_aaaaaaaaaaaa' })).toEqual([])
    const many = Array.from({ length: PLUS_ONES_MAX + 20 }, (_, i) => `usr_${String(i).padStart(12, '0')}`)
    expect(readPlusOnes({ plusOnes: many })).toHaveLength(PLUS_ONES_MAX)
  })

  it('also reads a map of id -> time (oldest first)', () => {
    expect(readPlusOnes({ plusOnes: { [A]: 20, [B]: 10, bad: 5 } })).toEqual([B, A])
  })
})

describe('togglePlusOne', () => {
  it('adds at the end, removes in place, and respects an explicit want', () => {
    expect(togglePlusOne({ plusOnes: [B] }, A)).toEqual({
      ok: true,
      changed: true,
      next: [B, A],
      added: true,
    })
    expect(togglePlusOne({ plusOnes: [A, B, C] }, B)).toEqual({
      ok: true,
      changed: true,
      next: [A, C],
      added: false,
    })
    expect(togglePlusOne({ plusOnes: [A] }, A, true)).toMatchObject({ ok: true, changed: false })
    expect(togglePlusOne({}, A, false)).toMatchObject({ ok: true, changed: false })
    // A note without the key yet (every new note) starts the list.
    expect(togglePlusOne({ other: 1 }, A)).toMatchObject({ next: [A], added: true })
  })

  it(`refuses the ${PLUS_ONES_MAX + 1}st, but always lets someone take theirs back`, () => {
    const full = Array.from({ length: PLUS_ONES_MAX }, (_, i) => `usr_${String(i).padStart(12, '0')}`)
    expect(togglePlusOne({ plusOnes: full }, A)).toEqual({ ok: false, reason: 'full' })
    const first = full[0] ?? ''
    expect(togglePlusOne({ plusOnes: full }, first)).toMatchObject({ ok: true, added: false })
  })
})

describe('canPlusOne (UI hint; the sync server enforces)', () => {
  const board = (status: 'active' | 'archived') => ({ status }) as never
  it('editors and owners of an active board only', () => {
    expect(canPlusOne({ role: 'owner', board: board('active') })).toBe(true)
    expect(canPlusOne({ role: 'editor', board: board('active') })).toBe(true)
    expect(canPlusOne({ role: 'commenter', board: board('active') })).toBe(false)
    expect(canPlusOne({ role: 'viewer', board: board('active') })).toBe(false)
    expect(canPlusOne({ role: 'editor', board: board('archived') })).toBe(false)
  })
})

// A tiny stand-in for the editor: one record map, `run` with its options, and remote listeners.
function fakeEditor(
  shapes: Record<string, { type: string; meta: Record<string, unknown>; isLocked?: boolean }>,
) {
  const runs: unknown[] = []
  const listeners: ((entry: unknown) => void)[] = []
  const editor = {
    getShape: (id: string) => (shapes[id] ? { id, ...shapes[id] } : undefined),
    run(fn: () => void, opts: unknown) {
      runs.push(opts)
      fn()
    },
    updateShape(partial: { id: string; meta: Record<string, unknown> }) {
      const s = shapes[partial.id]
      if (s) s.meta = { ...s.meta, ...partial.meta }
    },
    store: {
      listen(fn: (entry: unknown) => void, opts: unknown) {
        expect(opts).toEqual({ source: 'remote', scope: 'document' })
        listeners.push(fn)
        return () => listeners.splice(listeners.indexOf(fn), 1)
      },
    },
  }
  const remote = (id: string, meta: Record<string, unknown> | null) => {
    const before = shapes[id]
    if (meta === null) delete shapes[id]
    else if (before) before.meta = meta
    const rec = { id }
    for (const l of listeners)
      l({
        changes: {
          added: {},
          updated: meta === null ? {} : { [id]: [rec, rec] },
          removed: meta === null ? { [id]: rec } : {},
        },
      })
  }
  return { editor: editor as unknown as Editor, runs, remote, shapes, listeners }
}

const flush = () => new Promise((r) => queueMicrotask(() => r(undefined)))

describe('writePlusOne', () => {
  it('writes the list into the note, outside the undo history and past a lock', () => {
    const f = fakeEditor({ 'shape:n': { type: 'note', meta: { plusOnes: [B] }, isLocked: true } })
    expect(writePlusOne(f.editor, 'shape:n' as TLShapeId, A)).toEqual({ ok: true, added: true })
    expect(f.shapes['shape:n']?.meta.plusOnes).toEqual([B, A])
    expect(f.runs).toEqual([{ history: 'ignore', ignoreShapeLock: true }])
    expect(writePlusOne(f.editor, 'shape:n' as TLShapeId, A)).toEqual({ ok: true, added: false })
    expect(f.shapes['shape:n']?.meta.plusOnes).toEqual([B])
  })

  it('only notes; a missing note is reported', () => {
    const f = fakeEditor({ 'shape:g': { type: 'geo', meta: {} } })
    expect(writePlusOne(f.editor, 'shape:g' as TLShapeId, A).ok).toBe(false)
    expect(writePlusOne(f.editor, 'shape:gone' as TLShapeId, A)).toEqual({
      ok: false,
      message: 'That note is gone.',
    })
    expect(f.runs).toEqual([])
  })
})

describe('PlusOneIntents + watcher (concurrent +1s converge)', () => {
  it('re-applies a +1 that a concurrent write dropped, within the window, a bounded number of times', () => {
    const i = new PlusOneIntents(1_000, 2)
    i.note('shape:n', true, 0)
    expect(i.check('shape:n', true, 10)).toBeNull() // as asked
    expect(i.check('shape:n', false, 20)).toEqual({ want: true }) // dropped: again
    expect(i.check('shape:n', false, 30)).toEqual({ want: true })
    expect(i.check('shape:n', false, 40)).toBeNull() // gave up after 2 tries
    expect(i.pending()).toEqual([])
    i.note('shape:n', false, 100)
    expect(i.check('shape:n', true, 1_101)).toBeNull() // window over
    i.note('shape:m', true, 0)
    expect(i.check('shape:m', null, 5)).toBeNull() // the note was deleted
    expect(i.pending()).toEqual([])
  })

  it('the watcher re-adds this person when a remote change undid their +1 (and leaves others alone)', async () => {
    const f = fakeEditor({ 'shape:n': { type: 'note', meta: {} } })
    const intents = new PlusOneIntents()
    const stop = watchPlusOneIntents(f.editor, A, intents, () => 0)
    writePlusOne(f.editor, 'shape:n' as TLShapeId, A)
    intents.note('shape:n', true, 0)
    // B's first +1 landed at the same time as A's: the server kept B's, and A's copy is rolled back.
    f.remote('shape:n', { plusOnes: [B] })
    await flush()
    expect(f.shapes['shape:n']?.meta.plusOnes).toEqual([B, A])
    // Remote changes that agree with the intent change nothing.
    f.remote('shape:n', { plusOnes: [B, A, C] })
    await flush()
    expect(f.shapes['shape:n']?.meta.plusOnes).toEqual([B, A, C])
    // A removal that someone else's rewrite brought back is removed again.
    writePlusOne(f.editor, 'shape:n' as TLShapeId, A)
    intents.note('shape:n', false, 0)
    f.remote('shape:n', { plusOnes: [B, A, C] })
    await flush()
    expect(f.shapes['shape:n']?.meta.plusOnes).toEqual([B, C])
    // A deleted note ends the intent.
    f.remote('shape:n', null)
    await flush()
    expect(intents.pending()).toEqual([])
    stop()
    expect(f.listeners).toHaveLength(0)
  })
})
