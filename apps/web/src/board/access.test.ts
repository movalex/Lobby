import { describe, expect, it } from 'vitest'
import { isReadonlyRole, readonlyPill } from './access.ts'

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
