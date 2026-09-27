import { describe, expect, it } from 'vitest'
import { BOARD_ID_RE } from '../assets/contract.ts'
import { boardIdFromInput, colorForUser, initialsFor, newBoardId, parseDevIdentity } from './identity.ts'
import { matchRoute } from './routing.ts'

describe('newBoardId', () => {
  it('is b- plus 10 lowercase base36 chars, valid for the server, and does not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newBoardId()))
    expect(ids.size).toBe(500)
    for (const id of ids) {
      expect(id).toMatch(/^b-[0-9a-z]{10}$/)
      expect(BOARD_ID_RE.test(id)).toBe(true)
    }
  })
  it('skips bytes >= 252 so every character is equally likely', () => {
    // 252..255 would map to 0..3 a second time; they must be dropped, not folded in.
    const bytes = [255, 252, 0, 35, 36, 71, 253, 1, 2, 3, 4, 5, 6, 7]
    const id = newBoardId((n) => Uint8Array.from({ length: n }, (_, i) => bytes[i] ?? 9))
    expect(id).toBe('b-0z0z123456')
  })
})

describe('parseDevIdentity', () => {
  it('accepts valid dev ids and the viewer role only', () => {
    expect(parseDevIdentity('?user=alice')).toEqual({ userId: 'alice', role: 'editor' })
    expect(parseDevIdentity('?user=bob&role=viewer')).toEqual({ userId: 'bob', role: 'viewer' })
    expect(parseDevIdentity('?user=bob&role=admin')).toEqual({ userId: 'bob', role: 'editor' })
  })
  it('treats missing or malformed ids as no identity (never passes them to the server)', () => {
    for (const q of [
      '',
      '?user=',
      '?user=Alice',
      '?user=a%20b',
      `?user=${'x'.repeat(33)}`,
      '?user=<script>',
    ]) {
      expect(parseDevIdentity(q)).toBeNull()
    }
  })
})

describe('boardIdFromInput', () => {
  it('accepts a bare id or a pasted board link, normalized to lowercase', () => {
    expect(boardIdFromInput('  b-3k9x0q2m7a ')).toBe('b-3k9x0q2m7a')
    expect(boardIdFromInput('http://127.0.0.1:5173/b/team-plan?user=alice')).toBe('team-plan')
    expect(boardIdFromInput('B-ABCDEFGHIJ')).toBe('b-abcdefghij')
  })
  it('rejects ids the server would refuse', () => {
    for (const bad of ['', 'ab', '-lead', '../etc', 'a b c', 'x'.repeat(65), 'con/../x']) {
      expect(boardIdFromInput(bad)).toBeNull()
    }
  })
})

describe('routes', () => {
  const isId = (s: string) => BOARD_ID_RE.test(s)
  it('maps / and /b/<id>, and flags bad ids instead of opening a room', () => {
    expect(matchRoute('/', isId)).toEqual({ name: 'home' })
    expect(matchRoute('/b/b-3k9x0q2m7a', isId)).toEqual({ name: 'board', boardId: 'b-3k9x0q2m7a' })
    expect(matchRoute('/b/b-3k9x0q2m7a/', isId)).toEqual({ name: 'board', boardId: 'b-3k9x0q2m7a' })
    expect(matchRoute('/b/Board1', isId)).toEqual({ name: 'invalid-board', raw: 'Board1' })
    expect(matchRoute('/b/%E0%A4%A', isId).name).toBe('invalid-board')
    expect(matchRoute('/b/x/y', isId)).toEqual({ name: 'not-found' })
    expect(matchRoute('/settings', isId)).toEqual({ name: 'not-found' })
  })
})

describe('user display', () => {
  it('derives the same color for the same id in every tab', () => {
    expect(colorForUser('alice')).toBe(colorForUser('alice'))
    expect(colorForUser('alice')).toMatch(/^#[0-9a-f]{6}$/)
    const colors = new Set(['alice', 'bob', 'carol', 'dana', 'erin'].map(colorForUser))
    expect(colors.size).toBeGreaterThan(2)
  })
  it('makes initials', () => {
    expect(initialsFor('alice')).toBe('AL')
    expect(initialsFor('mary-jane')).toBe('MJ')
    expect(initialsFor('')).toBe('?')
  })
})
