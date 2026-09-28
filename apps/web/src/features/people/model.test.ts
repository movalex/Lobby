import type { LivePresentation } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildPeople,
  filterPeople,
  followerSummary,
  frameAt,
  IDLE_AFTER_MS,
  type PeopleInput,
  type PresenceLike,
  statusText,
  viewCenter,
} from './model.ts'

const ME = 'usr_meeeeeeeeeeee'
const BEN = 'usr_bennnnnnnnnnn'
const CAL = 'usr_calllllllllll'
const SAM = 'usr_sammmmmmmmmmm'
const NOW = 1_000_000_000
const PAGE = 'page:page'

const presence = (id: string, name: string, over: Partial<PresenceLike> = {}): PresenceLike => ({
  userId: `user:${id}`,
  userName: name,
  color: '#1d4ed8',
  followingUserId: null,
  lastActivityTimestamp: NOW - 1_000,
  currentPageId: PAGE,
  // A 1000×500 screen at zoom 1 looking at page (0,0)-(1000,500): its middle is (500, 250).
  camera: { x: 0, y: 0, z: 1 },
  screenBounds: { x: 0, y: 0, w: 1000, h: 500 },
  ...over,
})

const input = (over: Partial<PeopleInput> = {}): PeopleInput => ({
  selfUserId: ME,
  selfName: 'Me Myself',
  selfColor: '#047857',
  selfFollowing: null,
  collaborators: [],
  roster: null,
  presentation: null,
  frames: [],
  currentPageId: PAGE,
  pageName: (id) => (id === 'page:two' ? 'Page 2' : null),
  now: NOW,
  ...over,
})

const live = (over: Partial<LivePresentation> = {}): LivePresentation => ({
  id: 'prs_AAAAAAAAAAAAAAAAAAAA',
  presenter: { userId: BEN, name: 'Ben Ng' },
  tab: 'tab_bbbbbbbbbbbbbbbbbbbb',
  slideId: null,
  index: 0,
  count: 0,
  startedAt: '',
  presenterOnline: true,
  followers: [],
  followerCount: 0,
  ...over,
})

