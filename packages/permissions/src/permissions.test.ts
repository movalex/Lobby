import { describe, expect, it } from 'vitest'
import {
  BOARD_ACTIONS,
  BOARD_ROLES,
  BOARD_VISIBILITIES,
  type BoardRole,
  can,
  canEditCanvas,
  resolveBoardRole,
  WORKSPACE_ROLES,
} from './index.ts'

describe('resolveBoardRole', () => {
  it('never grants anything outside the workspace, even with a stale board grant', () => {
    for (const grant of [...BOARD_ROLES, null])
      for (const visibility of BOARD_VISIBILITIES)
        expect(resolveBoardRole({ workspaceRole: null, boardGrant: grant, visibility })).toBeNull()
  })

  it('workspace owners and admins own every board', () => {
    for (const workspaceRole of ['owner', 'admin'] as const)
      for (const visibility of BOARD_VISIBILITIES)
        expect(resolveBoardRole({ workspaceRole, boardGrant: null, visibility })).toBe('owner')
  })

  it('private boards are invisible to members without a grant', () => {
    expect(resolveBoardRole({ workspaceRole: 'member', boardGrant: null, visibility: 'private' })).toBeNull()
  })

  it('workspace visibility gives members view or edit; an explicit grant can only raise it', () => {
    expect(
      resolveBoardRole({ workspaceRole: 'member', boardGrant: null, visibility: 'workspace_view' }),
    ).toBe('viewer')
    expect(
      resolveBoardRole({ workspaceRole: 'member', boardGrant: null, visibility: 'workspace_edit' }),
    ).toBe('editor')
    expect(
      resolveBoardRole({ workspaceRole: 'member', boardGrant: 'viewer', visibility: 'workspace_edit' }),
    ).toBe('editor')
    expect(
      resolveBoardRole({ workspaceRole: 'member', boardGrant: 'owner', visibility: 'workspace_view' }),
    ).toBe('owner')
  })

  it('guests only ever get their explicit grant, regardless of workspace visibility', () => {
    for (const visibility of BOARD_VISIBILITIES) {
      expect(resolveBoardRole({ workspaceRole: 'guest', boardGrant: null, visibility })).toBeNull()
      expect(resolveBoardRole({ workspaceRole: 'guest', boardGrant: 'commenter', visibility })).toBe(
        'commenter',
      )
    }
  })
})

describe('can', () => {
  const matrix: Record<BoardRole, string[]> = {
    owner: ['view', 'comment', 'edit', 'rename', 'manage_access', 'archive', 'trash', 'change_visibility'],
    editor: ['view', 'comment', 'edit', 'rename'],
    commenter: ['view', 'comment'],
    viewer: ['view'],
  }

  it('matches the active-board capability matrix exactly', () => {
    for (const role of BOARD_ROLES)
      for (const action of BOARD_ACTIONS)
        expect(can(role, action), `${role} ${action}`).toBe(matrix[role].includes(action))
  })

  it('no role means no access', () => {
    for (const action of BOARD_ACTIONS) expect(can(null, action)).toBe(false)
  })

  it('archived boards are read-only; owners may restore, trash or manage access', () => {
    for (const role of BOARD_ROLES) {
      expect(can(role, 'view', 'archived')).toBe(true)
      expect(can(role, 'edit', 'archived')).toBe(false)
      expect(can(role, 'comment', 'archived')).toBe(false)
      expect(can(role, 'restore', 'archived')).toBe(role === 'owner')
    }
  })

  it('trashed boards cannot be opened by anyone; only owners can restore', () => {
    for (const role of BOARD_ROLES) {
      expect(can(role, 'view', 'trashed')).toBe(false)
      expect(canEditCanvas(role, 'trashed')).toBe(false)
      expect(can(role, 'restore', 'trashed')).toBe(role === 'owner')
    }
  })

  it('canvas editing is exactly owner/editor on active boards', () => {
    expect(BOARD_ROLES.filter((r) => canEditCanvas(r))).toEqual(['owner', 'editor'])
  })

  it('every workspace role is covered by resolveBoardRole without throwing', () => {
    for (const workspaceRole of WORKSPACE_ROLES)
      expect(() => resolveBoardRole({ workspaceRole, boardGrant: null, visibility: 'private' })).not.toThrow()
  })
})
