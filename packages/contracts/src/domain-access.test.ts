// Domain access contracts (docs/DOMAIN-ACCESS-CONTRACTS.md §7).
import { describe, expect, it } from 'vitest'
import {
  AccountEmail,
  asciiLowercase,
  CreateBoardInvitationInput,
  CreateWorkspaceInvitationInput,
  DevLoginInput,
  DOMAIN_ACCESS_CODES,
  EmailInviteInput,
  INVITE_EMAIL_MAX_LENGTH,
  InvitationEmailLock,
  InvitationEmailMismatchBody,
  InvitationPreview,
  isClerkTestAddress,
  ME_ACCESS_LEGACY,
  Me,
  MeAccess,
  PendingInvitation,
  ShareMember,
} from './index.ts'

const user = { id: 'usr_0123456789abcdefghij', name: 'Pat', handle: null, color: '#000000', avatarUrl: null }
const firstMessage = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? null : r.error?.issues[0]?.message

describe('AccountEmail', () => {
  it('trims and lowercases ASCII letters only', () => {
    expect(AccountEmail.parse('  Pat@Client.Example.Test ')).toBe('pat@client.example.test')
    expect(AccountEmail.parse('lobby-test-A@DarkBurn.com')).toBe('lobby-test-a@darkburn.com')
    expect(asciiLowercase('ÀBK')).toBe('ÀbK')
  })

  it('refuses non-ASCII look-alikes instead of folding them into a real domain', () => {
    for (const email of [
      'a@darKburn.com', // U+212A KELVIN SIGN, which toLowerCase() turns into "k"
      'a＠darkburn.com', // FULLWIDTH COMMERCIAL AT
      'a@dаrkburn.com', // Cyrillic a
      'a@İnc.example', // Latin capital I with dot above
      'a b@darkburn.com',
    ])
      expect(firstMessage(AccountEmail.safeParse(email)), email).toBe('Enter a valid email address.')
  })

  it('refuses Clerk test-mode addresses in any case', () => {
    for (const email of [
      'anyone+clerk_test@darkburn.com',
      'Anyone+CLERK_TEST@darkburn.com',
      'x+clerk_test_2@a.example',
    ])
      expect(firstMessage(AccountEmail.safeParse(email)), email).toMatch(/\+clerk_test/)
    expect(isClerkTestAddress('A+Clerk_Test@b.example')).toBe(true)
    expect(isClerkTestAddress('a+clerk@b.example')).toBe(false)
    expect(AccountEmail.parse('pat+design@client.example')).toBe('pat+design@client.example')
  })

  it('bounds the length and asks for an address when empty', () => {
    expect(INVITE_EMAIL_MAX_LENGTH).toBe(254)
    expect(firstMessage(AccountEmail.safeParse(''))).toBe('Enter an email address.')
    expect(firstMessage(AccountEmail.safeParse('   '))).toBe('Enter an email address.')
    expect(firstMessage(AccountEmail.safeParse(`${'a'.repeat(245)}@b.example`))).toBe(
      'That email address is too long.',
    )
    for (const email of ['pat', 'pat@', '@client.example', '"x@darkburn.com"@evil.test', 'a@b@evil.test'])
      expect(AccountEmail.safeParse(email).success, email).toBe(false)
  })

  it('is the email invitation address too', () => {
    expect(EmailInviteInput.safeParse({ email: 'x+clerk_test@client.example', role: 'viewer' }).success).toBe(
      false,
    )
  })
})

