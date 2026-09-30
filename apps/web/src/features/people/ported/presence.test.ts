// OWNER: 3c. Who is on the board for the Excalidraw page's people list (./presence.ts): the roster joined with
// the streamed presence, one person per user, and the people model's rows built from them.
import { describe, expect, it } from 'vitest'
import type { RemoteCursor, RosterEntry } from '../../../canvas/api/index.ts'
import { buildPeople, statusText } from '../model.ts'
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

  it('roles and "(guest)" come with the roster; who may present', () => {
    const map = rosterMap(ROSTER)
    expect(map.get('usr_ann')).toEqual({ role: 'viewer', guest: false })
    expect(mayPresentAs(map.get('usr_bob'))).toBe(true)
    expect(mayPresentAs(map.get('usr_sam'))).toBe(false)
    expect(mayPresentAs(map.get('usr_ann'))).toBe(false)
  })

  it('the rows: the frame in their view, idle, and never "following" (the protocol has no target)', () => {
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
})
