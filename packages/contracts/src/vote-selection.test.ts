// Migration 0024's contracts (wave B, RETRO-10): the vote scope 'selection', and the web build revision
// that decides who may receive it (client-rev.ts).
import { describe, expect, it } from 'vitest'
import {
  CreateVoteInput,
  clientRevOf,
  isVoteEligible,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  VOTE_SELECTION_MAX,
  VoteSession,
  type VoteShapeInfo,
  voteRuleOf,
} from './index.ts'

const base = { votesPerPerson: 3, onePerObject: false }

describe('CreateVoteInput: scope selection', () => {
  it('takes 1..200 object refs, only with scope selection', () => {
    expect(
      CreateVoteInput.parse({ ...base, scope: 'selection', selection: ['shape:a', 'shape:b'] }),
    ).toMatchObject({ scope: 'selection', selection: ['shape:a', 'shape:b'] })
    const max = Array.from({ length: VOTE_SELECTION_MAX }, (_, i) => `shape:n${i}`)
    expect(CreateVoteInput.safeParse({ ...base, scope: 'selection', selection: max }).success).toBe(true)
    for (const bad of [
      { scope: 'selection' },
      { scope: 'selection', selection: null },
      { scope: 'selection', selection: [] },
      { scope: 'selection', selection: [...max, 'shape:one-more'] },
      { scope: 'selection', selection: ['note:a'] },
      { scope: 'selection', selection: ['shape:a.b'] },
      { scope: 'selection', selection: ['shape:a'], frameId: 'shape:a' },
      { scope: 'board', selection: ['shape:a'] },
      { scope: 'frame', frameId: 'shape:f', selection: ['shape:a'] },
      { scope: 'everything' },
    ])
      expect(CreateVoteInput.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false)
  })

  it('a session from an api before 0024 (no selection) still parses', () => {
    const session = {
      id: 'vot_0123456789',
      boardId: 'b-1',
      title: 'Dot vote',
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'frame',
      frameId: 'shape:f',
      shapeTypes: null,
      status: 'open',
      createdBy: 'usr_0123456789',
      createdAt: '2026-10-03T00:00:00.000Z',
      endsAt: null,
      closedAt: null,
      revealedAt: null,
    }
    expect(VoteSession.parse(session).selection).toBeUndefined()
    expect(
      VoteSession.parse({ ...session, scope: 'selection', frameId: null, selection: ['shape:a'] }),
    ).toMatchObject({ scope: 'selection', selection: ['shape:a'] })
  })
})

describe('isVoteEligible: scope selection', () => {
  const shapes = new Map<string, VoteShapeInfo>(
    [
      { id: 'shape:went', type: 'frame', parentId: 'page:page' },
      { id: 'shape:later', type: 'frame', parentId: 'page:page' },
      { id: 'shape:w1', type: 'note', parentId: 'shape:went' },
      { id: 'shape:wbox', type: 'geo', parentId: 'shape:went' },
      { id: 'shape:p1', type: 'note', parentId: 'shape:later' },
      { id: 'shape:loose', type: 'note', parentId: 'page:page' },
      { id: 'shape:other', type: 'note', parentId: 'page:page' },
      { id: 'shape:link', type: 'arrow', parentId: 'page:page' },
    ].map((s) => [s.id, s]),
  )
  const lookup = (id: string) => shapes.get(id)
  const rule = voteRuleOf({
    scope: 'selection',
    frameId: null,
    shapeTypes: null,
    selection: ['shape:went', 'shape:loose', 'shape:link'],
  })
  const ok = (id: string, r = rule) => isVoteEligible(id, lookup, r)

  it('listed objects and the contents of listed frames take votes; the frames, others and connectors do not', () => {
    expect(ok('shape:w1')).toBe(true)
    expect(ok('shape:wbox')).toBe(true)
    expect(ok('shape:loose')).toBe(true)
    expect(ok('shape:went')).toBe(false)
    expect(ok('shape:p1')).toBe(false)
    expect(ok('shape:other')).toBe(false)
    expect(ok('shape:link')).toBe(false)
    expect(ok('shape:nope')).toBe(false)
  })

  it('the type filter still applies; a missing list takes nothing', () => {
    const notes = { ...rule, shapeTypes: ['note'] }
    expect(ok('shape:w1', notes)).toBe(true)
    expect(ok('shape:wbox', notes)).toBe(false)
    expect(ok('shape:w1', { ...rule, selection: null })).toBe(false)
    expect(ok('shape:loose', { ...rule, selection: [] })).toBe(false)
  })

  it('voteRuleOf carries every field (board and frame rules are unchanged)', () => {
    expect(voteRuleOf({ scope: 'frame', frameId: 'shape:went', shapeTypes: ['note'] })).toEqual({
      scope: 'frame',
      frameId: 'shape:went',
      shapeTypes: ['note'],
      selection: null,
    })
    expect(ok('shape:w1', voteRuleOf({ scope: 'frame', frameId: 'shape:went', shapeTypes: null }))).toBe(true)
    expect(ok('shape:went', voteRuleOf({ scope: 'frame', frameId: 'shape:went', shapeTypes: null }))).toBe(
      false,
    )
    expect(ok('shape:other', voteRuleOf({ scope: 'board', frameId: null, shapeTypes: null }))).toBe(true)
  })
})

describe('the web build revision header', () => {
  it('reads a small integer; anything else is revision 0', () => {
    expect(LOBBY_CLIENT_HEADER).toBe('x-lobby-client')
    expect(LOBBY_CLIENT_REV).toBe(1)
    expect(clientRevOf(undefined)).toBe(0)
    expect(clientRevOf('1')).toBe(1)
    expect(clientRevOf(' 2 ')).toBe(2)
    expect(clientRevOf(['3', '1'])).toBe(3)
    for (const v of ['', 'abc', '-1', '1.5', '12345', '0x1', '1e2']) expect(clientRevOf(v), v).toBe(0)
  })
})
