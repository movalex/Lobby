import { ME_ACCESS_LEGACY, type MeAccess } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { makeBoard, PRJ_ID, WS_ID, WS2_ID } from '../api/test-fixtures.ts'
import { BOARD_ROLES, type BoardStatus, can } from '../lib/permissions.ts'
import {
  type BoardMenuAction,
  boardMenuItems,
  boardsQueryForSection,
  dashboardAccess,
  duplicatedToast,
  duplicateTitle,
  emptyState,
  filterBoards,
  filterByOwner,
  importedToast,
  importTitle,
  landingWorkspace,
  noWorkspaceCopy,
  OUTSIDE_CREATE_NOTE,
  OUTSIDE_NOTICE,
  recentBoards,
  sectionTitle,
  showOutsideNotice,
  sortBoards,
  TRASH_NOTE,
  thumbStyle,
  withStar,
  withStarredEntry,
} from './model.ts'

const actions = (
  role: (typeof BOARD_ROLES)[number],
  status: BoardStatus,
  ctx = { canCreate: true, canMove: true },
  starred = false,
) => boardMenuItems({ role, status, starred }, ctx).map((i) => i.action)

describe('board card menu (DSH-02, gated by the shared permission rules)', () => {
  it('active boards: everyone opens, copies, shares, duplicates, stars; editors rename/move; owners manage', () => {
    const viewing = ['open', 'copy-link', 'share', 'duplicate', 'star', 'details']
    expect(actions('viewer', 'active')).toEqual(viewing)
    expect(actions('commenter', 'active')).toEqual(viewing)
    expect(actions('editor', 'active')).toEqual([
      'open',
      'copy-link',
      'share',
      'rename',
      'move',
      'duplicate',
      'star',
      'details',
    ])
    expect(actions('owner', 'active')).toEqual([
      'open',
      'copy-link',
      'share',
      'rename',
      'move',
      'duplicate',
      'star',
      'details',
      'archive',
      'trash',
    ])
  })

  it('a starred board offers "Remove star" instead of "Star"', () => {
    const items = actions('viewer', 'active', undefined, true)
    expect(items).toContain('unstar')
    expect(items).not.toContain('star')
  })

  it('guests (who cannot create boards or list projects) get neither duplicate nor move', () => {
    const guest = { canCreate: false, canMove: false }
    expect(actions('editor', 'active', guest)).toEqual([
      'open',
      'copy-link',
      'share',
      'rename',
      'star',
      'details',
    ])
  })

  it('archived boards are read-only: nobody renames or moves; only owners restore or trash', () => {
    expect(actions('editor', 'archived')).toEqual([
      'open',
      'copy-link',
      'share',
      'duplicate',
      'star',
      'details',
    ])
    expect(actions('viewer', 'archived')).toEqual([
      'open',
      'copy-link',
      'share',
      'duplicate',
      'star',
      'details',
    ])
    expect(actions('owner', 'archived')).toEqual([
      'open',
      'copy-link',
      'share',
      'duplicate',
      'star',
      'details',
      'restore',
      'trash',
    ])
  })

  it('trashed boards cannot be opened; owners can only restore', () => {
    expect(actions('owner', 'trashed')).toEqual(['restore'])
    for (const r of ['editor', 'commenter', 'viewer'] as const) expect(actions(r, 'trashed')).toEqual([])
  })

  it('never offers an action can() denies, for every role and status', () => {
    const needs: Record<BoardMenuAction, Parameters<typeof can>[1]> = {
      open: 'view',
      'copy-link': 'view',
      share: 'view',
      rename: 'rename',
      move: 'rename',
      duplicate: 'view',
      star: 'view',
      unstar: 'view',
      details: 'view',
      archive: 'archive',
      trash: 'trash',
      restore: 'restore',
    }
    for (const role of BOARD_ROLES) {
      for (const status of ['active', 'archived', 'trashed'] as const) {
        for (const starred of [false, true]) {
          for (const item of boardMenuItems({ role, status, starred })) {
            expect(can(role, needs[item.action], status), `${role}/${status}/${item.action}`).toBe(true)
          }
        }
      }
    }
  })

  it('marks the destructive item', () => {
    expect(boardMenuItems({ role: 'owner', status: 'active' }).find((i) => i.action === 'trash')?.tone).toBe(
      'danger',
    )
  })
})

