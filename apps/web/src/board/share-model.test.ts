import {
  CLERK_TEST_ADDRESS_MESSAGE,
  DOMAIN_ACCESS_MESSAGES,
  type WorkspaceMember,
} from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { makeUser, member, wsMember } from '../api/test-fixtures.ts'
import { REVIEW_LINK_DAY_OPTIONS, REVIEW_LINK_DEFAULT_DAY } from '../features/sharing/model.ts'
import {
  type AccessDetail,
  ADD_MEMBER_ROLES,
  ADVANCED_SECTION_TITLE,
  ASK_EMAIL_PROMPT,
  accessSource,
  advancedSummary,
  CLIENT_LINK_DEFAULTS,
  checkInviteEmail,
  clientLinkHint,
  emailInviteHint,
  emailInviteOutcome,
  GUESTS_SECTION_TITLE,
  GUESTS_TOGGLE_LABEL,
  grantEditable,
  guestsOptionLabel,
  guestsSummary,
  guestsToggleSaying,
  INVITE_IDLE_HINT,
  inviteHintText,
  inviteMatches,
  invitePlan,
  inviteRoleOptions,
  isOwnAddress,
  linkAccessLine,
  linkForEmailHint,
  listShowsOwnerNote,
  lockedLinkNote,
  MAX_INVITE_SUGGESTIONS,
  memberMatches,
  memberRoleChoices,
  memberRoleEditable,
  OWN_ADDRESS_MESSAGE,
  OWNER_NEEDS_CREATOR,
  OWNER_NEEDS_CREATOR_NOTE,
  type OwnerNoteRow,
  parseInviteTarget,
  pendingInviteLabel,
  pickedText,
  removalNote,
  removeConfirmText,
  rowNeedsOwnerNote,
  shareableWorkspaceMembers,
  shareCreatorNote,
  showOwnerNote,
  sortMembers,
  targetFor,
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

  it('G2: with a link already open, the box above Create and the line under the heading are about the NEXT link', () => {
    // nothing open: the texts every earlier test and spec read
    expect(guestsOptionLabel(0)).toBe('Anyone with the link can join with just a name (no account)')
    expect(workshopLinkHint(true, false)).toBe(workshopLinkHint(true))
    expect(clientLinkHint('commenter', true, false)).toBe(clientLinkHint('commenter', true))
    // a link open: they say "next", and still never "sign in" while guests are on
    expect(guestsOptionLabel(1)).toBe(
      'For the next link: anyone with it can join with just a name (no account)',
    )
    expect(guestsOptionLabel(3)).toBe(guestsOptionLabel(1))
    expect(workshopLinkHint(true, true)).toContain('The next workshop link')
    expect(workshopLinkHint(true, true)).toContain('with just a name or an account')
    expect(workshopLinkHint(true, true)).not.toMatch(/sign/i)
    expect(workshopLinkHint(false, true)).toContain('after signing in')
    expect(clientLinkHint('commenter', true, true)).toContain(
      'The next link is for clients and reviewers to comment',
    )
    expect(clientLinkHint('commenter', true, true)).not.toMatch(/sign/i)
    expect(clientLinkHint('viewer', false, true)).toContain('They sign in to open it')
  })

  it('G2: a link’s own guest box says it is for that link, and what turning it off does to people already in', () => {
    expect(GUESTS_TOGGLE_LABEL).toBe('Anyone with this link can join with just a name (no account)')
    expect(guestsToggleSaying(true)).toBe('Anyone with this link can now join with just a name.')
    expect(guestsToggleSaying(false)).toContain('No new guests can join this link')
    expect(guestsToggleSaying(false)).toContain('keep their access until the link ends or is revoked')
  })

  it('K5-5: "Guests and clients", collapsed, names what is inside, or what is open in there', () => {
    expect(GUESTS_SECTION_TITLE).toBe('Guests and clients')
    expect(guestsSummary({ reviewLinks: 0, workshopLinks: 0, unusedInvites: 0 })).toBe(
      'Client review link, workshop link for a live session, invite by email, one-time invite links',
    )
    expect(guestsSummary({ reviewLinks: 0, workshopLinks: 1, unusedInvites: 0 })).toBe('1 workshop link open')
    expect(guestsSummary({ reviewLinks: 1, workshopLinks: 2, unusedInvites: 1 })).toBe(
      '1 client link open · 2 workshop links open · 1 unused invite link',
    )
    expect(guestsSummary({ reviewLinks: 2, workshopLinks: 0, unusedInvites: 3 })).toBe(
      '2 client links open · 3 unused invite links',
    )
  })

  it('K5 review: on an Internal-only board (no client or workshop link can be made) the summary offers neither', () => {
    expect(guestsSummary({ reviewLinks: 0, workshopLinks: 0, unusedInvites: 0 }, { linksAllowed: false })).toBe(
      'Invite by email, one-time invite links',
    )
    // what is still open is said as before (it can be revoked in there)
    expect(guestsSummary({ reviewLinks: 1, workshopLinks: 0, unusedInvites: 0 }, { linksAllowed: false })).toBe(
      '1 client link open',
    )
    expect(guestsSummary({ reviewLinks: 0, workshopLinks: 0, unusedInvites: 0 }, { linksAllowed: true })).toBe(
      'Client review link, workshop link for a live session, invite by email, one-time invite links',
    )
  })

  it('K5-5: "Advanced", collapsed, says the export setting it holds', () => {
    expect(ADVANCED_SECTION_TITLE).toBe('Advanced')
    expect(advancedSummary(null)).toBe('Export and download')
    expect(advancedSummary('editors')).toBe('Export and download: editors and owners only')
    expect(advancedSummary('everyone')).toBe('Export and download: everyone with an account')
    expect(advancedSummary('everyone-including-guests')).toBe('Export and download: everyone, guests too')
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

describe('K5-5: the start of a handle, a name or an address is "partial": the hint names the person', () => {
  const carolS = {
    user: makeUser('carols', { name: 'Carol Smith', handle: null }),
    role: 'member',
  } as const satisfies WorkspaceMember
  const zoe = {
    user: makeUser('zoe', { name: 'Zoë Ng', handle: 'zng' }),
    role: 'member',
  } as const satisfies WorkspaceMember
  const ws = [wsMember('bob', 'member'), wsMember('carol', 'member'), wsMember('dana', 'guest'), carolS, zoe]
  const board = [member('carol', 'viewer', 'grant')]
  const ids = (t: ReturnType<typeof parseInviteTarget>) =>
    t.kind === 'partial' ? t.matches.map((m) => m.user.handle ?? m.user.name) : t.kind
  const hint = (text: string) =>
    inviteHintText(parseInviteTarget(text, ws, board), {
      workspaceName: 'Dev Studio',
      canEmail: false,
      ownAddress: false,
      notice: null,
    })

  it('a prefix of an @handle (with or without @) lists that person, and the hint names them', () => {
    expect(ids(parseInviteTarget('@bo', ws, board))).toEqual(['bob'])
    expect(ids(parseInviteTarget('bo', ws, board))).toEqual(['bob'])
    expect(hint('@bo')).toBe('Pick Bob (@bob) from the list.')
    // an "@" in front of a name too (Clerk accounts have no handle: people type "@carol" for Carol Smith)
    expect(ids(parseInviteTarget('@smi', ws, board))).toEqual(['Carol Smith'])
    expect(ids(parseInviteTarget('@zz', ws, board))).toBe('unknown')
  })

  it('a prefix of a name, or of any word of it, in any case and without accents', () => {
    expect(ids(parseInviteTarget('Car', ws, board))).toEqual(['Carol Smith', 'carol'])
    expect(ids(parseInviteTarget('smi', ws, board))).toEqual(['Carol Smith'])
    expect(hint('smi')).toBe('Pick Carol Smith from the list.')
    expect(ids(parseInviteTarget('zoe', ws, board))).toEqual(['zng'])
    expect(hint('ZOË')).toBe('Pick Zoë Ng (@zng) from the list.')
  })

  it('several people: the ones still without a direct grant first; the hint says how many', () => {
    // carol is on the board already (a viewer grant): after Carol Smith
    expect(ids(parseInviteTarget('c', ws, board))).toEqual(['Carol Smith', 'carol'])
    expect(hint('c')).toBe('2 people in Dev Studio match. Pick one from the list.')
  })

  it('an address being typed: its name part starting a handle lists that person; a whole address is an email', () => {
    expect(ids(parseInviteTarget('bob@dev', ws, board))).toEqual(['bob'])
    expect(ids(parseInviteTarget('bob@dev.example', ws, board))).toBe('email')
    expect(ids(parseInviteTarget('pat@cli', ws, board))).toBe('unknown')
  })

  it('exact handles and names are unchanged: a direct grant, or "already" for someone granted', () => {
    expect(parseInviteTarget('@bob', ws, board)).toMatchObject({
      kind: 'member',
      member: { user: { handle: 'bob' } },
    })
    expect(parseInviteTarget('BOB', ws, board)).toMatchObject({ kind: 'member' })
    expect(parseInviteTarget('Carol Smith', ws, board)).toMatchObject({ kind: 'member' })
    expect(parseInviteTarget('@carol', ws, board)).toMatchObject({ kind: 'already' })
    expect(targetFor(carolS, board)).toMatchObject({ kind: 'member' })
    expect(targetFor(ws[1] as WorkspaceMember, board)).toMatchObject({ kind: 'already' })
  })

  it('nothing that starts anyone: "unknown", one line asking for their address', () => {
    expect(parseInviteTarget('Someone New', ws, board)).toEqual({ kind: 'unknown', text: 'Someone New' })
    expect(hint('Someone New')).toBe(`No one in Dev Studio matches. ${ASK_EMAIL_PROMPT}`)
  })

  it('a partial target plans a pick, never a grant or a link', () => {
    expect(invitePlan(parseInviteTarget('@bo', ws, board))).toMatchObject({
      kind: 'pick',
      matches: [{ user: { handle: 'bob' } }],
    })
  })

  it('picking puts the @handle in the field, else the name', () => {
    expect(pickedText(ws[0] as WorkspaceMember)).toBe('@bob')
    expect(pickedText(carolS)).toBe('Carol Smith')
  })

  it('memberMatches and inviteMatches: empty text matches no one; the list is capped', () => {
    expect(memberMatches('', ws[0] as WorkspaceMember)).toBe(false)
    expect(memberMatches('@', ws[0] as WorkspaceMember)).toBe(false)
    const many = Array.from({ length: 12 }, (_, i) => wsMember(`ann${i}`, 'member'))
    expect(inviteMatches('ann', many, [])).toHaveLength(MAX_INVITE_SUGGESTIONS)
  })

  it('the one hint line for the other cases', () => {
    const opts = { workspaceName: 'Dev Studio', canEmail: false, ownAddress: false, notice: null }
    expect(inviteHintText({ kind: 'empty' }, opts)).toBe(INVITE_IDLE_HINT)
    expect(hint('@bob')).toBe('Bob is in Dev Studio: they get access right away.')
    expect(hint('@carol')).toBe('Carol already has access. Change their role under People with access.')
    expect(hint('pat@client.example')).toContain('only this address can use')
    // the inviter's own address: the hint, or nothing once the alert says it
    const own = { kind: 'email', email: 'alice@dev.invalid' } as const
    expect(inviteHintText(own, { ...opts, ownAddress: true })).toBe(OWN_ADDRESS_MESSAGE)
    expect(inviteHintText(own, { ...opts, ownAddress: true, notice: OWN_ADDRESS_MESSAGE })).toBe('')
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

  it('the people list says once, in words, why Owner is off for people outside (a creator managing)', () => {
    expect(OWNER_NEEDS_CREATOR_NOTE).toBe(
      'Only people at Dark Burn Creative or Trailer Park Group can own boards, so Owner is turned off for everyone else here.',
    )
    const row = (r: Partial<OwnerNoteRow>): OwnerNoteRow => ({
      editable: true,
      guest: false,
      canOwn: true,
      current: 'viewer',
      ...r,
    })
    // A creator's list with client reviewers (editor, commenter, viewer): one note for all of them, and
    // each of their rows points to it.
    const rows = [
      row({ current: 'owner', editable: false }),
      row({ canOwn: false, current: 'editor' }),
      row({ canOwn: false, current: 'commenter' }),
      row({ canOwn: false, current: 'viewer' }),
      row({ canOwn: true }),
    ]
    expect(listShowsOwnerNote(rows, true)).toBe(true)
    expect(rows.map((r) => rowNeedsOwnerNote(r, true))).toEqual([false, true, true, true, false])
    // No such row (creators only, an outsider who already owns it, a row the caller cannot edit, a
    // name-only guest), or a manager who may only reduce access: no note.
    expect(listShowsOwnerNote([row({}), row({ canOwn: false, current: 'owner' })], true)).toBe(false)
    expect(listShowsOwnerNote([row({ canOwn: false, editable: false })], true)).toBe(false)
    expect(listShowsOwnerNote([row({ canOwn: false, guest: true })], true)).toBe(false)
    expect(listShowsOwnerNote(rows, false)).toBe(false)
    expect(listShowsOwnerNote([], true)).toBe(false)
  })

  it('whether someone’s Owner option is off because they cannot own boards', () => {
    expect(showOwnerNote({ canShare: true, canOwn: false, current: 'editor' })).toBe(true)
    // Already an owner (decision 4), a creator, an older api (undefined) or a reduce-only manager: no note.
    expect(showOwnerNote({ canShare: true, canOwn: false, current: 'owner' })).toBe(false)
    expect(showOwnerNote({ canShare: true, canOwn: true, current: 'editor' })).toBe(false)
    expect(showOwnerNote({ canShare: true, current: 'editor' })).toBe(false)
    expect(showOwnerNote({ canShare: false, canOwn: false, current: 'editor' })).toBe(false)
  })
})

describe('fixer round 3 (docs/DOMAIN-ACCESS-CONTRACTS.md §21): the inviter’s own address', () => {
  const ws = [wsMember('bob', 'member')]
  const plan = (text: string, own: string | null) => invitePlan(parseInviteTarget(text, ws, []), own)

  it('is refused before anything is sent, with the api’s words (in any case, with spaces)', () => {
    expect(OWN_ADDRESS_MESSAGE).toBe(DOMAIN_ACCESS_MESSAGES.invitationToSelf)
    expect(OWN_ADDRESS_MESSAGE).toMatch(/^That’s your own address\./)
    expect(plan('alice@dev.invalid', 'alice@dev.invalid')).toEqual({
      kind: 'own-address',
      message: OWN_ADDRESS_MESSAGE,
    })
    expect(plan('  Alice@Dev.Invalid ', 'alice@dev.invalid')).toMatchObject({ kind: 'own-address' })
    expect(isOwnAddress(' ALICE@dev.invalid', 'alice@dev.invalid')).toBe(true)
  })

  it('anyone else’s address, or no known own address, makes the locked link as before', () => {
    expect(plan('pat@client.example.test', 'alice@dev.invalid')).toEqual({
      kind: 'locked-link',
      email: 'pat@client.example.test',
    })
    expect(plan('alice@dev.invalid', null)).toMatchObject({ kind: 'locked-link' })
    expect(isOwnAddress('alice@dev.invalid', null)).toBe(false)
    expect(isOwnAddress('not an address', 'alice@dev.invalid')).toBe(false)
    // A look-alike is not her address (and is refused as invalid anyway).
    expect(isOwnAddress('alice@dev.invKlid', 'alice@dev.invalid')).toBe(false)
  })
})
