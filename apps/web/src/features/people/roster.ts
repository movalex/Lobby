// Who may do what on this board, per person (the people list's roles, and who can take over a
// presentation): GET /api/boards/:bid/members (everyone who can open the board, with their role;
// allowed to anyone who can view it, guests included, without handles) plus GET /api/boards/:bid/guests
// (which of them are name-only guests). Loaded when first needed, then kept current on the
// `sharing.changed` event and after every reconnect. UI hints only: every action is decided by the api.

import { BoardGuests, ListMembersResponse } from '@draftroom/contracts'
import { type Atom, atom } from 'tldraw'
import type { BoardRole } from '../../lib/permissions.ts'
import type { FeatureContext } from '../types.ts'

export interface RosterEntry {
  role: BoardRole
  guest: boolean
}

export type RosterMap = ReadonlyMap<string, RosterEntry>

export interface Roster {
  /** null until the first load finished (or when it failed). */
  readonly entries: Atom<RosterMap | null>
  /** Loads it if it is not loaded yet (or reloads when `force`). */
  load(force?: boolean): Promise<void>
  dispose(): void
}

const rosters = new WeakMap<object, Roster>()

/** One roster per board session (keyed on the board's event stream, like the workshops store). */
export function rosterFor(ctx: Pick<FeatureContext, 'api' | 'events' | 'board'>): Roster {
  const existing = rosters.get(ctx.events)
  if (existing) return existing
  const entries = atom<RosterMap | null>('dr-people-roster', null)
  const base = `/api/boards/${encodeURIComponent(ctx.board.id)}`
  let inflight: Promise<void> | null = null
  let wanted = false
  let again = false

  const fetchOnce = async () => {
    const [members, guests] = await Promise.all([
      ctx.api.request('GET', `${base}/members`, { schema: ListMembersResponse }),
      ctx.api.request('GET', `${base}/guests`, { schema: BoardGuests }).catch(() => ({ userIds: [] })),
    ])
    const guestIds = new Set(guests.userIds)
    const map = new Map<string, RosterEntry>()
    for (const m of members.members) map.set(m.user.id, { role: m.role, guest: guestIds.has(m.user.id) })
    entries.set(map)
  }

  const load = (force = false): Promise<void> => {
    wanted = true
    if (inflight) {
      if (force) again = true
      return inflight
    }
    if (entries.get() && !force) return Promise.resolve()
    inflight = fetchOnce()
      .catch(() => {
        // Keep what was shown; the next reason to load tries again.
      })
      .finally(() => {
        inflight = null
        if (again) {
          again = false
          void load(true)
        }
      })
    return inflight
  }

  // Only once somebody looked: a board nobody opens the people list on never asks.
  const refresh = () => {
    if (wanted) void load(true)
  }
  const offs = [ctx.events.on('sharing.changed', refresh), ctx.events.onResync(refresh)]

  const roster: Roster = {
    entries,
    load,
    dispose() {
      for (const off of offs) off()
      rosters.delete(ctx.events)
    },
  }
  rosters.set(ctx.events, roster)
  return roster
}

export const ROLE_LABEL: Readonly<Record<BoardRole, string>> = {
  owner: 'Owner',
  editor: 'Editor',
  commenter: 'Commenter',
  viewer: 'Viewer',
}

/** May present to everyone (the api's rule: edit rights and an account). */
export const mayPresentAs = (e: RosterEntry | undefined) =>
  !!e && !e.guest && (e.role === 'owner' || e.role === 'editor')