describe('owner filter, stars and duplicate names', () => {
  const me = 'usr_meeeeeeeeeeeeeeeeeee'
  const boards = [
    makeBoard({ id: 'b-aaaaaaaaa1', createdBy: me }),
    makeBoard({ id: 'b-aaaaaaaaa2', createdBy: 'usr_otherotherotherothe' }),
  ]

  it('filters by who created the board', () => {
    expect(filterByOwner(boards, 'anyone', me)).toHaveLength(2)
    expect(filterByOwner(boards, 'me', me).map((b) => b.id)).toEqual(['b-aaaaaaaaa1'])
    expect(filterByOwner(boards, 'not-me', me).map((b) => b.id)).toEqual(['b-aaaaaaaaa2'])
  })

  it('applies a star change to the list and to the starred section (newest first)', () => {
    const starredList = withStarredEntry(
      [{ ...boards[1], starred: true }] as { id: string; starred?: boolean }[],
      boards[0] as { id: string },
      true,
    )
    expect(starredList.map((b) => b.id)).toEqual(['b-aaaaaaaaa1', 'b-aaaaaaaaa2'])
    expect(withStarredEntry(starredList, { id: 'b-aaaaaaaaa2' }, false).map((b) => b.id)).toEqual([
      'b-aaaaaaaaa1',
    ])
    expect(withStar(boards, 'b-aaaaaaaaa2', true).map((b) => (b as { starred?: boolean }).starred)).toEqual([
      undefined,
      true,
    ])
  })

  it('titles an import from its file name: export names round-trip, slugs read as words', () => {
    // What "Export .json" downloads (history feature: "<title>.lobby.json").
    expect(importTitle('Pitch v2.lobby.json')).toBe('Pitch v2')
    expect(importTitle('Q4 - roadmap.LOBBY.JSON')).toBe('Q4 - roadmap')
    // Exports made before the rename still import under their own title.
    expect(importTitle('Pitch v2.draftroom.json')).toBe('Pitch v2')
    expect(importTitle('Q4 - roadmap.DRAFTROOM.JSON')).toBe('Q4 - roadmap')
    expect(importTitle('brand-refresh_v2.json')).toBe('brand refresh v2')
    expect(importTitle('  Launch   plan .json')).toBe('Launch plan')
    expect(importTitle('.json')).toBeUndefined()
    expect(importTitle('.lobby.json')).toBeUndefined()
    expect(importTitle('.draftroom.json')).toBeUndefined()
    expect(importTitle(`${'x'.repeat(130)}.json`)).toHaveLength(120)
  })

  it('names a duplicate "(copy)" within the 120-character title limit', () => {
    expect(duplicateTitle('Retro')).toBe('Retro (copy)')
    const long = duplicateTitle('x'.repeat(120))
    expect(long.length).toBeLessThanOrEqual(120)
    expect(long.endsWith('… (copy)')).toBe(true)
  })

  it('the duplicate toast says every note the server sent (IO-2a: who keep sharing left out, then files)', () => {
    const board = { title: 'Retro (copy)' }
    expect(duplicatedToast({ board, warnings: [] })).toBe('Duplicated as “Retro (copy)”')
    const leftOut =
      'This project is internal only, so 2 people who are not confirmed as Dark Burn Creative or Trailer Park Group were not given access to the copy.'
    const files = '1 referenced file(s) could not be carried over to the new board and show as missing.'
    expect(duplicatedToast({ board, warnings: [leftOut, files] })).toBe(
      `Duplicated as “Retro (copy)” (${leftOut} ${files})`,
    )
  })

  it('the import toast says the notes the server sent, not "no access" for every left-out file (IO-11)', () => {
    const board = { title: 'Plan' }
    expect(importedToast({ board, warnings: [], droppedFiles: 0 })).toBe('Imported “Plan”.')
    const fenced =
      '2 file(s) in this archive are on boards of an internal-only project, so they were not carried over to a board outside it and show as missing.'
    const text = importedToast({ board, warnings: [fenced], droppedFiles: 2 })
    expect(text).toBe(`Imported “Plan”. ${fenced}`)
    expect(text).not.toContain('no access')
    // An older api with no note for them: the count, no reason guessed.
    expect(importedToast({ board, warnings: [], droppedFiles: 1 })).toBe(
      'Imported “Plan”. 1 file was left out and shows as missing.',
    )
  })

  it('sorts by date created', () => {
    const a = makeBoard({ id: 'b-aaaaaaaaa1', createdAt: '2026-09-01T00:00:00Z' })
    const b = makeBoard({ id: 'b-aaaaaaaaa2', createdAt: '2026-09-20T00:00:00Z' })
    expect(sortBoards([a, b], 'created').map((x) => x.id)).toEqual(['b-aaaaaaaaa2', 'b-aaaaaaaaa1'])
  })

  it('the trash says boards stay until restored (no purge yet)', () => {
    expect(TRASH_NOTE).toMatch(/until an owner restores them/)
  })
})

