import { describe, expect, it } from 'vitest'
import {
  canExtend,
  createdSaying,
  hoursLabel,
  pickDefaultRole,
  readSentRequest,
  requestableRoles,
  shareBadge,
  shareBadgeName,
  shortDate,
  shortTime,
  showsShareBadge,
  timeOfDay,
  writeSentRequest,
} from './model.ts'

const now = new Date('2026-09-27T12:00:00')

describe('board header sharing badge (PRS-03)', () => {
  const base = { directCount: 1, pendingRequests: null }

  it('says Private / Workspace: view / Workspace: edit', () => {
    expect(shareBadge({ ...base, visibility: 'private', links: [] }, 'Dev Studio', now)).toMatchObject({
      kind: 'private',
      label: 'Private',
    })
    const view = shareBadge({ ...base, visibility: 'workspace_view', links: [] }, 'Dev Studio', now)
    expect(view).toMatchObject({ kind: 'workspace', label: 'Workspace: view' })
    expect(view.description).toContain('Everyone in Dev Studio can view')
    expect(shareBadge({ ...base, visibility: 'workspace_edit', links: [] }, 'Dev Studio', now).label).toBe(
      'Workspace: edit',
    )
  })

  it('leads with an open review link: its role and when it expires', () => {
    const b = shareBadge(
      {
        ...base,
        visibility: 'workspace_view',
        links: [
          { role: 'viewer', expiresAt: '2026-12-01T10:00:00' },
          { role: 'commenter', expiresAt: '2026-10-05T10:00:00' },
          { role: 'commenter', expiresAt: '2026-10-10T10:00:00' },
        ],
      },
      'Dev Studio',
      now,
    )
    expect(b.kind).toBe('link')
    expect(b.label).toBe('Link: comment · until Oct 10')
    expect(b.description).toContain('(3 links)')
    expect(b.description).toContain('Everyone in Dev Studio can view')
  })

  it('A11Y2-10: the accessible name starts with the visible text (voice control), then explains', () => {
    for (const state of [
      { ...base, visibility: 'private' as const, links: [] },
      { ...base, visibility: 'workspace_edit' as const, links: [], pendingRequests: 1 },
      {
        ...base,
        visibility: 'private' as const,
        links: [{ role: 'editor' as const, expiresAt: '2026-10-01T08:42:00' }],
      },
      {
        ...base,
        visibility: 'workspace_view' as const,
        links: [{ role: 'commenter' as const, expiresAt: '2026-10-10T10:00:00' }],
      },
    ]) {
      const b = shareBadge(state, 'Dev Studio', now)
      const name = shareBadgeName(b)
      expect(name.startsWith(`${b.label}. `)).toBe(true)
      expect(name).toContain(b.description)
      expect(name.endsWith('Open sharing settings.')).toBe(true)
    }
    const withRequests = shareBadge(
      { ...base, visibility: 'private', links: [], pendingRequests: 2 },
      'W',
      now,
    )
    expect(shareBadgeName(withRequests)).toContain('2 pending access requests.')
  })

  it('A11Y-01: says what Create did', () => {
    expect(createdSaying('Client link', true)).toBe('Client link created and copied to the clipboard.')
    expect(createdSaying('Workshop link', false)).toBe('Workshop link created. Copy it from the list below.')
  })

  it('carries the pending request count for owners only', () => {
    expect(
      shareBadge({ ...base, visibility: 'private', links: [], pendingRequests: 2 }, 'W', now).requests,
    ).toBe(2)
    expect(shareBadge({ ...base, visibility: 'private', links: [] }, 'W', now).requests).toBe(0)
  })

  it('formats dates short, with the year only when it differs', () => {
    expect(shortDate('2026-10-10T10:00:00', now)).toBe('Oct 10')
    expect(shortDate('2027-01-02T10:00:00', now)).toBe('Jan 2, 2027')
    expect(shortDate('not a date', now)).toBe('')
  })
})

