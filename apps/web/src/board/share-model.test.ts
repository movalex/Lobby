import { describe, expect, it } from 'vitest'
import { makeUser, member, wsMember } from '../api/test-fixtures.ts'
import {
  type AccessDetail,
  accessSource,
  checkInviteEmail,
  emailInviteHint,
  emailInviteOutcome,
  grantEditable,
  inviteRoleOptions,
  linkAccessLine,
  linkForEmailHint,
  memberRoleEditable,
  parseInviteTarget,
  removalNote,
  removeConfirmText,
  shareableWorkspaceMembers,
  sortMembers,
  VISIBILITY_OPTIONS,
} from './share-model.ts'

describe('share dialog model', () => {
  it('invite links never offer ownership', () => {
    expect(inviteRoleOptions()).toEqual(['editor', 'commenter', 'viewer'])
  })

  it('only explicit grants get a role select (workspace-derived access is not changed by a grant)', () => {
    expect(memberRoleEditable(member('bob', 'viewer', 'grant'))).toBe(true)
    expect(memberRoleEditable(member('carol', 'owner', 'workspace'))).toBe(false)
  })

  it('offers workspace members without a grant, excluding admins/owners (already owners everywhere)', () => {
    const board = [member('alice', 'owner', 'grant'), member('dana', 'viewer', 'workspace')]
    const ws = [
      wsMember('alice', 'member'),
      wsMember('bob', 'member'),
      wsMember('carol', 'admin'),
      wsMember('dana', 'member'),
      wsMember('erin', 'guest'),
      wsMember('olga', 'owner'),
    ]
    expect(shareableWorkspaceMembers(ws, board).map((m) => m.user.handle)).toEqual(['bob', 'dana', 'erin'])
  })

  it('lists you first, then owners, then by name', () => {
    const me = makeUser('zed').id
    const sorted = sortMembers(
      [member('bob', 'viewer'), member('amy', 'editor'), member('zed', 'viewer'), member('carl', 'owner')],
      me,
    )
    expect(sorted.map((m) => m.user.handle)).toEqual(['zed', 'carl', 'amy', 'bob'])
  })

  it('describes every visibility with the workspace name where it matters', () => {
    expect(VISIBILITY_OPTIONS.map((o) => o.value)).toEqual(['private', 'workspace_view', 'workspace_edit'])
    expect(VISIBILITY_OPTIONS[1]?.describe('Dev Studio')).toContain('Dev Studio')
  })
})

describe('share dialog: invite by @handle, name or email (PRS-02)', () => {
  const ws = [wsMember('bob', 'member'), wsMember('carol', 'member'), wsMember('dana', 'guest')]
  const board = [member('carol', 'viewer', 'grant')]

  it('grants workspace people directly (by handle with or without @, or exact name)', () => {
    expect(parseInviteTarget('@bob', ws, board)).toMatchObject({
      kind: 'member',
      member: { user: { handle: 'bob' } },
    })
    expect(parseInviteTarget('BOB', ws, board)).toMatchObject({ kind: 'member' })
    expect(parseInviteTarget('  Dana ', ws, board)).toMatchObject({
      kind: 'member',
      member: { user: { handle: 'dana' } },
    })
  })

  it('someone already invited is pointed at their row instead', () => {
    expect(parseInviteTarget('@carol', ws, board)).toMatchObject({ kind: 'already' })
  })

  it('emails and unknown people get an invite link to send (no email is sent)', () => {
    expect(parseInviteTarget('pat@client.example', ws, board)).toEqual({
      kind: 'email',
      email: 'pat@client.example',
    })
    expect(parseInviteTarget('@zed', ws, board)).toEqual({ kind: 'unknown', text: '@zed' })
    expect(parseInviteTarget('   ', ws, board)).toEqual({ kind: 'empty' })
  })
})

describe('share dialog: through which grant, and what removal leaves', () => {
  const detail = (over: Partial<AccessDetail>): AccessDetail => ({
    user: { id: 'usr_x' },
    role: 'editor',
    source: 'grant',
    grant: 'editor',
    workspaceRole: 'member',
    withoutGrant: null,
    viaReviewLink: false,
    linkEndsAt: null,
    ...over,
  })
  const fmt = (iso: string) => iso.slice(0, 10)

  it('names the source of each person’s access', () => {
    expect(accessSource(detail({}), 'Dev Studio', fmt)).toBe('Direct access')
    expect(accessSource(detail({ workspaceRole: 'guest' }), 'Dev Studio', fmt)).toBe('Direct access · guest')
    expect(
      accessSource(
        detail({ role: 'owner', source: 'workspace', grant: null, workspaceRole: 'admin' }),
        'Dev Studio',
        fmt,
      ),
    ).toBe('Dev Studio admin · owns every board')
    expect(accessSource(detail({ source: 'workspace', grant: 'viewer' }), 'Dev Studio', fmt)).toBe(
      'Everyone in Dev Studio can edit (also invited as “Can view”)',
    )
    expect(
      accessSource(
        detail({
          viaReviewLink: true,
          role: 'commenter',
          grant: 'commenter',
          linkEndsAt: '2026-10-10T00:00:00Z',
        }),
        'W',
        fmt,
      ),
    ).toBe('Joined with a review link · until 2026-10-10')
  })

  it('says when removing a direct invite leaves access through the workspace', () => {
    expect(removalNote(detail({ withoutGrant: 'viewer' }))).toBe(
      'Removing their invite leaves “Can view” through the workspace.',
    )
    expect(removalNote(detail({ withoutGrant: null }))).toBeNull()
    expect(removalNote(detail({ grant: null, withoutGrant: 'viewer' }))).toBeNull()
  })

  it('only direct grants are editable', () => {
    expect(grantEditable({ grant: 'viewer', workspaceRole: 'member' })).toBe(true)
    expect(grantEditable({ grant: 'viewer', workspaceRole: 'guest' })).toBe(true)
    expect(grantEditable({ grant: null, workspaceRole: 'member' })).toBe(false)
    // Workspace owners/admins own every board: a grant changes nothing for them.
    expect(grantEditable({ grant: 'editor', workspaceRole: 'admin' })).toBe(false)
  })
})

