import { describe, expect, it } from 'vitest'
import {
  BoardId,
  CreateBoardInvitationInput,
  DevLoginInput,
  EmailInviteInput,
  EmailInviteResult,
  ListWorkspaceMembersResponse,
  PatchBoardInput,
  PatchWorkspaceMemberInput,
  TicketResponse,
  WORKSPACE_MEMBER_CODES,
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
    expect(CreateBoardInvitationInput.safeParse({ role: 'owner', email: 'pat@client.example' }).success).toBe(
      false,
    )
    // Domain access (step B2): every single-use invitation names the address it is locked to.
    expect(CreateBoardInvitationInput.safeParse({ role: 'commenter' }).success).toBe(false)
    expect(
      CreateBoardInvitationInput.safeParse({ role: 'commenter', email: 'pat@client.example' }).success,
    ).toBe(true)
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

  it('email invitations: one spelling per address, a real address, never ownership', () => {
    expect(EmailInviteInput.parse({ email: '  Pat@Client.Example ', role: 'viewer' })).toEqual({
      email: 'pat@client.example',
      role: 'viewer',
    })
    for (const email of ['', '   ', 'pat', 'pat@', '@client.example', 'pat@client', 'a b@c.example'])
      expect(EmailInviteInput.safeParse({ email, role: 'viewer' }).success, email).toBe(false)
    expect(
      EmailInviteInput.safeParse({ email: `${'a'.repeat(245)}@b.example`, role: 'viewer' }).success,
    ).toBe(false)
    expect(EmailInviteInput.safeParse({ email: 'pat@client.example', role: 'owner' }).success).toBe(false)
  })

  it('email invitation results are told apart by mode (parsed through the index re-export)', () => {
    const user = { id: 'usr_0123456789abcdefghij', name: 'Bob', handle: null, color: '#000', avatarUrl: null }
    const id = 'inv_0123456789abcdefghij'
    const at = '2026-10-04T12:00:00.000Z'
    expect(
      EmailInviteResult.parse({ mode: 'granted', user, role: 'editor', alreadyHadAccess: false }).mode,
    ).toBe('granted')
    expect(
      EmailInviteResult.parse({ mode: 'emailed', email: 'a@b.example', invitationId: id, expiresAt: at })
        .mode,
    ).toBe('emailed')
    const link = {
      mode: 'link',
      reason: 'provider_error',
      email: 'a@b.example',
      invitationId: id,
      url: 'u',
      expiresAt: at,
    }
    expect(EmailInviteResult.parse(link).mode).toBe('link')
    expect(EmailInviteResult.safeParse({ ...link, reason: 'because' }).success).toBe(false)
    expect(EmailInviteResult.safeParse({ ...link, mode: 'sent' }).success).toBe(false)
  })

  it('authz-006: a workspace member’s role is one of the workspace roles; the list answers PATCH and DELETE', () => {
    for (const role of ['owner', 'admin', 'member', 'guest'])
      expect(PatchWorkspaceMemberInput.parse({ role })).toEqual({ role })
    expect(PatchWorkspaceMemberInput.safeParse({ role: 'editor' }).success).toBe(false)
    expect(PatchWorkspaceMemberInput.safeParse({}).success).toBe(false)
    const user = { id: 'usr_0123456789abcdefghij', name: 'Bob', handle: null, color: '#000', avatarUrl: null }
    expect(ListWorkspaceMembersResponse.parse({ members: [{ user, role: 'admin' }] }).members).toHaveLength(1)
    expect(ListWorkspaceMembersResponse.safeParse({ members: [{ user, role: 'viewer' }] }).success).toBe(
      false,
    )
    expect(WORKSPACE_MEMBER_CODES).toEqual({
      lastOwner: 'LAST_OWNER',
      ownerOnly: 'OWNER_ONLY',
      personalOwner: 'PERSONAL_WORKSPACE_OWNER',
    })
  })
})
