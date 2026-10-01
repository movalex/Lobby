import { describe, expect, it } from 'vitest'
import { presenceIdentity } from './presence.ts'

describe('presenceIdentity', () => {
  it("is the ticket's user (user:<uid>), its name, and its color unless that is not a plain hex color", () => {
    expect(presenceIdentity({ uid: 'usr_a', name: 'Ann', color: '#abcdef' })).toEqual({
      userId: 'user:usr_a',
      userName: 'Ann',
      color: '#abcdef',
    })
    const fallback = presenceIdentity({ uid: 'usr_a', name: 'Ann', color: 'url(javascript:1)' }).color
    expect(fallback).toMatch(/^#[0-9a-f]{6}$/)
    expect(presenceIdentity({ uid: 'usr_a', name: 'Ann', color: '' }).color).toBe(fallback) // deterministic
    expect(presenceIdentity({ uid: 'usr_b', name: 'Bob', color: 'red' }).color).toMatch(/^#[0-9a-f]{6}$/)
  })
})
