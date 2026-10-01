import { describe, expect, it } from 'vitest'
import { buildNote, type ElementLike, noteSkeleton, stampNoteDuplicates } from './notes.ts'

describe('notes (created: null, §2.11)', () => {
  it('builds the skeleton with created: null, Lobby size, roughness 0 and a Nunito label', () => {
    expect(noteSkeleton({ id: 'n1', x: 10, y: 20, text: 'Hi' })).toEqual({
      type: 'stickynote',
      id: 'n1',
      x: 10,
      y: 20,
      width: 200,
      height: 200,
      baseHeight: 200,
      backgroundColor: '#ffd966',
      roughness: 0,
      created: null,
      label: { text: 'Hi', fontFamily: 6 },
    })
    expect(noteSkeleton({ id: 'n2', x: 0, y: 0 })).not.toHaveProperty('label')
  })

  it('buildNote calls the converter with regenerateIds: false and refuses a stamped note', () => {
    const seen: unknown[] = []
    const good = buildNote(
      (s, o) => {
        seen.push(o)
        return s.map((x) => ({ ...(x as ElementLike) }))
      },
      { id: 'n1', x: 0, y: 0 },
    )
    expect(seen).toEqual([{ regenerateIds: false }])
    expect(good[0]?.created).toBeNull()
    expect(() =>
      buildNote((s) => s.map((x) => ({ ...(x as ElementLike), created: 1 })), { id: 'n1', x: 0, y: 0 }),
    ).toThrow(/created is 1/)
  })

  it('stampNoteDuplicates nulls created on duplicated notes only', () => {
    const els: ElementLike[] = [
      { id: 'orig', type: 'stickynote', created: null },
      { id: 'copy', type: 'stickynote', created: 123 },
      { id: 'copyLabel', type: 'text', created: 123 },
      { id: 'rect', type: 'rectangle', created: 5 },
    ]
    const out = stampNoteDuplicates(els, new Set(['copy', 'copyLabel']))
    expect(out?.map((e) => [e.id, e.created])).toEqual([
      ['orig', null],
      ['copy', null],
      ['copyLabel', 123],
      ['rect', 5],
    ])
    expect(out?.[0]).toBe(els[0]) // untouched elements keep their identity
    expect(stampNoteDuplicates(els, new Set(['rect']))).toBeUndefined()
  })
})
