import { guestDisplayName, guestLabelName, guestNameProblem } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { BOARD_ID, WS_ID } from '../api/test-fixtures.ts'
import {
  acceptErrorCopy,
  emailMismatchCopy,
  fetchGoneDetails,
  GUEST_ENDED_COPY,
  goneCopy,
  guestJoinError,
  guestJoinHint,
  invitationSummary,
  isEmailMismatch,
  lockedHint,
  lockedSignInLabel,
  ownInvitationWayBack,
  ownName,
  ownNameParts,
  rememberAcceptIntent,
  shouldAutoAccept,
  signInHeading,
  splitGuestMarker,
  takeAcceptIntent,
} from './model.ts'

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
      roleHeading: 'Your role',
      roleLabel: 'Can comment',
      acceptLabel: 'Accept and open board',
    })
  })

  it('the inviter’s own locked link is about their invitation, and leads back, never to a sign-out', () => {
    const board = { ...base, board: { id: BOARD_ID, title: 'Q3 planning' }, role: 'viewer' }
    expect(invitationSummary(board, { sentByYou: true })).toEqual({
      eyebrow: 'Your invitation to a board',
      title: '“Q3 planning”',
      roleHeading: 'Their role',
      roleLabel: 'Can view',
      acceptLabel: 'Accept and open board',
    })
    const workspace = { ...base, board: null, role: 'member' }
    expect(invitationSummary(workspace, { sentByYou: true })).toMatchObject({
      eyebrow: 'Your invitation to a workspace',
      title: 'Dev Studio',
      roleHeading: 'Their role',
    })
    // Not the inviter's (or an older api without sentByYou): as before.
    expect(invitationSummary(board, { sentByYou: false }).eyebrow).toBe('Alice invited you to a board')
    expect(ownInvitationWayBack(board)).toEqual({ label: 'Back to the board', href: `/b/${BOARD_ID}` })
    expect(ownInvitationWayBack(workspace)).toEqual({ label: 'Go to the workspace', href: `/w/${WS_ID}` })
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

describe('links that no longer work (PRI-04)', () => {
  const res = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('reads the 410 details: who sent it, and the board only for someone who can open it', async () => {
    const body = {
      error: { code: 'GONE', message: 'x' },
      gone: { invitedBy: { name: 'alice' }, boardId: BOARD_ID },
    }
    expect(await fetchGoneDetails('tok', res(410, body))).toEqual({
      invitedBy: { name: 'alice' },
      boardId: BOARD_ID,
    })
    expect(await fetchGoneDetails('tok', res(410, { error: { code: 'GONE', message: 'x' } }))).toEqual({
      invitedBy: null,
      boardId: null,
    })
    expect(await fetchGoneDetails('tok', res(200, {}))).toBeNull()
  })

  it('the dead end says whom to ask', () => {
    expect(goneCopy({ invitedBy: { name: 'Priya' }, boardId: null }).body).toMatch(
      /Ask Priya for a new link\.$/,
    )
    expect(goneCopy(null).body).toMatch(/Ask the person who invited you for a new link\.$/)
    expect(goneCopy(null).title).toBe('This invitation is no longer valid')
  })
})

describe('sign in, then accept (PRI-16)', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    }
  }
  it('accepts by itself only after "Sign in to accept" for that very link, once', () => {
    const s = memory()
    expect(takeAcceptIntent(s, 'tok')).toBe(false) // a crafted link alone never accepts
    rememberAcceptIntent(s, 'tok')
    expect(takeAcceptIntent(s, 'other')).toBe(false)
    expect(takeAcceptIntent(s, 'tok')).toBe(true)
    expect(takeAcceptIntent(s, 'tok')).toBe(false)
    rememberAcceptIntent(s, 'tok')
    expect(takeAcceptIntent(s, 'tok', Date.now() + 31 * 60_000)).toBe(false) // stale
  })

  it('the sign-in heading names the board (or workspace) and who invited', () => {
    expect(signInHeading(null)).toBe('Sign in to Lobby')
    expect(signInHeading({ ...base, board: { id: BOARD_ID, title: 'Rough cut' }, role: 'commenter' })).toBe(
      'Sign in to join “Rough cut” (invited by Alice)',
    )
    expect(signInHeading({ ...base, board: null, role: 'member' })).toBe(
      'Sign in to join Dev Studio (invited by Alice)',
    )
  })
})