describe('board lists', () => {
  it('maps each dashboard section to its API query', () => {
    expect(boardsQueryForSection({ kind: 'recent' })).toEqual({ status: 'active' })
    expect(boardsQueryForSection({ kind: 'all' })).toEqual({ status: 'active' })
    expect(boardsQueryForSection({ kind: 'archived' })).toEqual({ status: 'archived' })
    expect(boardsQueryForSection({ kind: 'trash' })).toEqual({ status: 'trashed' })
    expect(boardsQueryForSection({ kind: 'project', projectId: PRJ_ID })).toEqual({
      status: 'active',
      projectId: PRJ_ID,
    })
  })

  it('searches titles by every word, ignoring case and accents', () => {
    const boards = [
      makeBoard({ id: 'b-aaaaaaaaa1', title: 'Café retro — Sprint 12' }),
      makeBoard({ id: 'b-aaaaaaaaa2', title: 'Roadmap Q3' }),
      makeBoard({ id: 'b-aaaaaaaaa3', title: 'Sprint planning' }),
    ]
    expect(filterBoards(boards, 'cafe').map((b) => b.id)).toEqual(['b-aaaaaaaaa1'])
    expect(filterBoards(boards, 'SPRINT').map((b) => b.id)).toEqual(['b-aaaaaaaaa1', 'b-aaaaaaaaa3'])
    expect(filterBoards(boards, 'sprint retro').map((b) => b.id)).toEqual(['b-aaaaaaaaa1'])
    expect(filterBoards(boards, '   ')).toHaveLength(3)
    expect(filterBoards(boards, 'nothing')).toEqual([])
  })

  it('sorts by last opened (falling back to last edit), by last edit, or by name', () => {
    const a = makeBoard({
      id: 'b-aaaaaaaaa1',
      title: 'beta',
      updatedAt: '2026-09-01T00:00:00Z',
      lastOpenedAt: '2026-09-25T00:00:00Z',
    })
    const b = makeBoard({
      id: 'b-aaaaaaaaa2',
      title: 'Alpha',
      updatedAt: '2026-09-20T00:00:00Z',
      lastOpenedAt: null,
    })
    const c = makeBoard({
      id: 'b-aaaaaaaaa3',
      title: 'gamma',
      updatedAt: '2026-09-10T00:00:00Z',
      lastOpenedAt: '2026-09-11T00:00:00Z',
    })
    expect(sortBoards([a, b, c], 'opened').map((x) => x.title)).toEqual(['beta', 'Alpha', 'gamma'])
    expect(sortBoards([a, b, c], 'edited').map((x) => x.title)).toEqual(['Alpha', 'gamma', 'beta'])
    expect(sortBoards([a, b, c], 'name').map((x) => x.title)).toEqual(['Alpha', 'beta', 'gamma'])
    expect(recentBoards([a, b, c], 2).map((x) => x.title)).toEqual(['beta', 'Alpha'])
  })

  it('titles sections, including a project that is not loaded yet', () => {
    expect(sectionTitle({ kind: 'recent' }, [])).toBe('Recent boards')
    expect(sectionTitle({ kind: 'trash' }, [])).toBe('Trash')
    const project = { id: PRJ_ID, workspaceId: WS_ID, name: 'Launch', createdAt: '', archivedAt: null }
    expect(sectionTitle({ kind: 'project', projectId: PRJ_ID }, [project])).toBe('Launch')
    expect(sectionTitle({ kind: 'project', projectId: PRJ_ID }, [])).toBe('Project')
  })

  it('empty states say what to do, and only offer "create" to people who can create', () => {
    expect(emptyState({ kind: 'all' }, { searching: false, canCreate: true })).toMatchObject({
      offerCreate: true,
    })
    const guest = emptyState({ kind: 'all' }, { searching: false, canCreate: false })
    expect(guest.offerCreate).toBe(false)
    expect(guest.body).toMatch(/Guests/)
    expect(emptyState({ kind: 'trash' }, { searching: false, canCreate: true })).toMatchObject({
      title: 'Trash is empty',
      offerCreate: false,
    })
    expect(emptyState({ kind: 'archived' }, { searching: true, canCreate: true }).title).toMatch(/search/)
  })

  it('DANA-08: an empty project reads as that project’s lobby, like the sidebar’s "Project lobbies"', () => {
    const empty = emptyState({ kind: 'project', projectId: PRJ_ID }, { searching: false, canCreate: true })
    expect(empty.title).toBe("This project's lobby has no boards yet")
    expect(empty.body).toMatch(/lobby/)
    expect(empty.offerCreate).toBe(true)
  })
})