describe('request access', () => {
  it('offers only roles above what the person has (never ownership)', () => {
    expect(requestableRoles(null)).toEqual(['editor', 'commenter', 'viewer'])
    expect(requestableRoles('viewer')).toEqual(['editor', 'commenter'])
    expect(requestableRoles('commenter')).toEqual(['editor'])
    expect(requestableRoles('editor')).toEqual([])
    expect(requestableRoles('owner')).toEqual([])
  })

  it('remembers a sent request per user and board for a week; junk is ignored', () => {
    const m = new Map<string, string>()
    const store = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    }
    const t = Date.parse('2026-09-27T12:00:00Z')
    writeSentRequest(store, 'usr_a', 'b-1', { role: 'editor', at: t })
    expect(readSentRequest(store, 'usr_a', 'b-1', t + 1000)).toEqual({ role: 'editor', at: t })
    expect(readSentRequest(store, 'usr_b', 'b-1', t)).toBeNull()
    expect(readSentRequest(store, 'usr_a', 'b-1', t + 8 * 24 * 3600 * 1000)).toBeNull()
    m.set('draftroom:access-request:usr_a:b-2', '{"role":"owner","at":1}')
    expect(readSentRequest(store, 'usr_a', 'b-2', t)).toBeNull()
    m.set('draftroom:access-request:usr_a:b-3', 'not json')
    expect(readSentRequest(store, 'usr_a', 'b-3', t)).toBeNull()
    expect(readSentRequest(null, 'usr_a', 'b-1', t)).toBeNull()
  })
})

describe('workshop links in the badge (RETRO-04a)', () => {
  const base = { directCount: 1, pendingRequests: null, visibility: 'private' as const }
  it('an open edit link leads, with the time it ends', () => {
    const b = shareBadge(
      {
        ...base,
        links: [
          { role: 'commenter', expiresAt: '2026-10-05T10:00:00' },
          { role: 'editor', expiresAt: '2026-09-27T15:40:00' },
        ],
      },
      'Dev Studio',
      now,
    )
    expect(b.kind).toBe('link')
    expect(b.label).toMatch(/^Link: edit · until 3:40\sPM$/)
    expect(b.description).toMatch(
      /^Anyone with the workshop link can edit after signing in, until 3:40\sPM \(2 links\)\./,
    )
  })

  it('a review link still says who can comment after signing in', () => {
    const b = shareBadge(
      { ...base, links: [{ role: 'commenter', expiresAt: '2026-10-04T10:00:00' }] },
      'W',
      now,
    )
    expect(b.description).toMatch(/^Anyone with a review link can comment after signing in, until Oct 4\./)
  })

  it('+1 h is offered only while the link can still grow', () => {
    expect(canExtend({ expiresAt: '2026-09-27T15:00:00Z', maxExpiresAt: '2026-09-28T09:00:00Z' })).toBe(true)
    expect(canExtend({ expiresAt: '2026-09-28T09:00:00Z', maxExpiresAt: '2026-09-28T09:00:00Z' })).toBe(false)
    expect(canExtend({ expiresAt: '2026-09-28T09:00:00Z', maxExpiresAt: null })).toBe(false)
    expect(hoursLabel(1)).toBe('1 hour')
    expect(hoursLabel(3)).toBe('3 hours')
    expect(shortTime('2026-09-28T09:05:00', now)).toMatch(/^Sep 28, 9:05\sAM$/)
  })
})

describe('request form default (PRI-16)', () => {
  it('starts from the previous role, else Comment for outsiders and Edit for viewers/commenters', () => {
    const all = requestableRoles(null)
    expect(pickDefaultRole(all, null, 'viewer')).toBe('viewer')
    expect(pickDefaultRole(all, null, 'editor')).toBe('editor')
    expect(pickDefaultRole(all, null, 'owner')).toBe('editor')
    expect(pickDefaultRole(all, null, null)).toBe('commenter')
    expect(pickDefaultRole(requestableRoles('viewer'), 'viewer')).toBe('editor')
    expect(pickDefaultRole(requestableRoles('commenter'), 'commenter')).toBe('editor')
  })
})

describe('who gets the header sharing badge (R2-11, F14)', () => {
  it('owners and editors; never a viewer, a commenter or a name-only guest (whose "Link: edit" is not theirs)', () => {
    expect(showsShareBadge('owner', false)).toBe(true)
    expect(showsShareBadge('editor', false)).toBe(true)
    expect(showsShareBadge('commenter', false)).toBe(false)
    expect(showsShareBadge('viewer', false)).toBe(false)
    expect(showsShareBadge('editor', true)).toBe(false) // a workshop guest
    expect(showsShareBadge('commenter', true)).toBe(false) // a client
  })
})

describe('one time format (R2-08)', () => {
  it("follows the locale's hour cycle, and the badge's time is that time", () => {
    const d = new Date(2026, 8, 28, 8, 39)
    expect(timeOfDay(d, 'en-US')).toBe('8:39 AM')
    expect(timeOfDay(d, 'en-GB')).toBe('08:39')
    expect(shortTime(d.toISOString(), new Date(2026, 8, 28, 6, 0))).toBe(timeOfDay(d))
  })
})
