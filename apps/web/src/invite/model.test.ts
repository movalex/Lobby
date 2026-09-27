import { describe, expect, it } from 'vitest'
import { BOARD_ID, WS_ID } from '../api/test-fixtures.ts'
import { invitationSummary } from './model.ts'

const base = {
  workspace: { id: WS_ID, name: 'Dev Studio' },
  invitedBy: { name: 'Alice' },
  expiresAt: '2026-10-03T12:00:00.000Z',
}

describe('invitation summary', () => {
  it('board invitations name the board, the inviter and the board role', () => {
    const s = invitationSummary({ ...base, board: { id: BOARD_ID, title: 'Q3 planning' }, role: 'commenter' })
    expect(s).toEqual({
      eyebrow: 'Alice invited you to a board',
      title: 'Join “Q3 planning”',
      roleLabel: 'Can comment',
      acceptLabel: 'Accept and open board',
    })
  })

  it('workspace invitations name the workspace and the workspace role', () => {
    const s = invitationSummary({ ...base, board: null, role: 'guest' })
    expect(s.title).toBe('Join Dev Studio')
    expect(s.roleLabel).toBe('Guest')
    expect(s.acceptLabel).toBe('Accept and open workspace')
  })

  it('never shows a raw, unknown role string', () => {
    expect(invitationSummary({ ...base, board: null, role: 'superuser' }).roleLabel).toBe('Member')
    expect(invitationSummary({ ...base, board: { id: BOARD_ID, title: 'x' }, role: '<b>' }).roleLabel).toBe(
      'Can view',
    )
  })
})
