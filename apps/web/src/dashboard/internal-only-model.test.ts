// Wave J: the dashboard's "Internal only" words and menus (internal-only-model.ts).
import type { InternalOnlySettings } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  outsideAccessIn,
  outsideAccessSummary,
  projectInternalOnly,
  projectMenuItems,
} from './internal-only-model.ts'
import { KIND_TEXT } from './notifications.ts'

const user = (id: string) => ({ id, name: id, handle: null, color: '#123456', avatarUrl: null })

const settings = (over: Partial<InternalOnlySettings> = {}): InternalOnlySettings => ({
  workspace: false,
  projects: [
    { projectId: 'prj_a', internalOnly: true },
    { projectId: 'prj_b', internalOnly: false },
  ],
  canChange: true,
  canTurnOff: true,
  outsideAccess: {
    people: [
      {
        user: user('usr_guest'),
        outside: true,
        emailDomain: 'client.example',
        emailHint: 'g•••@client.example',
        workspaceRole: 'guest',
        boards: [
          { id: 'b-in-a', title: 'In A', projectId: 'prj_a', role: 'viewer' },
          { id: 'b-in-b', title: 'In B', projectId: 'prj_b', role: 'editor' },
        ],
      },
      {
        user: user('usr_member'),
        outside: true,
        emailDomain: 'vendor.example',
        emailHint: null,
        workspaceRole: 'member',
        boards: [],
      },
    ],
    links: [
      {
        id: 'inv_1',
        boardId: 'b-in-b',
        boardTitle: 'In B',
        projectId: 'prj_b',
        role: 'commenter',
        expiresAt: '2026-10-10T00:00:00.000Z',
        allowGuests: true,
      },
    ],
    invitations: [
      {
        id: 'inv_ws',
        boardId: null,
        boardTitle: null,
        projectId: null,
        role: 'member',
        expiresAt: '2026-10-10T00:00:00.000Z',
        emailDomain: 'client.example',
        emailHint: 'x•••@client.example',
      },
      {
        id: 'inv_a',
        boardId: 'b-in-a',
        boardTitle: 'In A',
        projectId: 'prj_a',
        role: 'viewer',
        expiresAt: '2026-10-10T00:00:00.000Z',
        emailDomain: 'client.example',
        emailHint: 'y•••@client.example',
      },
    ],
  },
  ...over,
})

describe('outside access in a scope', () => {
  it('the workspace: everything; a project: its boards’ grants and links, and outside members', () => {
    const s = settings()
    expect(outsideAccessIn(s, { kind: 'workspace' }).people).toHaveLength(2)
    const a = outsideAccessIn(s, { kind: 'project', projectId: 'prj_a' })
    expect(a.people.map((p) => [p.user.id, p.boards.map((b) => b.id)])).toEqual([
      ['usr_guest', ['b-in-a']],
      ['usr_member', []],
    ])
    expect(a.links).toEqual([])
    expect(outsideAccessIn(s, { kind: 'project', projectId: 'prj_b' }).links.map((l) => l.id)).toEqual([
      'inv_1',
    ])
    // Pending outside invitations: a board's belongs to its project, a workspace invitation to the
    // workspace only.
    expect(a.invitations.map((i) => i.id)).toEqual(['inv_a'])
    expect(outsideAccessIn(s, { kind: 'project', projectId: 'prj_b' }).invitations).toEqual([])
    expect(outsideAccessIn(s, { kind: 'workspace' }).invitations.map((i) => i.id)).toEqual([
      'inv_ws',
      'inv_a',
    ])
  })

  it('summarises it, and says nothing when nothing reaches the scope', () => {
    expect(outsideAccessSummary(outsideAccessIn(settings(), { kind: 'workspace' }))).toBe(
      '2 outside people, 1 link and 2 invitations still have access. Review',
    )
    expect(outsideAccessSummary({ people: [], links: [], invitations: [] })).toBeNull()
    const one = settings().outsideAccess?.links ?? []
    expect(outsideAccessSummary({ people: [], links: one, invitations: [] })).toBe(
      '1 link still has access. Review',
    )
    const people = settings().outsideAccess?.people ?? []
    expect(outsideAccessSummary({ people, links: one, invitations: [] })).toBe(
      '2 outside people and 1 link still have access. Review',
    )
    const invitations = settings().outsideAccess?.invitations.slice(0, 1) ?? []
    expect(outsideAccessSummary({ people: [], links: [], invitations })).toBe(
      '1 invitation still has access. Review',
    )
  })
})

describe('the project menu', () => {
  it('rename for creators; the switch for owners and admins; off only for creators', () => {
    expect(
      projectMenuItems({ canRename: true, settings: settings(), projectId: 'prj_b' }).map((i) => i.action),
    ).toEqual(['rename', 'internal-on'])
    expect(
      projectMenuItems({ canRename: false, settings: settings(), projectId: 'prj_a' }).map((i) => i.action),
    ).toEqual(['internal-off', 'internal-review'])
    expect(
      projectMenuItems({
        canRename: false,
        settings: settings({ canTurnOff: false }),
        projectId: 'prj_a',
      }).map((i) => i.action),
    ).toEqual(['internal-review'])
    expect(
      projectMenuItems({ canRename: true, settings: settings({ canChange: false }), projectId: 'prj_a' }).map(
        (i) => i.action,
      ),
    ).toEqual(['rename'])
    expect(projectInternalOnly(settings(), 'prj_a')).toBe(true)
    expect(projectInternalOnly(null, 'prj_a')).toBe(false)
  })

  it('the dashboard bell has words for the outsider notice', () => {
    expect(KIND_TEXT.outsider_joined).toBe('opened your board for the first time')
  })
})
