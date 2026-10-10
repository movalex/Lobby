// Wave M round 1 refix (M6-1 / M6-4): the board cache (the warm open's paint, its writes and the offline copy) is for
// the members of the board's workspace (owner, admin, member). An outside account invited to one board (workspace
// role 'guest') and a name-only guest never get one, whatever the board's export policy.
import type { Me } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { boardCacheAllowed } from './cache-access.ts'

const me = (workspaces: Me['workspaces']): Me =>
  ({ user: { id: 'usr_pat0000000000000000', name: 'Pat' }, workspaces }) as unknown as Me
const WS = 'wsp_DevStudio00000000000'

describe('boardCacheAllowed', () => {
  it('owners, admins and members of the board’s workspace', () => {
    for (const role of ['owner', 'admin', 'member'] as const)
      expect(boardCacheAllowed(me([{ id: WS, name: 'Dev', role }]), { id: WS }), role).toBe(true)
  })

  it('a workspace guest (an outside account on one board) never, and nobody outside the workspace', () => {
    expect(boardCacheAllowed(me([{ id: WS, name: 'Dev', role: 'guest' }]), { id: WS })).toBe(false)
    // a member of another workspace only
    expect(
      boardCacheAllowed(me([{ id: 'wsp_Other000000000000000', name: 'O', role: 'owner' }]), { id: WS }),
    ).toBe(false)
    expect(boardCacheAllowed(me([]), { id: WS })).toBe(false)
  })
})

describe('the board answer states the workspace role now (wave M round 2 refix)', () => {
  // Pat was a member when the page loaded (Me), then an admin lowered Pat to workspace guest; Pat's board grant
  // stays, so the board still answers, and its answer is what counts
  const stale = me([{ id: WS, name: 'Dev', role: 'member' }])

  it('a workspace guest by the board answer gets no copy, whatever the Me of the page load says', () => {
    expect(boardCacheAllowed(stale, { id: WS, role: 'guest' })).toBe(false)
    expect(boardCacheAllowed(stale, { id: WS, role: null })).toBe(false)
  })

  it('a member by the board answer gets one; with no role in the answer (an older api), Me decides as before', () => {
    expect(boardCacheAllowed(me([{ id: WS, name: 'Dev', role: 'guest' }]), { id: WS, role: 'member' })).toBe(
      true,
    )
    expect(boardCacheAllowed(stale, { id: WS })).toBe(true)
    expect(boardCacheAllowed(me([{ id: WS, name: 'Dev', role: 'guest' }]), { id: WS })).toBe(false)
  })
})
