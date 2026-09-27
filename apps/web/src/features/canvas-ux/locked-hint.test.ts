import { describe, expect, it } from 'vitest'
import { lockedHintMessage, lockSource, unlockLabel } from './locked-hint.ts'

const note = { id: 'shape:n', type: 'note', isLocked: false }
const frame = { id: 'shape:f', type: 'frame', isLocked: true, name: '3 · Imagery' }

describe('lockSource', () => {
  it('is the shape itself, else its nearest locked ancestor, else null', () => {
    expect(lockSource([{ ...note, isLocked: true }, frame])?.id).toBe('shape:n')
    expect(lockSource([note, frame])?.id).toBe('shape:f')
    expect(
      lockSource([note, { ...frame, isLocked: false }, { id: 'shape:g', type: 'group', isLocked: true }])?.id,
    ).toBe('shape:g')
    expect(lockSource([note, { ...frame, isLocked: false }])).toBeNull()
    expect(lockSource([])).toBeNull()
  })
})

describe('lockedHintMessage (F8)', () => {
  it('names the locked frame a shape sits in, and how to unlock', () => {
    expect(lockedHintMessage(note, frame, false)).toBe(
      'Locked. Inside locked frame "3 · Imagery". Ctrl+Shift+L or right-click → Unlock all',
    )
    expect(lockedHintMessage(note, frame, true)).toContain('⌘⇧L')
    expect(lockedHintMessage(note, { ...frame, name: '' }, false)).toContain('Inside locked frame (untitled)')
  })
  it('says a locked shape is locked', () => {
    const locked = { ...note, isLocked: true }
    expect(lockedHintMessage(locked, locked, false)).toBe('Locked. Ctrl+Shift+L or right-click → Unlock all')
    expect(lockedHintMessage(note, { id: 'shape:g', type: 'group', isLocked: true }, false)).toContain(
      'Inside a locked group',
    )
  })
  it('labels the unlock button by what it unlocks', () => {
    expect(unlockLabel(frame)).toBe('Unlock frame')
    expect(unlockLabel({ ...note, isLocked: true })).toBe('Unlock')
  })
})
