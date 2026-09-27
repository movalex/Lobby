import { describe, expect, it } from 'vitest'
import { blockedEditHint, isReadonlyRole, readonlyPill, roleChangeNotice } from './access.ts'

describe('read-only board UI', () => {
  it('owners and editors get an editable canvas and no pill', () => {
    for (const role of ['owner', 'editor'] as const) {
      expect(readonlyPill(role, 'active')).toBeNull()
      expect(isReadonlyRole(role, 'active')).toBe(false)
    }
  })

  it('viewers see "View only", commenters "Can comment"; both are read-only canvases', () => {
    expect(readonlyPill('viewer', 'active')?.label).toBe('View only')
    expect(readonlyPill('commenter', 'active')?.label).toBe('Can comment')
    expect(isReadonlyRole('viewer', 'active')).toBe(true)
    expect(isReadonlyRole('commenter', 'active')).toBe(true)
  })

  it('archived boards are read-only for everyone, owners included', () => {
    for (const role of ['owner', 'editor', 'commenter', 'viewer'] as const) {
      expect(readonlyPill(role, 'archived')?.label).toBe('Archived · View only')
      expect(isReadonlyRole(role, 'archived')).toBe(true)
    }
  })
})

describe('asking for more access (PRI-08, PRI-09b)', () => {
  it('the pill of a viewer or commenter opens the request flow; an archived board’s does not', () => {
    expect(readonlyPill('viewer', 'active')?.request).toBe(true)
    expect(readonlyPill('commenter', 'active')?.request).toBe(true)
    expect(readonlyPill('owner', 'archived')?.request).toBe(false)
    // a commenter's pill never suggests her comments are not saved
    expect(readonlyPill('commenter', 'active')?.title).toMatch(/comments are saved/)
  })

  it('the blocked-edit hint names what you can do and whom to ask', () => {
    expect(blockedEditHint('commenter', 'alice')).toBe(
      'You can comment on this board. Ask alice for edit access.',
    )
    expect(blockedEditHint('viewer', null)).toBe('You can view this board. Ask an owner for edit access.')
  })

  it('a role change while the board is open says what changed', () => {
    expect(roleChangeNotice('viewer', 'editor')).toBe('You can edit this board now')
    expect(roleChangeNotice('commenter', 'editor')).toBe('You can edit this board now')
    expect(roleChangeNotice('editor', 'commenter')).toBe('Your access changed to Can comment')
    expect(roleChangeNotice('commenter', 'viewer')).toBe('Your access changed to Can view')
    expect(roleChangeNotice('editor', 'owner')).toBe('You are now an owner of this board')
    expect(roleChangeNotice('viewer', 'viewer')).toBeNull()
  })
})
