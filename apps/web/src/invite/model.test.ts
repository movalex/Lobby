import { guestDisplayName, guestLabelName, guestNameProblem } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { BOARD_ID, WS_ID } from '../api/test-fixtures.ts'
import {
  fetchGoneDetails,
  goneCopy,
  guestJoinError,
  guestJoinHint,
  invitationSummary,
  rememberAcceptIntent,
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
    expect(signInHeading(null)).toBe('Sign in to your DBC lobby')
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
