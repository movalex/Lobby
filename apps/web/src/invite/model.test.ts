import { describe, expect, it } from 'vitest'
import { BOARD_ID, WS_ID } from '../api/test-fixtures.ts'
import {
  fetchGoneDetails,
  goneCopy,
  invitationSummary,
  rememberAcceptIntent,
  signInHeading,
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
    expect(signInHeading(null)).toBe('Sign in')
    expect(signInHeading({ ...base, board: { id: BOARD_ID, title: 'Rough cut' }, role: 'commenter' })).toBe(
      'Sign in to join “Rough cut” (invited by Alice)',
    )
    expect(signInHeading({ ...base, board: null, role: 'member' })).toBe(
      'Sign in to join Dev Studio (invited by Alice)',
    )
  })
})
