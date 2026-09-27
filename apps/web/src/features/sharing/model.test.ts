import { describe, expect, it } from 'vitest'
import { readSentRequest, requestableRoles, shareBadge, shortDate, writeSentRequest } from './model.ts'

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
