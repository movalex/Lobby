import { describe, expect, it } from 'vitest'
import { makeBoard, PRJ_ID, WS_ID, WS2_ID } from '../api/test-fixtures.ts'
import { BOARD_ROLES, type BoardStatus, can } from '../lib/permissions.ts'
import {
  type BoardMenuAction,
  boardMenuItems,
  boardsQueryForSection,
  duplicateTitle,
  emptyState,
  filterBoards,
  filterByOwner,
  importTitle,
  landingWorkspace,
  recentBoards,
  sectionTitle,
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
