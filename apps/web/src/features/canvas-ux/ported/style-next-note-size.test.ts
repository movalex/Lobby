// P-011 follow-up: with the note tool picked and nothing selected, Size is the next note's size (S/M/L/XL: 150, 200,
// 300, 400 px, its words scaled with it), as it is for a selected note. It was the next note's label size only.
import { describe, expect, it } from 'vitest'
import type { LobbyCanvas, StyleValues } from '../../../canvas/api/index.ts'
import { pickSize, type Target } from './StylePanel.tsx'
import { NOTE_FONT, NOTE_SIDE, TEXT_SIZE } from './style-vocabulary.ts'

function kit() {
  const nexts: StyleValues[] = []
  const transacts: string[] = []
  const canvas = {
    readOnly: () => false,
    transact: (label: string) => void transacts.push(label),
    styles: {
      apply: () => {},
      resizeNotes: () => {},
      next: () => ({}),
      setNext: (p: StyleValues) => void nexts.push(p),
    },
  }
  return { canvas: canvas as unknown as LobbyCanvas, nexts, transacts }
}
const nextOf = (kind: 'note' | 'text'): Target => ({
  els: [],
  holders: [],
  kinds: new Set([kind]),
  next: true,
})

describe('Size with the note tool picked (nothing selected)', () => {
  it('sets the next note’s size and its words’ size, as for a selected note', () => {
    for (const size of ['s', 'm', 'l', 'xl'] as const) {
      const k = kit()
      pickSize(k.canvas, nextOf('note'), size)
      expect(k.nexts, size).toEqual([{ fontSize: NOTE_FONT[size], noteSize: NOTE_SIDE[size] }])
      expect(k.transacts, 'no board write').toEqual([])
    }
    expect(Object.values(NOTE_SIDE)).toEqual([150, 200, 300, 400])
  })

  it('leaves the text tool’s next text as it was: a font size only', () => {
    const k = kit()
    pickSize(k.canvas, nextOf('text'), 'xl')
    expect(k.nexts).toEqual([{ fontSize: TEXT_SIZE.xl }])
  })
})
