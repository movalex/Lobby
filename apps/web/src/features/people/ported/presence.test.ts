// OWNER: 3c. Who is on the board for the Excalidraw page's people list (./presence.ts): the roster joined with
// the streamed presence, one person per user, and the people model's rows built from them.
import { describe, expect, it } from 'vitest'
import type { RemoteCursor, RosterEntry } from '../../../canvas/api/index.ts'
import { buildPeople, followerSummary, statusText } from '../model.ts'
import { frameBoxesOf, mayPresentAs, presenceLikes, presenceUsers, rosterMap } from './presence.ts'

const r = (sid: string, uid: string, name: string, role: RosterEntry['role'] = 'editor', guest = false) =>
  ({ sid, uid, name, color: '#123456', role, guest }) as RosterEntry
const p = (sid: string, over: Partial<RemoteCursor> = {}): RemoteCursor => ({
  sid,
  uid: '',
  name: '',
  color: '',
  guest: false,
  point: null,
  view: null,
  selection: [],
  idle: false,
  editing: null,
  ...over,
})

const ROSTER = [
  r('s-me', 'usr_me', 'Me Myself', 'owner'),
  r('s-bob1', 'usr_bob', 'Bob Chen'),
  r('s-bob2', 'usr_bob', 'Bob Chen'),
  r('s-sam', 'usr_sam', 'Sam Rivera (guest)', 'editor', true),
  r('s-ann', 'usr_ann', 'Ann Lee', 'viewer'),
]

describe('the people on the board', () => {
  it('one avatar per person, this user left out, by name; a person follows through a live session', () => {
    const users = presenceUsers(ROSTER, [p('s-bob1', { idle: true }), p('s-bob2')], 'usr_me')
    expect(users.map((u) => u.userId)).toEqual(['usr_ann', 'usr_bob', 'usr_sam'])
    expect(users.find((u) => u.userId === 'usr_bob')?.followSid).toBe('s-bob2')
    expect(users.find((u) => u.userId === 'usr_sam')?.guest).toBe(true)
  })

  it('CR-3C-1: a follower the room does not stream never outranks a streaming tab of the same person', () => {
    // Bob has two tabs: s-bob1 streams but is idle; s-bob2 is a synthetic follower entry (past the cursor cap:
    // no view, no point, not idle, `streaming: false`), listed after a Gather
    const synthetic = p('s-bob2', { following: 's-me', streaming: false })
    const streamingIdle = p('s-bob1', { idle: true, view: { x: 0, y: 0, width: 10, height: 10 } })
    for (const peers of [
      [streamingIdle, synthetic],
      [synthetic, streamingIdle],
    ]) {
      const bob = presenceUsers(ROSTER, peers, 'usr_me').find((u) => u.userId === 'usr_bob')
      expect(bob?.followSid, 'the streaming tab is the one to follow').toBe('s-bob1')
      const like = presenceLikes(ROSTER, peers, 1_000_000, 'page:page', 's-me').find(
        (l) => l.userId === 'usr_bob',
      )
      // the row shows the streaming tab (its view), and still counts that his other tab follows this one
      expect(like?.screenBounds).toEqual({ x: 0, y: 0, w: 10, h: 10 })
      expect(like?.followingUserId).toBe('user:usr_me')
    }
    // a live streaming tab beats it too, whichever tab the roster lists first
    for (const peers of [
      [synthetic, p('s-bob1')],
      [p('s-bob1'), synthetic],
    ])
      expect(presenceUsers(ROSTER, peers, 'usr_me').find((u) => u.userId === 'usr_bob')?.followSid).toBe(
        's-bob1',
      )
  })

  it('roles and "(guest)" come with the roster; who may present', () => {
    const map = rosterMap(ROSTER)
    expect(map.get('usr_ann')).toEqual({ role: 'viewer', guest: false })
    expect(mayPresentAs(map.get('usr_bob'))).toBe(true)
    expect(mayPresentAs(map.get('usr_sam'))).toBe(false)
    expect(mayPresentAs(map.get('usr_ann'))).toBe(false)
  })

  it('the rows: the frame in their view, idle, and no "following" from a room or client without one (rev 9)', () => {
    const now = 1_000_000
    const frames = frameBoxesOf([{ x: 0, y: 0, width: 1000, height: 1000, name: 'Brainstorm' }], 'page:page')
    const rows = buildPeople({
      selfUserId: 'usr_me',
      selfName: 'Me Myself',
      selfColor: '#000000',
      selfFollowing: 'usr_bob',
      collaborators: presenceLikes(
        ROSTER,
        [p('s-bob2', { view: { x: 100, y: 100, width: 400, height: 300 } }), p('s-ann', { idle: true })],
        now,
        'page:page',
      ),
      roster: rosterMap(ROSTER),
      presentation: null,
      frames,
      currentPageId: 'page:page',
      pageName: () => null,
      now,
    })
    const byId = new Map(rows.map((row) => [row.userId, row]))
    expect(rows).toHaveLength(4)
    expect(statusText(byId.get('usr_bob') as never)).toBe('In Brainstorm')
    expect(byId.get('usr_ann')?.idle).toBe(true)
    expect(statusText(byId.get('usr_ann') as never)).toBe('On the board · idle')
    expect(byId.get('usr_me')?.status).toBe('following-other')
    expect(byId.get('usr_bob')?.followsMe).toBe(false)
    expect(byId.get('usr_sam')?.guest).toBe(true)
  })

  it('CR-3C-1 (rev 10): "Following you" from presence, through any tab of theirs; "Following Ann"; the top-bar count', () => {
    const now = 1_000_000
    const peers = [
      // Bob's second tab follows this tab (s-me); his first tab, the one the list shows, does not
      p('s-bob1', { view: { x: 0, y: 0, width: 10, height: 10 } }),
      p('s-bob2', { idle: true, following: 's-me' }),
      // Sam follows Ann; Ann is past the cursor cap and follows this tab (the room's followers list)
      p('s-sam', { following: 's-ann' }),
      p('s-ann', { following: 's-me' }),
    ]
    const likes = presenceLikes(ROSTER, peers, now, 'page:page', 's-me')
    const rows = buildPeople({
      selfUserId: 'usr_me',
      selfName: 'Me Myself',
      selfColor: '#000000',
      selfFollowing: null,
      collaborators: likes,
      roster: rosterMap(ROSTER),
      presentation: null,
      frames: [],
      currentPageId: 'page:page',
      pageName: () => null,
      now,
    })
    const byId = new Map(rows.map((row) => [row.userId, row]))
    expect(byId.get('usr_bob')?.status).toBe('following-you')
    expect(byId.get('usr_bob')?.followsMe).toBe(true)
    expect(statusText(byId.get('usr_ann') as never)).toBe('Following you')
    expect(statusText(byId.get('usr_sam') as never)).toBe('Following Ann Lee')
    expect(followerSummary(likes, null, 'usr_me')).toEqual({ names: ['Bob Chen', 'Ann Lee'], count: 2 })
    // without this tab's session (before the welcome) only the session the list shows counts: Bob's
    // following tab is not that one
    const blind = presenceLikes(ROSTER, peers, now, 'page:page')
    expect(followerSummary(blind, null, 'usr_me')).toEqual({ names: ['Ann Lee'], count: 1 })
  })
})
