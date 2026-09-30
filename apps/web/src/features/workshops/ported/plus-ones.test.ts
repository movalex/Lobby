// OWNER: 3f. +1s as identity-bound customData keys on the Excalidraw page.
import { PLUS_ONES_MAX } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { plusOnePatch, plusOnesOf, writePlusOne } from './plus-ones.ts'
import { fakeCanvas, note } from './test-kit.ts'

const withPlus = (...uids: string[]) =>
  note('n', 'Idea', { customData: { lobby: Object.fromEntries(uids.map((u) => [`plusOne:${u}`, true])) } })

describe('+1 keys', () => {
  it('reads the uids (sorted), ignoring other keys and values', () => {
    const [n] = note('n', 'x', {
      customData: {
        lobby: { 'plusOne:usr_b': true, 'plusOne:usr_a': true, 'plusOne:usr_c': 1, 'tag:x': true },
      },
    })
    expect(plusOnesOf(n)).toEqual(['usr_a', 'usr_b'])
    expect(plusOnesOf(undefined)).toEqual([])
  })

  it('patches only the writer’s own key: add, remove, toggle, no-op, full', () => {
    const [n] = withPlus('usr_a')
    if (!n) throw new Error('no note')
    expect(plusOnePatch(n, 'usr_b')).toEqual({ 'plusOne:usr_b': true })
    expect(plusOnePatch(n, 'usr_a')).toEqual({ 'plusOne:usr_a': null })
    expect(plusOnePatch(n, 'usr_a', true)).toBeNull()
    expect(plusOnePatch(n, 'usr_b', false)).toBeNull()
    const [full] = withPlus(...Array.from({ length: PLUS_ONES_MAX }, (_, i) => `usr_${i}`))
    if (!full) throw new Error('no note')
    expect(plusOnePatch(full, 'usr_new')).toBe('full')
    expect(plusOnePatch(full, 'usr_0')).toEqual({ 'plusOne:usr_0': null })
  })

  it('writes through one transact, and refuses what is not a note', () => {
    const f = fakeCanvas([...withPlus('usr_a')])
    expect(writePlusOne(f.canvas, 'n', 'usr_b')).toEqual({ ok: true, added: true })
    expect(plusOnesOf(f.canvas.get('n'))).toEqual(['usr_a', 'usr_b'])
    expect(writePlusOne(f.canvas, 'n', 'usr_a')).toEqual({ ok: true, added: false })
    expect(plusOnesOf(f.canvas.get('n'))).toEqual(['usr_b'])
    expect(f.steps).toEqual(['+1', '+1'])
    expect(writePlusOne(f.canvas, 'n', 'usr_b', true)).toEqual({ ok: true, added: true })
    expect(f.steps).toHaveLength(2) // nothing to change: no step
    expect(writePlusOne(f.canvas, 'n-label', 'usr_b').ok).toBe(false)
    expect(writePlusOne(f.canvas, 'nope', 'usr_b')).toMatchObject({
      ok: false,
      message: 'That note is gone.',
    })
    f.readOnly = true
    expect(writePlusOne(f.canvas, 'n', 'usr_c')).toMatchObject({ ok: false })
  })
})