describe('thumbnails and landing', () => {
  it('gives a board the same placeholder look everywhere', () => {
    expect(thumbStyle('b-3k9x0q2m7a')).toEqual(thumbStyle('b-3k9x0q2m7a'))
    const looks = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(thumbStyle(`b-${i}aaaaaaaaa`))))
    expect(looks.size).toBeGreaterThan(4)
    for (let i = 0; i < 40; i++) expect(thumbStyle(`b-${i}x`).layout).toBeLessThan(4)
  })

  it('"/" lands on the last-used workspace only while the user still belongs to it', () => {
    const ws = [
      { id: WS_ID, name: 'Dev Studio', role: 'member' as const },
      { id: WS2_ID, name: 'Personal', role: 'owner' as const },
    ]
    expect(landingWorkspace(ws, WS2_ID)?.id).toBe(WS2_ID)
    expect(landingWorkspace(ws, 'wsp_removedremovedremoved')?.id).toBe(WS_ID)
    expect(landingWorkspace(ws, null)?.id).toBe(WS_ID)
    expect(landingWorkspace([], WS_ID)).toBeNull()
  })

  it('does not default to a workspace where the user is only a guest', () => {
    const ws = [
      { id: WS_ID, name: "Alice's workspace", role: 'guest' as const },
      { id: WS2_ID, name: 'Dev Studio', role: 'member' as const },
    ]
    expect(landingWorkspace(ws, null)?.id).toBe(WS2_ID)
    expect(landingWorkspace(ws, WS_ID)?.id).toBe(WS_ID) // explicitly last used: respected
    expect(landingWorkspace([ws[0] as (typeof ws)[number]], null)?.id).toBe(WS_ID) // guest-only users still land
  })
})