describe('joining as a guest (wave 3)', () => {
  it('checks the name the way the API does: 1-40 characters after trimming, no control characters', () => {
    expect(guestNameProblem('  Sam  ')).toBeNull()
    expect(guestNameProblem('')).toBe('Enter your name.')
    expect(guestNameProblem('   ')).toBe('Enter your name.')
    expect(guestNameProblem('x'.repeat(40))).toBeNull()
    expect(guestNameProblem('x'.repeat(41))).toBe('Use at most 40 characters.')
    // Characters are code points: an emoji counts once.
    expect(guestNameProblem(`${'a'.repeat(39)}${String.fromCodePoint(0x1f3a8)}`)).toBeNull()
    for (const cp of [0x0a, 0x1b, 0x7f, 0x85, 0x202e, 0x2066, 0x2028])
      expect(guestNameProblem(`Sam${String.fromCodePoint(cp)}x`), cp.toString(16)).toBe(
        'Use letters, numbers, spaces and punctuation only.',
      )
    expect(guestDisplayName(' Sam ')).toBe('Sam (guest)')
  })

  it('keeps the marker in short labels: cursor names are shortened in front of "(guest)"', () => {
    expect(guestLabelName('Sam')).toBe('Sam (guest)')
    expect(guestLabelName('Sam Rivera')).toBe('Sam Rivera (guest)')
    expect(guestLabelName('Chase Boyajian')).toBe('Chase B… (guest)')
    // Wide letters, other scripts, emoji and invisible wide fillers all count as wide.
    expect(guestLabelName('MMMMMMMMMM')).toBe('MMMMM… (guest)')
    expect(guestLabelName('山田太郎')).toBe('山田太郎 (guest)')
    expect(guestLabelName('山田太郎山田')).toBe('山田太郎… (guest)')
    expect(guestLabelName(`${String.fromCodePoint(0x1f3a8)}`.repeat(5))).toBe(
      `${String.fromCodePoint(0x1f3a8).repeat(3)}… (guest)`,
    )
    expect(guestLabelName(`Chase${String.fromCodePoint(0x3164).repeat(10)}x`)).toBe(
      `Chase${String.fromCodePoint(0x3164)}… (guest)`,
    )
    // Zero-width characters take no room.
    expect(guestLabelName(`Sam${String.fromCodePoint(0x200b).repeat(30)}`)).toBe(
      `Sam${String.fromCodePoint(0x200b).repeat(30)} (guest)`,
    )
  })

  it('splits the marker off a name so a list can cut the name instead', () => {
    expect(splitGuestMarker('Sam Rivera (guest)')).toEqual(['Sam Rivera', ' (guest)'])
    expect(splitGuestMarker('Bob Chen')).toEqual(['Bob Chen', null])
    expect(splitGuestMarker(' (guest)')).toEqual([' (guest)', null])
  })

  it('says what others will see and explains refusals', () => {
    expect(guestJoinHint('Sam')).toContain('“Sam (guest)”')
    expect(guestJoinHint('  ')).toContain('your name followed by “(guest)”')
    expect(guestJoinError('GUEST_LIMIT', 'x')).toContain('as many guests as it can')
    expect(guestJoinError('GUESTS_NOT_ALLOWED', 'x')).toBe(
      'This link needs an account. Sign in to accept it.',
    )
    expect(guestJoinError('RATE_LIMITED', 'Wait a few minutes')).toBe('Wait a few minutes')
  })
})

describe("someone's own name (F14)", () => {
  it('a guest reads "(guest, you)", never "(guest) (you)"; an account "(you)"', () => {
    expect(ownName('Dana Whitfield (guest)')).toBe('Dana Whitfield (guest, you)')
    expect(ownName('Alice Park')).toBe('Alice Park (you)')
    expect(ownNameParts('Kai (guest)')).toEqual(['Kai', ' (guest, you)'])
    expect(ownNameParts('Alice')).toEqual(['Alice', ' (you)'])
  })
})

describe('when guest access ends (DANA2-07)', () => {
  it('one message: what happened and what to do, with no way on that needs an account', () => {
    expect(GUEST_ENDED_COPY.title).toBe('Your guest access has ended')
    expect(GUEST_ENDED_COPY.what).toMatch(/revoked or has expired/)
    expect(GUEST_ENDED_COPY.next).toMatch(/ask whoever shared the link/)
    expect(Object.values(GUEST_ENDED_COPY).join(' ')).not.toMatch(/your boards|request access/i)
  })
})

