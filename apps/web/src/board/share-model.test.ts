import { CLERK_TEST_ADDRESS_MESSAGE, DOMAIN_ACCESS_MESSAGES } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { makeUser, member, wsMember } from '../api/test-fixtures.ts'
import { REVIEW_LINK_DAY_OPTIONS, REVIEW_LINK_DEFAULT_DAY } from '../features/sharing/model.ts'
import {
  type AccessDetail,
  ADD_MEMBER_ROLES,
  ASK_EMAIL_PROMPT,
  accessSource,
  CLIENT_LINK_DEFAULTS,
  checkInviteEmail,
  clientLinkHint,
  emailInviteHint,
  emailInviteOutcome,
  grantEditable,
  invitePlan,
  inviteRoleOptions,
  linkAccessLine,
  linkForEmailHint,
  lockedLinkNote,
  memberRoleChoices,
  memberRoleEditable,
  moreWaysSummary,
  OWNER_NEEDS_CREATOR,
  OWNER_NEEDS_CREATOR_NOTE,
  parseInviteTarget,
  pendingInviteLabel,
  removalNote,
  removeConfirmText,
  shareableWorkspaceMembers,
  shareCreatorNote,
  showOwnerNote,
  sortMembers,
  UNCONFIRMED_SHARE_NOTE,
  VISIBILITY_OPTIONS,
  visibilityChoices,
  WORKSHOP_LINK_GUESTS_DEFAULT,
  workshopLinkHint,
} from './share-model.ts'

describe('share with a client, workshop link, more ways to share (DANA-03, F3, R15)', () => {
  it('a client link starts as comment, 14 days, join with just a name; a workshop (edit) link without guests', () => {
    expect(CLIENT_LINK_DEFAULTS).toEqual({ role: 'commenter', allowGuests: true })
    expect(REVIEW_LINK_DEFAULT_DAY).toBe(14)
    expect(REVIEW_LINK_DAY_OPTIONS).toContain(REVIEW_LINK_DEFAULT_DAY)
    expect(WORKSHOP_LINK_GUESTS_DEFAULT).toBe(false)
  })

  it('never says "after signing in" while guests may join with just a name', () => {
    expect(workshopLinkHint(true)).not.toMatch(/sign/i)
    expect(workshopLinkHint(true)).toContain('with just a name or an account')
    expect(workshopLinkHint(false)).toContain('after signing in')
    expect(clientLinkHint('commenter', true)).not.toMatch(/sign/i)
    expect(clientLinkHint('commenter', true)).toContain('to comment, never edit. No account needed')
    expect(clientLinkHint('viewer', false)).toContain('to view, never edit. They sign in to open it')
  })

  it('the collapsed summary names what is inside, or what is open in there', () => {
    expect(moreWaysSummary({ workshopLinks: 0, unusedInvites: 0 })).toBe(
      'Workshop link for a live session, invite by email, one-time invite links',
    )
    expect(moreWaysSummary({ workshopLinks: 1, unusedInvites: 0 })).toBe('1 workshop link open')
    expect(moreWaysSummary({ workshopLinks: 2, unusedInvites: 1 })).toBe(
      '2 workshop links open · 1 unused invite link',
    )
    expect(moreWaysSummary({ workshopLinks: 0, unusedInvites: 3 })).toBe('3 unused invite links')
  })
})

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

  it('tells a workshop link from a review link, and gives a workshop link its time of day (F7)', () => {
    // The grant a link gave carries the link's role: only a workshop link gives edit.
    const kinds: string[] = []
    const format = (iso: string, kind: 'date' | 'time') => {
      kinds.push(kind)
      return kind === 'time' ? `${iso.slice(11, 16)}` : iso.slice(0, 10)
    }
    expect(
      accessSource(
        detail({ viaReviewLink: true, role: 'editor', grant: 'editor', linkEndsAt: '2026-09-28T00:44:00Z' }),
        'W',
        format,
      ),
    ).toBe('Joined with the workshop link · until 00:44')
    expect(accessSource(detail({ viaReviewLink: true, role: 'editor', grant: 'editor' }), 'W', format)).toBe(
      'Joined with the workshop link',
    )
    expect(
      accessSource(
        detail({ viaReviewLink: true, role: 'viewer', grant: 'viewer', linkEndsAt: '2026-10-10T00:00:00Z' }),
        'W',
        format,
      ),
    ).toBe('Joined with a review link · until 2026-10-10')
    expect(kinds).toEqual(['time', 'date'])
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
      'We email them an invitation to this board that works only for that address. People who already use Lobby get access right away.',
    )
    expect(emailInviteHint(false)).toContain('needs Clerk sign-in')
    // Domain access: every invitation to an address works only for that address.
    expect(emailInviteHint(false)).toContain('works only for that address')
    // The @handle field keeps its link-only wording on a server that cannot email.
    expect(linkForEmailHint(false)).toBe(
      'Lobby does not send email: you get a one-time invite link that only this address can use, to copy and send them yourself.',
    )
    expect(linkForEmailHint(true)).toContain('use “Invite by email” below')
    expect(linkForEmailHint(true)).toContain('only this address can use')
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
      detail: 'The link in it works once, only for pat@client.example, as “Can view”, until date:10-04.',
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
      expect(outcome.detail).toContain(
        'It works once, only for pat@client.example, as “Can edit”, until date:10-04.',
      )
      expect(outcome.link).toBe(url)
    }
  })
})

