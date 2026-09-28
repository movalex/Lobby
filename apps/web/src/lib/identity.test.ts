import { describe, expect, it } from 'vitest'
import { colorForUser, DEV_HANDLE_RE, initialsFor, safeColor } from './identity.ts'

describe('user display', () => {
  it('derives the same fallback color for the same id in every tab', () => {
    expect(colorForUser('usr_abcdefghij0123456789')).toBe(colorForUser('usr_abcdefghij0123456789'))
    expect(colorForUser('alice')).toMatch(/^#[0-9a-f]{6}$/)
    const colors = new Set(['alice', 'bob', 'carol', 'dana', 'erin'].map(colorForUser))
    expect(colors.size).toBeGreaterThan(2)
  })

  it('uses the API color only when it is a plain hex color (never raw CSS from the network)', () => {
    expect(safeColor('#1d4ed8', 'u')).toBe('#1d4ed8')
    expect(safeColor('#abc', 'u')).toBe('#abc')
    for (const bad of [
      'red',
      'url(https://x)',
      '#12345g',
      '',
      null,
      undefined,
      '#1d4ed8;background:url(x)',
    ]) {
      expect(safeColor(bad, 'alice')).toBe(colorForUser('alice'))
    }
  })

  it('makes initials', () => {
    expect(initialsFor('alice')).toBe('AL')
    expect(initialsFor('Mary Jane')).toBe('MJ')
    expect(initialsFor('mary-jane')).toBe('MJ')
    expect(initialsFor('')).toBe('?')
    // A guest's display marker is not an initial (wave 3 guests).
    expect(initialsFor('Sam (guest)')).toBe('SA')
    expect(initialsFor('Sam Rivera (guest)')).toBe('SR')
    expect(initialsFor('(guest)')).toBe('(G')
  })

  it('accepts the same dev handles as the API contract', () => {
    for (const ok of ['alice', 'bob-2', 'a']) expect(DEV_HANDLE_RE.test(ok)).toBe(true)
    for (const bad of ['Alice', 'a b', '', 'x'.repeat(33), 'al!ce'])
      expect(DEV_HANDLE_RE.test(bad)).toBe(false)
  })
})
