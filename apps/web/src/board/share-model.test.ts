import { describe, expect, it } from 'vitest'
import { makeUser, member, wsMember } from '../api/test-fixtures.ts'
import {
  inviteRoleOptions,
  memberRoleEditable,
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
