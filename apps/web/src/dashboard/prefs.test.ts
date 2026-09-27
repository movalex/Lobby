import { describe, expect, it } from 'vitest'
import { readPickerHidden, readViewMode, writePickerHidden, writeViewMode } from './prefs.ts'

function memoryStore() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  }
}
const throwing = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
  removeItem: () => {
    throw new Error('blocked')
  },
}

describe('dashboard preferences', () => {
  it('remembers grid/list (default grid)', () => {
    const s = memoryStore()
    expect(readViewMode(s)).toBe('grid')
    writeViewMode('list', s)
    expect(readViewMode(s)).toBe('list')
    writeViewMode('grid', s)
    expect(readViewMode(s)).toBe('grid')
  })

  it('"Don’t show on new boards" is per user and can be turned off again', () => {
    const s = memoryStore()
    writePickerHidden('usr_alice', true, s)
    expect(readPickerHidden('usr_alice', s)).toBe(true)
    expect(readPickerHidden('usr_bob', s)).toBe(false)
    writePickerHidden('usr_alice', false, s)
    expect(readPickerHidden('usr_alice', s)).toBe(false)
    expect(s.size()).toBe(0)
  })

  it('blocked or missing storage means defaults, never an exception', () => {
    expect(readViewMode(throwing)).toBe('grid')
    expect(readPickerHidden('usr_alice', throwing)).toBe(false)
    expect(() => writeViewMode('list', throwing)).not.toThrow()
    expect(() => writePickerHidden('usr_alice', true, throwing)).not.toThrow()
    expect(readViewMode(null)).toBe('grid')
  })
})
