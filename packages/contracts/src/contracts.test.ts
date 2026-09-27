import { describe, expect, it } from 'vitest'
import {
  BoardId,
  CreateBoardInvitationInput,
  DevLoginInput,
  PatchBoardInput,
  TicketResponse,
} from './index.ts'

describe('contracts', () => {
  it('board ids are lowercase-only (case-insensitive filesystems would split rooms)', () => {
    expect(BoardId.safeParse('b-abc123defg').success).toBe(true)
    expect(BoardId.safeParse('B-ABC123DEFG').success).toBe(false)
    expect(BoardId.safeParse('../x').success).toBe(false)
  })

  it('an empty patch is rejected; titles are trimmed and bounded', () => {
    expect(PatchBoardInput.safeParse({}).success).toBe(false)
    expect(PatchBoardInput.parse({ title: '  Retro  ' })).toEqual({ title: 'Retro' })
    expect(PatchBoardInput.safeParse({ title: 'x'.repeat(121) }).success).toBe(false)
  })

  it('board invitations cannot hand out ownership', () => {
    expect(CreateBoardInvitationInput.safeParse({ role: 'owner' }).success).toBe(false)
    expect(CreateBoardInvitationInput.safeParse({ role: 'commenter' }).success).toBe(true)
  })

  it('dev handles are constrained', () => {
    expect(DevLoginInput.safeParse({ handle: 'alice' }).success).toBe(true)
    expect(DevLoginInput.safeParse({ handle: 'Alice!' }).success).toBe(false)
  })

  it('ticket responses carry a known role', () => {
    const ok = {
      ticket: 'v1.a.b',
      expiresAt: 1,
      role: 'viewer',
      user: { id: 'usr_0123456789abcdefghij', name: 'A', color: '#000' },
    }
    expect(TicketResponse.safeParse(ok).success).toBe(true)
    expect(TicketResponse.safeParse({ ...ok, role: 'root' }).success).toBe(false)
  })
})
