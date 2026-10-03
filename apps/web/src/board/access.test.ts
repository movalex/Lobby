import { describe, expect, it } from 'vitest'
import {
  ACCESS_ACTOR_FRESH_MS,
  accessActorName,
  blockedEditHint,
  freshActorName,
  isReadonlyRole,
  readonlyPill,
  roleChangeNotice,
  shareButtonView,
} from './access.ts'

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

describe('who changed my access (REVIEW-6)', () => {
  it('the toast says by whom, after an unexpected downgrade included', () => {
    expect(roleChangeNotice('editor', 'commenter', 'Bob Owner')).toBe(
      'Your access changed to Can comment (changed by Bob Owner)',
    )
    expect(roleChangeNotice('viewer', 'editor', 'Bob Owner')).toBe(
      'You can edit this board now (changed by Bob Owner)',
    )
    expect(roleChangeNotice('editor', 'owner', 'Bob')).toBe(
      'You are now an owner of this board (changed by Bob)',
    )
    // no name known: the toast is as before; and no change, no toast, whoever acted
    expect(roleChangeNotice('editor', 'viewer', null)).toBe('Your access changed to Can view')
    expect(roleChangeNotice('viewer', 'viewer', 'Bob')).toBeNull()
  })

  it('reads the actor from an access.changed event, and nothing else', () => {
    expect(accessActorName({ actor: { name: ' Bob Owner ' } })).toBe('Bob Owner')
    for (const bad of [
      null,
      undefined,
      'Bob',
      {},
      { actor: null },
      { actor: { name: 7 } },
      { actor: { name: '  ' } },
    ])
      expect(accessActorName(bad)).toBeNull()
  })

  it('keeps the name only while it is about the change being announced', () => {
    const hint = { name: 'Bob', at: 1_000 }
    expect(freshActorName(hint, 1_000 + ACCESS_ACTOR_FRESH_MS)).toBe('Bob')
    expect(freshActorName(hint, 1_001 + ACCESS_ACTOR_FRESH_MS)).toBeNull()
    expect(freshActorName(null, 1_000)).toBeNull()
  })
})

describe('the top bar’s Share button (DANA-11 / F14 / PRI-18)', () => {
  it('is "People", and not the primary button, for viewers, commenters and guests', () => {
    for (const role of ['viewer', 'commenter'] as const)
      expect(shareButtonView(role, false)).toMatchObject({ label: 'People', primary: false })
    // a guest with an edit role (a workshop link) still cannot hand out access
    for (const role of ['viewer', 'commenter', 'editor'] as const)
      expect(shareButtonView(role, true)).toMatchObject({ label: 'People', primary: false })
  })

  it('stays the primary "Share" for editors and owners, who copy the link or share the board', () => {
    for (const role of ['editor', 'owner'] as const)
      expect(shareButtonView(role, false)).toMatchObject({ label: 'Share', primary: true })
  })
})
