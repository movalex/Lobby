import { describe, expect, it } from 'vitest'
import { makeUser, member, wsMember } from '../api/test-fixtures.ts'
import {
  type AccessDetail,
  accessSource,
  grantEditable,
  inviteRoleOptions,
  memberRoleEditable,
  parseInviteTarget,
  removalNote,
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