describe('domain access: invitations locked to an address (docs/DOMAIN-ACCESS-CONTRACTS.md §9)', () => {
  const ws = [wsMember('bob', 'member'), wsMember('carol', 'member')]
  const board = [member('carol', 'viewer', 'grant')]
  const plan = (text: string) => invitePlan(parseInviteTarget(text, ws, board))
  const fmt = (iso: string) => `date:${iso.slice(5, 10)}`

  it('an email target makes a locked link (normalised address) through createBoardInvitation, never a grant', () => {
    expect(plan('  Pat@Client.Example.Test ')).toEqual({
      kind: 'locked-link',
      email: 'pat@client.example.test',
    })
    expect(plan('@bob')).toMatchObject({ kind: 'grant', member: { user: { handle: 'bob' } } })
    expect(plan('@carol')).toMatchObject({ kind: 'already' })
    expect(plan('  ')).toEqual({ kind: 'none' })
  })

  it('an unknown name asks for their email address instead of making a link', () => {
    expect(plan('@zed')).toEqual({ kind: 'ask-email' })
    expect(plan('Someone New')).toEqual({ kind: 'ask-email' })
    expect(ASK_EMAIL_PROMPT).toBe('Enter their email address to invite them.')
  })

  it('an address the api would refuse is refused here: Clerk test addresses, non-ASCII look-alikes', () => {
    expect(plan('anyone+clerk_test@darkburn.com')).toEqual({
      kind: 'invalid-email',
      message: CLERK_TEST_ADDRESS_MESSAGE,
    })
    expect(plan('Anyone+CLERK_TEST@client.example.test')).toMatchObject({ kind: 'invalid-email' })
    // U+212A KELVIN SIGN: never lowercased into a real domain.
    expect(plan('pat@dar\u212Aburn.com')).toEqual({
      kind: 'invalid-email',
      message: 'Enter a valid email address.',
    })
  })

  it('checkInviteEmail refuses +clerk_test in any case', () => {
    expect(checkInviteEmail('a+clerk_test@client.example.test')).toEqual({
      ok: false,
      message: CLERK_TEST_ADDRESS_MESSAGE,
    })
    expect(checkInviteEmail('A+Clerk_Test@client.example.test')).toMatchObject({ ok: false })
  })

  it('the locked-link copy: only that address, once, until when; anyone else is turned away; no email', () => {
    const note = lockedLinkNote(
      { email: 'pat@client.example.test', role: 'commenter', expiresAt: '2026-10-04T12:00:00.000Z' },
      fmt,
    )
    expect(note).toContain('Only pat@client.example.test can use this link, once, until date:10-04.')
    expect(note).toContain('Anyone else who opens it is turned away.')
    expect(note).toContain('no email is sent')
    expect(note).toContain('“Can comment”')
  })

  it('a pending row names the address it is for; an older one reads as before', () => {
    const inv = {
      role: 'viewer' as const,
      expiresAt: '2026-10-04T12:00:00.000Z',
      createdBy: { name: 'Alice' },
    }
    expect(pendingInviteLabel({ ...inv, email: 'pat@client.example.test' }, fmt)).toBe(
      'For pat@client.example.test · Can view · expires date:10-04 · by Alice',
    )
    expect(pendingInviteLabel({ ...inv, email: null }, fmt)).toBe(
      'Unused link · Can view · expires date:10-04 · by Alice',
    )
  })
})