describe('shell-sharing-platform fixes', () => {
  const fmt = (iso: string, kind: 'date' | 'time') => `${kind}:${iso.slice(5, 10)}`
  it('a non-manager learns that a link lets people in although the select says Private (PRI-07)', () => {
    expect(linkAccessLine([], fmt)).toBeNull()
    expect(
      linkAccessLine(
        [
          { role: 'viewer', expiresAt: '2026-12-01T10:00:00Z' },
          { role: 'commenter', expiresAt: '2026-10-04T10:00:00Z' },
        ],
        fmt,
      ),
    ).toBe('Anyone with the review link can comment until date:10-04.')
    expect(linkAccessLine([{ role: 'viewer', expiresAt: '2026-10-09T10:00:00Z' }], fmt)).toBe(
      'Anyone with the review link can view until date:10-09.',
    )
    expect(
      linkAccessLine(
        [
          { role: 'commenter', expiresAt: '2026-10-04T10:00:00Z' },
          { role: 'editor', expiresAt: '2026-09-27T15:40:00Z' },
        ],
        fmt,
      ),
    ).toBe('Anyone with the workshop link can edit until time:09-27.')
  })

  it('removing someone asks first and says what happens (PRI-21)', () => {
    expect(removeConfirmText('Priya', null)).toBe('Remove Priya? Priya loses access now.')
    expect(removeConfirmText('Bob', 'Removing their invite leaves “Can view” through the workspace.')).toBe(
      'Remove Bob’s invite? Removing their invite leaves “Can view” through the workspace.',
    )
  })
})

describe('invite by email', () => {
  const fmt = (iso: string) => `date:${iso.slice(5, 10)}`
  const at = '2026-10-04T12:00:00.000Z'
  const id = 'inv_0123456789abcdefghij'
  const url = 'http://127.0.0.1:5173/invite/abc'

  it('checks the address the way the API reads it', () => {
    expect(checkInviteEmail('  Pat@Client.Example ')).toEqual({ ok: true, email: 'pat@client.example' })
    expect(checkInviteEmail('')).toEqual({ ok: false, message: 'Enter an email address.' })
    expect(checkInviteEmail('pat@')).toEqual({ ok: false, message: 'Enter a valid email address.' })
    expect(checkInviteEmail(`${'a'.repeat(250)}@b.example`)).toEqual({
      ok: false,
      message: 'That email address is too long.',
    })
  })

  it('says whether this server can email at all', () => {
    expect(emailInviteHint(true)).toBe(
      'We email them an invitation to this board. People who already use Lobby get access right away.',
    )
    expect(emailInviteHint(false)).toContain('needs Clerk sign-in')
    // The @handle field keeps its link-only wording on a server that cannot email.
    expect(linkForEmailHint(false)).toBe(
      'Lobby does not send email: you get a one-time invite link to copy and send them yourself.',
    )
    expect(linkForEmailHint(true)).toContain('use “Invite by email” below')
  })

  it('someone who already uses Lobby: added, or already there (nothing lowered)', () => {
    const user = makeUser('bob', { name: 'Bob Chen' })
    expect(
      emailInviteOutcome(
        { mode: 'granted', user, role: 'commenter', alreadyHadAccess: false },
        'commenter',
        fmt,
      ),
    ).toEqual({
      tone: 'success',
      text: 'Added Bob Chen to this board.',
      detail: 'They already use Lobby, so they can open it now, as “Can comment”.',
      link: null,
    })
    const already = emailInviteOutcome(
      { mode: 'granted', user, role: 'editor', alreadyHadAccess: true },
      'viewer',
      fmt,
    )
    expect(already).toMatchObject({
      tone: 'info',
      text: 'Bob Chen already has access to this board (“Can edit”).',
      link: null,
    })
  })

  it('emailed: names the address, the role and the expiry; no link to copy', () => {
    expect(
      emailInviteOutcome(
        { mode: 'emailed', email: 'pat@client.example', invitationId: id, expiresAt: at },
        'viewer',
        fmt,
      ),
    ).toEqual({
      tone: 'success',
      text: 'Invitation email sent to pat@client.example.',
      detail: 'The link in it works once, as “Can view”, until date:10-04.',
      link: null,
    })
  })

  it('no email went out: the link to copy, and why, for every reason', () => {
    const reasons = {
      email_not_configured: 'This server can’t send email: that needs Clerk sign-in.',
      existing_account: 'pat@client.example has a sign-in account but hasn’t opened Lobby yet',
      invalid_email: 'The email service didn’t accept pat@client.example.',
      rate_limited: 'The email service is limiting invitations right now.',
      provider_error: 'The email service couldn’t send it right now.',
    } as const
    for (const [reason, why] of Object.entries(reasons)) {
      const outcome = emailInviteOutcome(
        {
          mode: 'link',
          reason: reason as keyof typeof reasons,
          email: 'pat@client.example',
          invitationId: id,
          url,
          expiresAt: at,
        },
        'editor',
        fmt,
      )
      expect(outcome.tone).toBe('fallback')
      expect(outcome.text).toBe('Couldn’t email — copy this link instead.')
      expect(outcome.detail).toContain(why)
      expect(outcome.detail).toContain('It works once, as “Can edit”, until date:10-04.')
      expect(outcome.link).toBe(url)
    }
  })
})
