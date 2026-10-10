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
      expect(boardCacheAllowed(me([{ id: WS, name: 'Dev', role }]), WS), role).toBe(true)
  })

  it('a workspace guest (an outside account on one board) never, and nobody outside the workspace', () => {
    expect(boardCacheAllowed(me([{ id: WS, name: 'Dev', role: 'guest' }]), WS)).toBe(false)
    // a member of another workspace only
    expect(boardCacheAllowed(me([{ id: 'wsp_Other000000000000000', name: 'O', role: 'owner' }]), WS)).toBe(
      false,
    )
    expect(boardCacheAllowed(me([]), WS)).toBe(false)
  })
})
