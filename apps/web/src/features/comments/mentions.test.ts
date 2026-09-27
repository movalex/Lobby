import { describe, expect, it } from 'vitest'
import {
  activeMentionQuery,
  applyMention,
  bodyFromDraft,
  bodySegments,
  draftFromBody,
  matchMentionables,
  pruneMentions,
} from './mentions.ts'

const ANN = 'usr_ann0000000000000000'
const ANNA = 'usr_anna000000000000000'
const BOB = 'usr_bob0000000000000000'
const ME = 'usr_me0000000000000000'

const people = [
  { userId: ANN, name: 'Ann Lee', handle: 'ann' },
  { userId: ANNA, name: 'Anna Berg', handle: 'anna' },
  { userId: BOB, name: 'Bob Stone', handle: 'bob' },
  { userId: ME, name: 'Mia Dev', handle: 'mia' },
]

describe('typing @', () => {
  it('finds the query being typed at the caret', () => {
    expect(activeMentionQuery('hi @an', 6)).toEqual({ start: 3, query: 'an' })
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(activeMentionQuery('hi @Ann L', 9)).toEqual({ start: 3, query: 'Ann L' })
    expect(activeMentionQuery('mail me@example.com', 19)).toBeNull() // not at a word start
    expect(activeMentionQuery('hi @ann\nnext', 12)).toBeNull()
    expect(activeMentionQuery('hi @ ', 5)).toBeNull()
    expect(activeMentionQuery('no at sign', 5)).toBeNull()
    // Right after a picked mention ("@Name ") the list must not reopen, or Shift+Enter would re-pick.
    expect(activeMentionQuery('cc @Olive Owner ', 16)).toBeNull()
    // A finished (picked) mention at the caret is not a query: Enter must post.
    const picked = [{ userId: ANN, name: 'Olive Owner' }]
    expect(activeMentionQuery('cc @Olive Owner', 15, picked)).toBeNull()
    expect(activeMentionQuery('cc @Olive', 9, picked)).toEqual({ start: 3, query: 'Olive' })
  })

  it('suggests people with access: prefix and word-start matches first, me last', () => {
    expect(matchMentionables(people, 'ann').map((p) => p.userId)).toEqual([ANN, ANNA])
    expect(matchMentionables(people, 'stone').map((p) => p.userId)).toEqual([BOB])
    expect(matchMentionables(people, 'zzz')).toEqual([])
    expect(matchMentionables(people, '', { meId: ME }).at(-1)?.userId).toBe(ME)
    expect(matchMentionables([{ userId: ANN, name: 'Zoë Ångström', handle: null }], 'ang')).toHaveLength(1)
  })

  it('inserts the picked person and keeps the caret after the name', () => {
    const draft = { text: 'hey @an please', mentions: [] }
    const q = activeMentionQuery(draft.text, 7)
    if (!q) throw new Error('query expected')
    const { draft: next, caret } = applyMention(draft, q, 7, people[0] as (typeof people)[number])
    expect(next.text).toBe('hey @Ann Lee  please')
    expect(caret).toBe('hey @Ann Lee '.length)
    expect(next.mentions).toEqual([{ userId: ANN, name: 'Ann Lee' }])
  })
})

describe('draft <-> body', () => {
  it('turns picked @Names into tokens (longest name first), leaves other @text alone', () => {
    const body = bodyFromDraft({
      text: '@Ann Lee and @Ann Leeway and @Anna Berg, cc @nobody',
      mentions: [
        { userId: ANN, name: 'Ann Lee' },
        { userId: ANNA, name: 'Anna Berg' },
      ],
    })
    expect(body).toBe(`@[Ann Lee](${ANN}) and @Ann Leeway and @[Anna Berg](${ANNA}), cc @nobody`)
  })

  it('round-trips a stored body for editing', () => {
    const body = `ping @[Ann Lee](${ANN}) and @[Ghost](${BOB})`
    const draft = draftFromBody(body, [ANN])
    expect(draft).toEqual({ text: 'ping @Ann Lee and @Ghost', mentions: [{ userId: ANN, name: 'Ann Lee' }] })
    expect(bodyFromDraft(draft)).toBe(`ping @[Ann Lee](${ANN}) and @Ghost`)
  })

  it('drops picks whose @Name was edited away', () => {
    const d = pruneMentions({ text: 'hello Ann', mentions: [{ userId: ANN, name: 'Ann Lee' }] })
    expect(d.mentions).toEqual([])
  })
})

describe('rendering a stored body', () => {
  it('renders chips only for people the comment actually mentioned', () => {
    const body = `hi @[Ann Lee](${ANN}), @[Mia Dev](${ME}) and @[Fake](${BOB})!`
    expect(bodySegments(body, [ANN, ME], ME)).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', userId: ANN, name: 'Ann Lee', me: false },
      { kind: 'text', text: ', ' },
      { kind: 'mention', userId: ME, name: 'Mia Dev', me: true },
      { kind: 'text', text: ' and @Fake!' },
    ])
  })

  it('never produces markup from text (plain strings only)', () => {
    const segs = bodySegments('<img src=x onerror=alert(1)>', [], ME)
    expect(segs).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }])
  })
})
