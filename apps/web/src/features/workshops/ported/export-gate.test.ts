// OWNER: 3f. The Voting panel's export gate rule (the sharing feature's exportAllowedWith, restated).
import { describe, expect, it } from 'vitest'
import { exportAllowedWith } from './export-gate.ts'

describe('the vote CSV export gate', () => {
  it('allows while anything is unknown, and follows the policy by role and guest kind', () => {
    expect(exportAllowedWith(null, 'editors', true)).toBe(true)
    expect(exportAllowedWith('viewer', null, null)).toBe(true)
    expect(exportAllowedWith('viewer', 'everyone', null)).toBe(true)
    expect(exportAllowedWith('viewer', 'editors', null)).toBe(false)
    expect(exportAllowedWith('commenter', 'editors', false)).toBe(false)
    expect(exportAllowedWith('editor', 'editors', false)).toBe(true)
    expect(exportAllowedWith('editor', 'editors', true)).toBe(false) // a name-only guest is limited
    expect(exportAllowedWith('owner', 'editors', null)).toBe(true)
  })
})
