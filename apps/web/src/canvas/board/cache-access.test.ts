// Wave M round 1 refix (M6-1 / M6-4): the board cache (the warm open's paint, its writes and the offline copy) is for
// the members of the board's workspace (owner, admin, member). An outside account invited to one board (workspace
// role 'guest') and a name-only guest never get one, whatever the board's export policy. The role is the board
// answer's (round 2 refix), and an answer without it gets no copy (the wave M gate: it fails closed).
import { describe, expect, it } from 'vitest'
import { boardCacheAllowed } from './cache-access.ts'

describe('boardCacheAllowed', () => {
  it('owners, admins and members of the board’s workspace', () => {
    for (const role of ['owner', 'admin', 'member'] as const)
      expect(boardCacheAllowed({ role }), role).toBe(true)
  })

  it('a workspace guest (an outside account on one board) never, and nobody outside the workspace', () => {
    expect(boardCacheAllowed({ role: 'guest' })).toBe(false)
    // no workspace role at all (a board-only grant)
    expect(boardCacheAllowed({ role: null })).toBe(false)
  })
})

describe('the board answer states the workspace role now (wave M round 2 refix, the gate fix)', () => {
  it('a member lowered to workspace guest while the tab was open gets no copy: the answer decides', () => {
    expect(boardCacheAllowed({ role: 'guest' })).toBe(false)
  })

  it('an answer without the role (an api older than round 2: a rollback) gets no copy, not the Me of the page load', () => {
    // the Me of the page load can say member long after an admin lowered the person (the gate's m6-warm-open
    // round 2 failure against the 4e4a549 api)
    expect(boardCacheAllowed({})).toBe(false)
    expect(boardCacheAllowed({ role: undefined })).toBe(false)
  })
})
