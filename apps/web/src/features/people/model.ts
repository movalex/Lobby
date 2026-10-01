// The people list (WRK-02, FAC-01, FAC-10 in part): who is on the board, from live presence, joined
// with their role on the board, the live presentation and who follows whom. Pure: no editor, no DOM.

import type { LivePresentation } from '@draftroom/contracts'
import type { BoardRole } from '../../lib/permissions.ts'

/** One person's role on the board and whether they are a name-only guest (the api's roster). */
export interface RosterEntry {
  role: BoardRole
  guest: boolean
}

export type RosterMap = ReadonlyMap<string, RosterEntry>

/** A person counts as idle after this long without moving their pointer (tldraw's own "inactive"). */
export const IDLE_AFTER_MS = 60_000

const bare = (id: string) => (id.startsWith('user:') ? id.slice('user:'.length) : id)

/** The slice of a tldraw presence record the list reads. */
export interface PresenceLike {
  userId: string
  userName: string
  color: string
  followingUserId: string | null
  lastActivityTimestamp: number | null
  currentPageId: string
  camera: { x: number; y: number; z: number } | null
  screenBounds: { x: number; y: number; w: number; h: number } | null
}

export interface FrameBox {
  name: string
  pageId: string
  x: number
  y: number
  w: number
  h: number
}

export type PersonStatus =
  | 'presenting'
  | 'following-presentation'
  | 'following-you'
  | 'following-other'
  | 'here'

export interface PersonRow {
  userId: string
  /** The display name (a name-only guest's ends in " (guest)"). */
  name: string
  color: string
  /** The presence user id to pass to tldraw's startFollowingUser (null for yourself). */
  followId: string | null
  self: boolean
  guest: boolean
  role: BoardRole | null
  status: PersonStatus
  /** Whom they follow, for 'following-other'. */
  followingName: string | null
  /** This person (not you) follows you: tldraw follow, or your live presentation. */
  followsMe: boolean
  idle: boolean
  /** The frame in the middle of their view ("Brainstorm"), or null. */
  where: string | null
  /** Their page's name when it is not the one you are on. */
  otherPage: string | null
}

export interface PeopleInput {
  selfUserId: string
  selfName: string
  selfColor: string
  /** tldraw's instance state `followingUserId` of this tab (whom you follow). */
  selfFollowing: string | null
  collaborators: readonly PresenceLike[]
  roster: RosterMap | null
  presentation: LivePresentation | null
  frames: readonly FrameBox[]
  currentPageId: string
  pageName(pageId: string): string | null
  now: number
}

/** The smallest frame whose box contains the point (a nested frame is more precise than its parent). */
export function frameAt(frames: readonly FrameBox[], pageId: string, x: number, y: number): string | null {
  let best: FrameBox | null = null
  for (const f of frames) {
    if (f.pageId !== pageId) continue
    if (x < f.x || y < f.y || x > f.x + f.w || y > f.y + f.h) continue
    if (!best || f.w * f.h < best.w * best.h) best = f
  }
  return best ? best.name.trim() || 'an unnamed frame' : null
}

/** The page point in the middle of someone's view, from their presence camera and screen size. */
export function viewCenter(
  p: Pick<PresenceLike, 'camera' | 'screenBounds'>,
): { x: number; y: number } | null {
  const c = p.camera
  const s = p.screenBounds
  if (!c || !s || !(c.z > 0)) return null
  return { x: -c.x + s.w / c.z / 2, y: -c.y + s.h / c.z / 2 }
}

