// OWNER: 3c. Who is on the board, for the people list on the Excalidraw board page: the roster (the server's
// sessions, uncapped, with each session's role and "(guest)") joined with the streamed presence (their
// view, idle) in the shapes the people model (../model.ts) and the avatars read. Pure: unit-tested in Node.
//
// On the tldraw page the list read tldraw's presence records, which also said whom each person follows.
// Lobby's presence protocol carries no follow target (canvas-schema PresenceIn), so "following you" and
// "following Ann" come only from a live presentation's followers here (CR-3C-1).

import type { RemoteCursor, RosterEntry } from '../../../canvas/api/index.ts'
import type { FrameBox, PresenceLike, RosterMap } from '../model.ts'

export interface PresenceUser {
  userId: string
  name: string
  color: string
  guest: boolean
  /** The session to follow: one of theirs that streams presence and is not idle, else their first. */
  followSid: string
}

/** Each person's session to follow (a person with two tabs is one person). */
function sessionsByUser(roster: readonly RosterEntry[], peers: readonly RemoteCursor[]) {
  const peer = new Map(peers.map((p) => [p.sid, p]))
  const rank = (sid: string) => {
    const p = peer.get(sid)
    return p ? (p.idle ? 1 : 2) : 0
  }
  const out = new Map<string, RosterEntry>()
  for (const r of roster) {
    const prev = out.get(r.uid)
    if (!prev || rank(r.sid) > rank(prev.sid)) out.set(r.uid, r)
  }
  return out
}

/** Other people on the board: one entry per user, this user left out, by name. */
export function presenceUsers(
  roster: readonly RosterEntry[],
  peers: readonly RemoteCursor[],
  selfUserId: string,
): PresenceUser[] {
  return [...sessionsByUser(roster, peers).values()]
    .filter((r) => r.uid !== selfUserId)
    .map((r) => ({ userId: r.uid, name: r.name || r.uid, color: r.color, guest: r.guest, followSid: r.sid }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId))
}

/** One person's role and whether they are a name-only guest (../roster.ts `RosterEntry`). */
export interface RosterRow {
  role: RosterEntry['role']
  guest: boolean
}

/** Each person's role and "(guest)", from the roster (the people list's roles; who may present). */
export function rosterMap(roster: readonly RosterEntry[]): RosterMap {
  const out = new Map<string, RosterRow>()
  for (const r of roster) if (!out.has(r.uid)) out.set(r.uid, { role: r.role, guest: r.guest })
  return out
}

export const ROLE_LABEL: Readonly<Record<RosterEntry['role'], string>> = {
  owner: 'Owner',
  editor: 'Editor',
  commenter: 'Commenter',
  viewer: 'Viewer',
}

/** May present to everyone (the api's rule: edit rights and an account; ../roster.ts). */
export const mayPresentAs = (e: RosterRow | undefined) =>
  !!e && !e.guest && (e.role === 'owner' || e.role === 'editor')

/**
 * The people model's presence records (../model.ts `PresenceLike`): one per session, the view as a
 * camera over one page, never a follow target (the protocol has none), idle as the presence says.
 */
export function presenceLikes(
  roster: readonly RosterEntry[],
  peers: readonly RemoteCursor[],
  now: number,
  pageId: string,
): PresenceLike[] {
  const peer = new Map(peers.map((p) => [p.sid, p]))
  const chosen = sessionsByUser(roster, peers)
  return roster
    .filter((r) => chosen.get(r.uid)?.sid === r.sid)
    .map((r) => {
      const p = peer.get(r.sid)
      const v = p?.view ?? null
      return {
        userId: r.uid,
        userName: r.name,
        color: r.color,
        followingUserId: null,
        // idle as the presence says it (the model counts a person idle a minute after this)
        lastActivityTimestamp: p?.idle ? 1 : now,
        currentPageId: pageId,
        camera: v ? { x: -v.x, y: -v.y, z: 1 } : null,
        screenBounds: v ? { x: 0, y: 0, w: v.width, h: v.height } : null,
      }
    })
}

/** The board's frames as the people model reads them ("In Brainstorm"), from frame elements. */
export function frameBoxesOf(
  frames: readonly { x: number; y: number; width: number; height: number; name?: unknown }[],
  pageId: string,
): FrameBox[] {
  return frames.map((f) => ({
    name: typeof f.name === 'string' ? f.name : '',
    pageId,
    x: f.x,
    y: f.y,
    w: f.width,
    h: f.height,
  }))
}