describe('people list model', () => {
  it('one row per person (their most recent tab), you first, the presenter next, then by name', () => {
    const rows = buildPeople(
      input({
        collaborators: [
          presence(CAL, 'Cal Diaz', { lastActivityTimestamp: NOW - 5_000 }),
          presence(CAL, 'Cal Diaz (tab 2)', { lastActivityTimestamp: NOW - 100 }),
          presence(SAM, 'Sam (guest)'),
          presence(BEN, 'Ben Ng'),
          presence(ME, 'Me in another tab'), // my own other tab is not a person
        ],
        presentation: live(),
      }),
    )
    expect(rows.map((r) => r.name)).toEqual(['Me Myself', 'Ben Ng', 'Cal Diaz (tab 2)', 'Sam (guest)'])
    expect(rows[0]).toMatchObject({ self: true, followId: null })
    expect(rows[1]?.status).toBe('presenting')
    // A guest is known from the roster, or from the marker the sync server puts in their name.
    expect(rows.find((r) => r.userId === SAM)?.guest).toBe(true)
  })

  it('roles and guests come from the roster when it is loaded', () => {
    const roster = new Map([
      [ME, { role: 'owner' as const, guest: false }],
      [SAM, { role: 'commenter' as const, guest: true }],
    ])
    const rows = buildPeople(input({ collaborators: [presence(SAM, 'Sam (guest)')], roster }))
    expect(rows.map((r) => [r.role, r.guest])).toEqual([
      ['owner', false],
      ['commenter', true],
    ])
  })

  it('who follows whom: following you, following someone else, following the presentation', () => {
    const rows = buildPeople(
      input({
        selfFollowing: `user:${CAL}`,
        collaborators: [
          presence(BEN, 'Ben Ng', { followingUserId: `user:${ME}` }),
          presence(CAL, 'Cal Diaz', { followingUserId: `user:${BEN}` }),
          presence(SAM, 'Sam (guest)'),
        ],
        presentation: live({
          presenter: { userId: ME, name: 'Me Myself' },
          followers: [{ userId: SAM, name: 'Sam (guest)', guest: true }],
          followerCount: 1,
        }),
      }),
    )
    const by = Object.fromEntries(rows.map((r) => [r.userId, r]))
    expect(by[ME]).toMatchObject({ status: 'presenting', followsMe: false })
    expect(by[BEN]).toMatchObject({ status: 'following-you', followsMe: true })
    expect(by[CAL]).toMatchObject({ status: 'following-other', followingName: 'Ben Ng', followsMe: false })
    expect(by[SAM]).toMatchObject({ status: 'following-presentation', followsMe: true })
    expect(statusText(by[CAL] as never)).toBe('Following Ben Ng')
    expect(statusText(by[ME] as never)).toBe('You are presenting')
  })

  it('where they are: the smallest frame in the middle of their view, another page, idle', () => {
    const frames = [
      { name: 'Board', pageId: PAGE, x: 0, y: 0, w: 2000, h: 2000 },
      { name: 'Ideas', pageId: PAGE, x: 400, y: 200, w: 200, h: 100 },
      { name: '', pageId: PAGE, x: 3000, y: 0, w: 100, h: 100 },
    ]
    expect(frameAt(frames, PAGE, 500, 250)).toBe('Ideas')
    expect(frameAt(frames, PAGE, 3050, 50)).toBe('an unnamed frame')
    expect(frameAt(frames, 'page:two', 500, 250)).toBeNull()
    expect(
      viewCenter({ camera: { x: -100, y: -50, z: 2 }, screenBounds: { x: 0, y: 0, w: 800, h: 400 } }),
    ).toEqual({
      x: 300,
      y: 150,
    })
    const rows = buildPeople(
      input({
        frames,
        collaborators: [
          presence(BEN, 'Ben Ng'),
          presence(CAL, 'Cal Diaz', { currentPageId: 'page:two' }),
          presence(SAM, 'Sam (guest)', { lastActivityTimestamp: NOW - IDLE_AFTER_MS - 1 }),
        ],
      }),
    )
    const by = Object.fromEntries(rows.map((r) => [r.userId, r]))
    expect(statusText(by[BEN] as never)).toBe('In Ideas')
    expect(statusText(by[CAL] as never)).toBe('On Page 2')
    expect(statusText(by[SAM] as never)).toBe('In Ideas · idle')
    expect(statusText(by[ME] as never)).toBe('')
  })

  it('search: every word, accents and case ignored', () => {
    const rows = buildPeople(
      input({
        collaborators: [presence(BEN, 'Benoît Ng'), presence(CAL, 'Cal Diaz'), presence(SAM, 'Sam (guest)')],
      }),
    )
    expect(filterPeople(rows, 'benoit').map((r) => r.userId)).toEqual([BEN])
    expect(filterPeople(rows, '  DIAZ cal ').map((r) => r.userId)).toEqual([CAL])
    expect(filterPeople(rows, 'guest').map((r) => r.userId)).toEqual([SAM])
    expect(filterPeople(rows, '').length).toBe(4)
    expect(filterPeople(rows, 'zed')).toEqual([])
  })

  it('who follows me: tldraw followers plus, while I present, the presentation’s exact count', () => {
    const collaborators = [
      presence(BEN, 'Ben Ng', { followingUserId: `user:${ME}` }),
      presence(BEN, 'Ben Ng', { followingUserId: `user:${ME}` }),
      presence(CAL, 'Cal Diaz', { followingUserId: `user:${BEN}` }),
    ]
    expect(followerSummary(collaborators, null, ME)).toEqual({ names: ['Ben Ng'], count: 1 })
    const p = live({
      presenter: { userId: ME, name: 'Me' },
      followers: [{ userId: SAM, name: 'Sam (guest)', guest: true }],
      followerCount: 12,
    })
    expect(followerSummary(collaborators, p, ME)).toEqual({ names: ['Ben Ng', 'Sam (guest)'], count: 13 })
    // Someone else's presentation: its followers do not follow me.
    expect(followerSummary(collaborators, live({ followerCount: 5 }), ME).count).toBe(1)
  })
})