describe('domain access: the dashboard for someone who is not a creator (docs/DOMAIN-ACCESS-CONTRACTS.md §9)', () => {
  const outside: MeAccess = { creator: false, reason: 'outside', email: 'pat@client.example.test' }
  const unconfirmed: MeAccess = { creator: false, reason: 'unconfirmed', email: null }
  const dev: MeAccess = { creator: true, reason: 'dev', email: 'alice@dev.invalid' }

  it('an outside workspace member keeps the project list, moving and storage, but creates nothing', () => {
    expect(dashboardAccess(outside, 'member')).toEqual({
      canCreate: false,
      inWorkspace: true,
      limit: 'outside',
    })
    expect(dashboardAccess(outside, 'owner')).toEqual({
      canCreate: false,
      inWorkspace: true,
      limit: 'outside',
    })
    expect(dashboardAccess(outside, 'guest')).toEqual({
      canCreate: false,
      inWorkspace: false,
      limit: 'outside',
    })
    expect(dashboardAccess(unconfirmed, 'member')).toMatchObject({ canCreate: false, limit: 'unconfirmed' })
    expect(dashboardAccess(dev, 'member')).toEqual({ canCreate: true, inWorkspace: true, limit: null })
    // A creator who is a workspace guest: the role decides, and the guest copy stays.
    expect(dashboardAccess(dev, 'guest')).toEqual({ canCreate: false, inWorkspace: false, limit: null })
    // A name-only guest keeps the guest copy.
    expect(dashboardAccess({ creator: false, reason: 'guest', email: null }, 'guest').limit).toBeNull()
  })

  it('"legacy" (an api from before domain access) behaves exactly as a creator did before', () => {
    expect(dashboardAccess(ME_ACCESS_LEGACY, 'member')).toEqual({
      canCreate: true,
      inWorkspace: true,
      limit: null,
    })
    expect(dashboardAccess(ME_ACCESS_LEGACY, 'guest')).toEqual({
      canCreate: false,
      inWorkspace: false,
      limit: null,
    })
    expect(noWorkspaceCopy(ME_ACCESS_LEGACY).reason).toBe('none')
  })

  it('the card menu of an outside member: move stays, duplicate goes', () => {
    const { canCreate, inWorkspace } = dashboardAccess(outside, 'member')
    const items = actions('editor', 'active', { canCreate, canMove: inWorkspace })
    expect(items).toContain('move')
    expect(items).not.toContain('duplicate')
    expect(actions('owner', 'active', { canCreate, canMove: inWorkspace })).toEqual([
      'open',
      'copy-link',
      'share',
      'rename',
      'move',
      'star',
      'details',
      'archive',
      'trash',
    ])
  })

  it('the empty state of an outside member says who can create and never offers it', () => {
    for (const section of [{ kind: 'recent' }, { kind: 'all' }] as const) {
      const e = emptyState(section, { searching: false, canCreate: false, limit: 'outside' })
      expect(e).toEqual({
        title: 'No boards yet',
        body: `Boards shared with you appear here. ${OUTSIDE_CREATE_NOTE}`,
        offerCreate: false,
      })
    }
    expect(OUTSIDE_CREATE_NOTE).toBe(
      'Only people at Dark Burn Creative or Trailer Park Group can create boards. Work there? Sign in with your work email.',
    )
    const project = emptyState(
      { kind: 'project', projectId: PRJ_ID },
      { searching: false, canCreate: false, limit: 'outside' },
    )
    expect(project.offerCreate).toBe(false)
    expect(project.body).toContain(OUTSIDE_CREATE_NOTE)
    expect(project.body).not.toMatch(/Guests/)
    // Unconfirmed: paused, without the "work email" advice.
    const paused = emptyState({ kind: 'all' }, { searching: false, canCreate: false, limit: 'unconfirmed' })
    expect(paused.body).toMatch(/paused until Lobby can confirm your account/)
    expect(paused.offerCreate).toBe(false)
    // Trash, Archived and search keep their own copy; the guest copy is unchanged.
    expect(
      emptyState({ kind: 'trash' }, { searching: false, canCreate: false, limit: 'outside' }).title,
    ).toBe('Trash is empty')
    expect(
      emptyState({ kind: 'all' }, { searching: true, canCreate: false, limit: 'outside' }).title,
    ).toMatch(/search/)
    expect(emptyState({ kind: 'all' }, { searching: false, canCreate: false, limit: null }).body).toMatch(
      /Guests/,
    )
    // A limit never hides "create" from someone who can create.
    expect(
      emptyState({ kind: 'all' }, { searching: false, canCreate: true, limit: 'outside' }).offerCreate,
    ).toBe(true)
  })

  it('an outside account whose role would create is told why the create controls are missing (access-outside)', () => {
    const recent = { kind: 'recent' } as const
    // An existing account that lost creator status, in its own workspace or as a member.
    expect(showOutsideNotice(dashboardAccess(outside, 'owner'), recent)).toBe(true)
    expect(showOutsideNotice(dashboardAccess(outside, 'admin'), recent)).toBe(true)
    expect(showOutsideNotice(dashboardAccess(outside, 'member'), { kind: 'all' })).toBe(true)
    expect(
      showOutsideNotice(dashboardAccess(outside, 'member'), { kind: 'project', projectId: PRJ_ID }),
    ).toBe(true)
    // Workspace guests never create (the role's copy); Trash and Archived offer no creating.
    expect(showOutsideNotice(dashboardAccess(outside, 'guest'), recent)).toBe(false)
    expect(showOutsideNotice(dashboardAccess(outside, 'member'), { kind: 'trash' })).toBe(false)
    expect(showOutsideNotice(dashboardAccess(outside, 'member'), { kind: 'archived' })).toBe(false)
    // Creators, legacy, unconfirmed (its own notice) and name-only guests: no such notice.
    expect(showOutsideNotice(dashboardAccess(dev, 'member'), recent)).toBe(false)
    expect(showOutsideNotice(dashboardAccess(ME_ACCESS_LEGACY, 'member'), recent)).toBe(false)
    expect(showOutsideNotice(dashboardAccess(unconfirmed, 'member'), recent)).toBe(false)
    expect(
      showOutsideNotice(dashboardAccess({ creator: false, reason: 'guest', email: null }, 'guest'), recent),
    ).toBe(false)
    expect(OUTSIDE_NOTICE.title).toBe(
      'Only people at Dark Burn Creative or Trailer Park Group can create boards, projects and links in Lobby.',
    )
    // With the notice on screen the empty state does not repeat it.
    expect(
      emptyState(recent, { searching: false, canCreate: false, limit: 'outside', outsideNotice: true }),
    ).toEqual({
      title: 'No boards yet',
      body: 'Boards shared with you appear here.',
      offerCreate: false,
    })
  })

  it('an account with no workspace: outside (with and without an address), unconfirmed, none', () => {
    expect(landingWorkspace([], null)).toBeNull()
    const withEmail = noWorkspaceCopy(outside)
    expect(withEmail).toMatchObject({
      reason: 'outside',
      title: 'Nothing has been shared with you yet',
      action: 'switch-account',
    })
    expect(withEmail.body[0]).toBe("You're signed in as pat@client.example.test.")
    // "open the invite link they send you": "Invite people" and "Link for one person" send no email (D13).
    expect(withEmail.body[1]).toBe(
      'When someone at Dark Burn Creative or Trailer Park Group invites this address, open the invite link they send you. Work there? Sign in with your work email.',
    )
    expect(withEmail.body.join(' ')).not.toMatch(/in their email/)
    expect(withEmail.address).toBe('pat@client.example.test')
    expect(noWorkspaceCopy(unconfirmed).address).toBeNull()
    const noEmail = noWorkspaceCopy({ ...outside, email: null })
    expect(noEmail.body[0]).toBe("You're signed in with an account that has no confirmed email address.")
    expect(noEmail.body.join(' ')).not.toMatch(/null|undefined/)
    expect(noWorkspaceCopy(unconfirmed)).toMatchObject({
      reason: 'unconfirmed',
      title: "We couldn't confirm your account",
      action: 'reload',
    })
    // K4-4: the "not in a workspace" screen says who is signed in, what to do and how to switch account
    expect(noWorkspaceCopy(dev)).toEqual({
      reason: 'none',
      title: "You're not in a workspace yet",
      body: [
        "You're signed in as alice@dev.invalid.",
        'Open an invite link from a teammate to join their workspace or board. Signed in with the wrong address? Switch account.',
        'Work addresses end in @darkburn.com, @trailerparkgroup.com or @trailerpark.com.',
      ],
      action: 'switch-account',
      address: 'alice@dev.invalid',
    })
    expect(noWorkspaceCopy({ ...dev, email: null }).body[0]).toBe(
      "You're signed in with an account that has no confirmed email address.",
    )
  })
})