/** One row per person (a person with two tabs is one row: their most recently active tab). */
export function buildPeople(input: PeopleInput): PersonRow[] {
  const { selfUserId, presentation: p, roster } = input
  const latest = new Map<string, PresenceLike>()
  for (const c of input.collaborators) {
    const id = bare(c.userId)
    if (id === selfUserId) continue
    const prev = latest.get(id)
    if (!prev || (c.lastActivityTimestamp ?? 0) > (prev.lastActivityTimestamp ?? 0)) latest.set(id, c)
  }
  const nameOf = new Map<string, string>([[selfUserId, input.selfName]])
  for (const [id, c] of latest) nameOf.set(id, c.userName || id)
  const liveFollowers = new Set(p?.followers.map((f) => f.userId) ?? [])
  const iPresent = p?.presenter.userId === selfUserId

  const statusOf = (userId: string, followingUserId: string | null) => {
    if (p?.presenter.userId === userId) return { status: 'presenting' as const, followingName: null }
    if (liveFollowers.has(userId)) return { status: 'following-presentation' as const, followingName: null }
    const target = followingUserId ? bare(followingUserId) : null
    if (target && target === selfUserId && userId !== selfUserId)
      return { status: 'following-you' as const, followingName: null }
    if (target) return { status: 'following-other' as const, followingName: nameOf.get(target) ?? 'someone' }
    return { status: 'here' as const, followingName: null }
  }

  const rows: PersonRow[] = []
  const self = statusOf(selfUserId, input.selfFollowing)
  const selfEntry = roster?.get(selfUserId)
  rows.push({
    userId: selfUserId,
    name: input.selfName,
    color: input.selfColor,
    followId: null,
    self: true,
    guest: selfEntry?.guest ?? false,
    role: selfEntry?.role ?? null,
    ...self,
    // The person you follow is not "following-you"; for yourself the word is about you.
    followsMe: false,
    idle: false,
    where: null,
    otherPage: null,
  })
  for (const [userId, c] of latest) {
    const entry = roster?.get(userId)
    const s = statusOf(userId, c.followingUserId)
    const center = viewCenter(c)
    const onOtherPage = c.currentPageId !== input.currentPageId
    rows.push({
      userId,
      name: c.userName || userId,
      color: c.color,
      followId: c.userId,
      self: false,
      guest: entry?.guest ?? (c.userName ?? '').endsWith(' (guest)'),
      role: entry?.role ?? null,
      ...s,
      followsMe: s.status === 'following-you' || (iPresent && s.status === 'following-presentation'),
      idle: !!c.lastActivityTimestamp && input.now - c.lastActivityTimestamp > IDLE_AFTER_MS,
      where: center ? frameAt(input.frames, c.currentPageId, center.x, center.y) : null,
      otherPage: onOtherPage ? input.pageName(c.currentPageId) : null,
    })
  }
  const rank = (r: PersonRow) => (r.self ? 0 : r.status === 'presenting' ? 1 : 2)
  return rows.sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId),
  )
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Rows whose name contains every word of the query (accents and case ignored). */
export function filterPeople(rows: readonly PersonRow[], query: string): PersonRow[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter((r) => {
    const name = fold(r.name)
    return words.every((w) => name.includes(w))
  })
}

/** The line under a person's name. */
export function statusText(r: PersonRow): string {
  const parts: string[] = []
  switch (r.status) {
    case 'presenting':
      parts.push(r.self ? 'You are presenting' : 'Presenting to everyone')
      break
    case 'following-presentation':
      parts.push('Following the presentation')
      break
    case 'following-you':
      parts.push('Following you')
      break
    case 'following-other':
      parts.push(r.self ? `You are following ${r.followingName}` : `Following ${r.followingName}`)
      break
    default:
      if (r.otherPage) parts.push(`On ${r.otherPage}`)
      else if (r.where) parts.push(`In ${r.where}`)
      else if (!r.self) parts.push('On the board')
  }
  if (r.idle) parts.push('idle')
  return parts.join(' · ')
}

/**
 * Who follows you now (the top-bar indicator): people whose view follows yours (tldraw's follow:
 * clicking your avatar, or your "Bring here") and, while you present to everyone, the presentation's
 * followers. Names first-come, unique; the count is exact (the api's count for the presentation).
 */
export function followerSummary(
  collaborators: readonly Pick<PresenceLike, 'userId' | 'userName' | 'followingUserId'>[],
  presentation: LivePresentation | null,
  selfUserId: string,
): { names: string[]; count: number } {
  const me = `user:${selfUserId}`
  const byUser = new Map<string, string>()
  for (const c of collaborators) {
    const id = bare(c.userId)
    if (id !== selfUserId && c.followingUserId === me && !byUser.has(id)) byUser.set(id, c.userName || id)
  }
  let count = byUser.size
  if (presentation?.presenter.userId === selfUserId) {
    for (const f of presentation.followers) if (!byUser.has(f.userId)) byUser.set(f.userId, f.name)
    count += presentation.followerCount
  }
  return { names: [...byUser.values()], count: Math.max(count, byUser.size) }
}
