import { describe, expect, it } from 'vitest'
import {
  BOARD_ACTIONS,
  BOARD_ROLES,
  BOARD_ROW_STATUSES,
  BOARD_STATUSES,
  BOARD_VISIBILITIES,
  type BoardRole,
  type BoardStatus,
  can,
  canCreateContent,
  canCreateInWorkspace,
  canEditCanvas,
  canHandOutAccess,
  canManageReview,
  canSetReviewStatus,
  IMPORTING_BOARD_STATUS,
  isBoardStatus,
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

  it('wave R: an importing board (and any status this build does not know) allows nothing, to anyone', () => {
    // the stored value reaches can() as a BoardStatus-typed string from a row, so the check is at run time
    for (const status of [IMPORTING_BOARD_STATUS, 'deleted', '', 'ACTIVE'] as unknown as BoardStatus[])
      for (const role of BOARD_ROLES)
        for (const action of BOARD_ACTIONS)
          expect(can(role, action, status), `${status} ${role} ${action}`).toBe(false)
    for (const role of BOARD_ROLES) {
      expect(canEditCanvas(role, IMPORTING_BOARD_STATUS as unknown as BoardStatus)).toBe(false)
      expect(canHandOutAccess(true, role, IMPORTING_BOARD_STATUS as unknown as BoardStatus)).toBe(false)
    }
  })

  it('wave R: importing is a row status only, never a status anyone may list or see', () => {
    expect(BOARD_STATUSES).toEqual(['active', 'archived', 'trashed'])
    expect(BOARD_ROW_STATUSES).toEqual(['active', 'archived', 'trashed', 'importing'])
    expect(isBoardStatus('importing')).toBe(false)
    expect(BOARD_STATUSES.every((s) => isBoardStatus(s))).toBe(true)
    expect(isBoardStatus(undefined)).toBe(false)
  })

  it('canvas editing is exactly owner/editor on active boards', () => {
    expect(BOARD_ROLES.filter((r) => canEditCanvas(r))).toEqual(['owner', 'editor'])
  })

  it('every workspace role is covered by resolveBoardRole without throwing', () => {
    for (const workspaceRole of WORKSPACE_ROLES)
      expect(() => resolveBoardRole({ workspaceRole, boardGrant: null, visibility: 'private' })).not.toThrow()
  })
})

describe('domain access predicates', () => {
  it('creating content needs a creator and a workspace role that may create', () => {
    for (const role of [...WORKSPACE_ROLES, null]) {
      expect(canCreateContent(true, role), `creator ${role}`).toBe(canCreateInWorkspace(role))
      expect(canCreateContent(false, role), `outside ${role}`).toBe(false)
    }
  })

  it('handing out access needs a creator and manage_access', () => {
    for (const role of [...BOARD_ROLES, null])
      for (const status of ['active', 'archived', 'trashed'] as const) {
        expect(canHandOutAccess(true, role, status), `creator ${role} ${status}`).toBe(
          can(role, 'manage_access', status),
        )
        expect(canHandOutAccess(false, role, status), `outside ${role} ${status}`).toBe(false)
      }
  })
})

describe('wave S: review status and managing review', () => {
  const statuses = ['active', 'archived', 'trashed', 'importing'] as const
  it('setting a status is exactly commenting (owner, editor, commenter on an active board)', () => {
    expect(BOARD_ROLES.filter((r) => canSetReviewStatus(r))).toEqual(['owner', 'editor', 'commenter'])
    for (const role of [...BOARD_ROLES, null])
      for (const status of statuses)
        expect(canSetReviewStatus(role, status as BoardStatus), `${role} ${status}`).toBe(
          can(role, 'comment', status as BoardStatus),
        )
    expect(canSetReviewStatus('owner', 'archived')).toBe(false)
  })

  it('managing review needs edit rights and an account: never a name-only guest, never off an active board', () => {
    expect(BOARD_ROLES.filter((r) => canManageReview(r, 'account'))).toEqual(['owner', 'editor'])
    for (const role of BOARD_ROLES) {
      expect(canManageReview(role, 'guest'), role).toBe(false)
      expect(canManageReview(role, null), role).toBe(false)
      expect(canManageReview(role, undefined), role).toBe(false)
      for (const status of ['archived', 'trashed', 'importing'])
        expect(canManageReview(role, 'account', status as BoardStatus), `${role} ${status}`).toBe(false)
    }
    expect(canManageReview(null, 'account')).toBe(false)
  })
})