describe('invitations locked to an email address (domain access, docs/DOMAIN-ACCESS-CONTRACTS.md §9)', () => {
  const board = { ...base, board: { id: BOARD_ID, title: 'Rough cut' }, role: 'commenter' }
  const locked = { emailLocked: true, invitedEmailHint: 'p•••@client.example.test', matchesYou: null }

  it('signed out: the facts, the action and the sign-in heading repeat the masked address', () => {
    expect(lockedHint(locked)).toBe('p•••@client.example.test')
    expect(lockedSignInLabel('p•••@client.example.test')).toBe(
      'Sign in or create an account with p•••@client.example.test',
    )
    expect(signInHeading({ ...board, ...locked })).toBe(
      'Sign in with p•••@client.example.test to join “Rough cut” (invited by Alice)',
    )
    expect(signInHeading({ ...base, board: null, role: 'member', ...locked })).toBe(
      'Sign in with p•••@client.example.test to join Dev Studio (invited by Alice)',
    )
    // Not locked (guest and review links, an older api): as before.
    expect(lockedHint({ emailLocked: false, invitedEmailHint: null, matchesYou: null })).toBeNull()
    expect(lockedHint(undefined)).toBeNull()
    expect(signInHeading({ ...board, emailLocked: false, invitedEmailHint: null, matchesYou: null })).toBe(
      'Sign in to join “Rough cut” (invited by Alice)',
    )
    // A locked flag without a hint (no longer usable) never prints "null".
    expect(signInHeading({ ...board, emailLocked: true, invitedEmailHint: null })).toBe(
      'Sign in to join “Rough cut” (invited by Alice)',
    )
  })

  it('the right account accepts as today (auto-accept after sign-in included)', () => {
    expect(isEmailMismatch({ ...locked, matchesYou: true }, false)).toBe(false)
    expect(shouldAutoAccept({ ...locked, matchesYou: true })).toBe(true)
    expect(shouldAutoAccept({ ...locked, matchesYou: null })).toBe(true)
    expect(shouldAutoAccept({ emailLocked: false, invitedEmailHint: null, matchesYou: null })).toBe(true)
  })

  it('the wrong account: the mismatch state, and never an auto-accept', () => {
    expect(isEmailMismatch({ ...locked, matchesYou: false }, false)).toBe(true)
    expect(shouldAutoAccept({ ...locked, matchesYou: false })).toBe(false)
    // A 403 INVITATION_EMAIL_MISMATCH at accept (fresher data than the preview) shows it too.
    expect(isEmailMismatch({ ...locked, matchesYou: true }, true)).toBe(true)
    // An unlocked invitation is never a mismatch, whatever matchesYou says.
    expect(isEmailMismatch({ emailLocked: false, invitedEmailHint: null, matchesYou: false }, false)).toBe(
      false,
    )
  })

  it('the mismatch copy names both addresses, and falls back without an address or an inviter', () => {
    expect(
      emailMismatchCopy({
        hint: 'p•••@client.example.test',
        email: 'sam@client.example.test',
        invitedBy: 'Alice',
      }).body,
    ).toBe(
      "This invitation was sent to p•••@client.example.test. You're signed in as sam@client.example.test. Sign in with the invited address, or ask Alice to invite sam@client.example.test.",
    )
    expect(
      emailMismatchCopy({ hint: 'p•••@client.example.test', email: null, invitedBy: 'Alice' }).body,
    ).toBe(
      "This invitation was sent to p•••@client.example.test. You're signed in with a different account. Sign in with the invited address, or ask Alice for a new invitation.",
    )
    expect(
      emailMismatchCopy({
        hint: 'p•••@client.example.test',
        email: 'sam@client.example.test',
        invitedBy: '  ',
      }).body,
    ).toContain('ask the person who invited you to invite sam@client.example.test')
    expect(
      emailMismatchCopy({ hint: 'p•••@client.example.test', email: null, invitedBy: null }).body,
    ).toContain('ask the person who invited you for a new invitation')
    // The full invited address is never known here, so it can never be shown.
    expect(emailMismatchCopy({ hint: null, email: null, invitedBy: null }).body).not.toMatch(/null/)
  })

  it('the inviter opening their own locked link is told whom it is for, never to ask themselves', () => {
    const own = emailMismatchCopy({
      hint: 'p•••@client.example.test',
      email: 'alice@dev.invalid',
      invitedBy: 'Alice Park',
      sentByYou: true,
    })
    expect(own).toEqual({
      title: 'This is the invitation you sent',
      body: "Only p•••@client.example.test can use this link. It won't let you in as alice@dev.invalid. Send it to them: they sign in with that address to join.",
    })
    expect(own.body).not.toContain('ask Alice Park')
    expect(
      emailMismatchCopy({ hint: 'p•••@client.example.test', email: null, invitedBy: 'A', sentByYou: true })
        .body,
    ).toBe(
      'Only p•••@client.example.test can use this link. Send it to them: they sign in with that address to join.',
    )
    // sentByYou false (or an older api without it): the copy for the wrong account, as before.
    expect(
      emailMismatchCopy({
        hint: 'p•••@client.example.test',
        email: 'a@x.test',
        invitedBy: 'A',
        sentByYou: false,
      }).title,
    ).toBe('This invitation is for someone else')
  })

  it('accepting while the sign-in service is down: a retry; 409 and the rest: the server’s words', () => {
    expect(acceptErrorCopy('IDENTITY_UNAVAILABLE', 'x')).toEqual({
      message: 'Couldn’t confirm your email right now. Try again in a minute.',
      retry: true,
    })
    expect(acceptErrorCopy('ROLE_REQUIRES_CREATOR', 'Only people at Dark Burn Creative …')).toEqual({
      message: 'Only people at Dark Burn Creative …',
      retry: false,
    })
    expect(acceptErrorCopy('GUEST_LIMIT', 'x').message).toContain('as many guests as it can')
  })
})