describe('inputs', () => {
  it('dev sign-in takes an optional address', () => {
    expect(DevLoginInput.parse({ handle: 'alice' })).toEqual({ handle: 'alice' })
    expect(DevLoginInput.parse({ handle: 'sam', email: 'Sam@Client.Example.Test' })).toEqual({
      handle: 'sam',
      email: 'sam@client.example.test',
    })
    expect(DevLoginInput.safeParse({ handle: 'sam', email: 'sam' }).success).toBe(false)
  })

  it('single-use invitations carry the address they are locked to (required since step B2)', () => {
    expect(CreateBoardInvitationInput.parse({ role: 'editor', email: ' Pat@Client.Example ' })).toEqual({
      role: 'editor',
      email: 'pat@client.example',
    })
    expect(CreateBoardInvitationInput.safeParse({ role: 'owner', email: 'pat@client.example' }).success).toBe(
      false,
    )
    expect(CreateWorkspaceInvitationInput.parse({ role: 'member', email: 'pat@client.example' })).toEqual({
      role: 'member',
      email: 'pat@client.example',
    })
    expect(CreateWorkspaceInvitationInput.safeParse({ role: 'member', email: 'nope' }).success).toBe(false)
    expect(CreateWorkspaceInvitationInput.safeParse({ role: 'member' }).success).toBe(false)
    expect(CreateBoardInvitationInput.safeParse({ role: 'viewer' }).success).toBe(false)
    expect(
      CreateBoardInvitationInput.safeParse({ role: 'viewer', email: 'x+clerk_test@client.example' }).success,
    ).toBe(false)
  })
})

describe('responses', () => {
  it('Me.access defaults to the legacy answer (an api from before domain access gates nothing)', () => {
    expect(Me.parse({ user, workspaces: [] }).access).toEqual(ME_ACCESS_LEGACY)
    expect(ME_ACCESS_LEGACY).toEqual({ creator: true, reason: 'legacy', email: null })
    const access = { creator: false, reason: 'outside', email: 'pat@client.example' }
    expect(Me.parse({ user, workspaces: [], access }).access).toEqual(access)
    expect(MeAccess.safeParse({ ...access, reason: 'maybe' }).success).toBe(false)
  })

  it('invitation previews gain the lock with defaults', () => {
    const preview = {
      workspace: { id: 'wsp_0123456789abcdefghij', name: 'Studio' },
      board: null,
      role: 'member',
      invitedBy: { name: 'Alice' },
      expiresAt: '2026-10-04T12:00:00.000Z',
    }
    const Preview = InvitationPreview.extend(InvitationEmailLock.shape)
    expect(Preview.parse(preview)).toMatchObject({
      emailLocked: false,
      invitedEmailHint: null,
      matchesYou: null,
    })
    expect(
      Preview.parse({
        ...preview,
        emailLocked: true,
        invitedEmailHint: 'p•••@client.example',
        matchesYou: false,
      }),
    ).toMatchObject({ emailLocked: true, invitedEmailHint: 'p•••@client.example', matchesYou: false })
  })

  it('the mismatch body has its own code and a masked hint', () => {
    const body = {
      error: { code: DOMAIN_ACCESS_CODES.emailMismatch, message: 'm' },
      mismatch: { invitedEmailHint: 'p•••@client.example', invitedBy: null },
    }
    expect(InvitationEmailMismatchBody.parse(body)).toEqual(body)
    expect(
      InvitationEmailMismatchBody.safeParse({ ...body, error: { code: 'CREATOR_REQUIRED', message: 'm' } })
        .success,
    ).toBe(false)
  })

  it('pending invitations and share members gain defaulted fields', () => {
    const pending = {
      id: 'inv_0123456789abcdefghij',
      kind: 'invite',
      role: 'viewer',
      createdAt: 'a',
      expiresAt: 'b',
      createdBy: { id: 'usr_0123456789abcdefghij', name: 'Alice' },
      uses: 0,
      maxUses: null,
      url: null,
    }
    expect(PendingInvitation.parse(pending).email).toBeNull()
    expect(PendingInvitation.parse({ ...pending, email: 'pat@client.example' }).email).toBe(
      'pat@client.example',
    )
    const member = {
      user,
      role: 'editor',
      source: 'grant',
      grant: 'editor',
      workspaceRole: 'member',
      withoutGrant: null,
      viaReviewLink: false,
      linkEndsAt: null,
    }
    expect(ShareMember.parse(member).canOwn).toBe(true)
    expect(ShareMember.parse({ ...member, canOwn: false }).canOwn).toBe(false)
  })
})