describe('domain access: what a manager who is not a creator can do (D4, D5)', () => {
  const roles = (c: ReturnType<typeof memberRoleChoices>) => c.map((x) => x.role)

  it('a creator gets every role; owner is off, with the reason, for someone who cannot own boards', () => {
    expect(roles(memberRoleChoices({ current: 'viewer', canShare: true }))).toEqual([
      'owner',
      'editor',
      'commenter',
      'viewer',
    ])
    const outsider = memberRoleChoices({ current: 'editor', canShare: true, canOwn: false })
    expect(outsider.find((c) => c.role === 'owner')).toEqual({
      role: 'owner',
      disabled: true,
      title: OWNER_NEEDS_CREATOR,
    })
    expect(outsider.filter((c) => c.disabled).map((c) => c.role)).toEqual(['owner'])
    // An older api omits canOwn: owner stays on (its server allows it).
    expect(memberRoleChoices({ current: 'editor', canShare: true }).every((c) => !c.disabled)).toBe(true)
    // An existing owner who is an outsider keeps the current value selectable (decision 4).
    expect(memberRoleChoices({ current: 'owner', canShare: true, canOwn: false })[0]).toEqual({
      role: 'owner',
      disabled: false,
    })
    // Name-only guests are never offered ownership.
    expect(roles(memberRoleChoices({ current: 'viewer', canShare: true, guest: true }))).not.toContain(
      'owner',
    )
  })

  it('a non-creator manager only lowers: the current role and the ones below it', () => {
    expect(roles(memberRoleChoices({ current: 'editor', canShare: false }))).toEqual([
      'editor',
      'commenter',
      'viewer',
    ])
    expect(roles(memberRoleChoices({ current: 'owner', canShare: false }))).toEqual([
      'owner',
      'editor',
      'commenter',
      'viewer',
    ])
    expect(roles(memberRoleChoices({ current: 'viewer', canShare: false }))).toEqual(['viewer'])
  })

  it('workspace access: a non-creator can narrow it, never widen it', () => {
    const off = (v: Parameters<typeof visibilityChoices>[0], raise: boolean) =>
      visibilityChoices(v, raise)
        .filter((o) => o.disabled)
        .map((o) => o.value)
    expect(off('workspace_view', false)).toEqual(['workspace_edit'])
    expect(off('private', false)).toEqual(['workspace_view', 'workspace_edit'])
    expect(off('workspace_edit', false)).toEqual([])
    expect(off('private', true)).toEqual([])
    expect(visibilityChoices('private', true).map((o) => o.label)).toEqual(
      VISIBILITY_OPTIONS.map((o) => o.label),
    )
  })
})

describe('domain access, fixer round 1: the notes a non-creator and a creator managing outsiders read', () => {
  it('the Share note: an outside account gets the server message; an unconfirmed one is told it is paused', () => {
    expect(shareCreatorNote({ creator: false, reason: 'outside' })).toEqual({
      reason: 'outside',
      text: DOMAIN_ACCESS_MESSAGES.creatorRequiredShare,
    })
    const paused = shareCreatorNote({ creator: false, reason: 'unconfirmed' })
    expect(paused).toEqual({ reason: 'unconfirmed', text: UNCONFIRMED_SHARE_NOTE })
    // A Dark Burn person Lobby could not confirm is never told they are not at Dark Burn Creative.
    expect(paused.text).not.toMatch(/Only people at Dark Burn/)
    expect(paused.text).toMatch(/couldn't confirm your account/)
    expect(paused.text).toMatch(/You can still lower or remove access/)
    // No session yet: the server's message (the note only shows for managers anyway).
    expect(shareCreatorNote(null).reason).toBe('outside')
  })

  it('"Or pick someone from the workspace…" never offers owner; ownership is set on the person’s row', () => {
    expect(ADD_MEMBER_ROLES).toEqual(['editor', 'commenter', 'viewer'])
  })

  it('a row says in words why its owner option is off (a creator managing an outsider)', () => {
    expect(OWNER_NEEDS_CREATOR_NOTE).toBe(
      "Can't own this board. Only people at Dark Burn Creative or Trailer Park Group can own boards.",
    )
    expect(showOwnerNote({ canShare: true, canOwn: false, current: 'editor' })).toBe(true)
    // Already an owner (decision 4), a creator, an older api (undefined) or a reduce-only manager: no note.
    expect(showOwnerNote({ canShare: true, canOwn: false, current: 'owner' })).toBe(false)
    expect(showOwnerNote({ canShare: true, canOwn: true, current: 'editor' })).toBe(false)
    expect(showOwnerNote({ canShare: true, current: 'editor' })).toBe(false)
    expect(showOwnerNote({ canShare: false, canOwn: false, current: 'editor' })).toBe(false)
  })
})
