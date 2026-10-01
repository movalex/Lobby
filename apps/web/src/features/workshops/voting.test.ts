import { isVoteEligible, rankVoteResults, type VoteShapeInfo } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { followIdFor, isCanvasPress, summonApplies } from './follow.ts'
import {
  badgeScale,
  clusterBadges,
  csvCell,
  describeProgress,
  localCastCheck,
  notInVoteText,
  optimisticBallot,
  plainTextFromRichText,
  readingOrder,
  resultsCsv,
  shapeLabel,
  topResults,
  voteClick,
} from './voting.ts'

const rt = (...lines: string[]) => ({
  type: 'doc',
  content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
})

describe('eligibility (shared with the API)', () => {
  const shapes = new Map<string, VoteShapeInfo>(
    [
      { id: 'shape:frame', type: 'frame', parentId: 'page:1' },
      { id: 'shape:a', type: 'note', parentId: 'shape:frame' },
      { id: 'shape:g', type: 'group', parentId: 'shape:frame' },
      { id: 'shape:b', type: 'geo', parentId: 'shape:g' },
      { id: 'shape:c', type: 'note', parentId: 'page:1' },
      { id: 'shape:arrow', type: 'arrow', parentId: 'page:1' },
    ].map((s) => [s.id, s]),
  )
  const lookup = (id: string) => shapes.get(id)

  it('board scope: any object except connectors, ink and groups', () => {
    const rule = { scope: 'board' as const, frameId: null, shapeTypes: null }
    expect(isVoteEligible('shape:a', lookup, rule)).toBe(true)
    expect(isVoteEligible('shape:frame', lookup, rule)).toBe(true)
    expect(isVoteEligible('shape:arrow', lookup, rule)).toBe(false)
    expect(isVoteEligible('shape:g', lookup, rule)).toBe(false)
    expect(isVoteEligible('shape:missing', lookup, rule)).toBe(false)
    expect(isVoteEligible('page:1', lookup, rule)).toBe(false)
  })

  it('frame scope follows the parent chain (through groups); the frame itself is out', () => {
    const rule = { scope: 'frame' as const, frameId: 'shape:frame', shapeTypes: null }
    expect(isVoteEligible('shape:a', lookup, rule)).toBe(true)
    expect(isVoteEligible('shape:b', lookup, rule)).toBe(true)
    expect(isVoteEligible('shape:c', lookup, rule)).toBe(false)
    expect(isVoteEligible('shape:frame', lookup, rule)).toBe(false)
  })

  it('type filter', () => {
    const rule = { scope: 'board' as const, frameId: null, shapeTypes: ['note'] }
    expect(isVoteEligible('shape:c', lookup, rule)).toBe(true)
    expect(isVoteEligible('shape:b', lookup, rule)).toBe(false)
  })

  it('a parent cycle cannot hang it', () => {
    const cyc = new Map<string, VoteShapeInfo>([
      ['shape:x', { id: 'shape:x', type: 'note', parentId: 'shape:y' }],
      ['shape:y', { id: 'shape:y', type: 'group', parentId: 'shape:x' }],
    ])
    expect(
      isVoteEligible('shape:x', (id) => cyc.get(id), {
        scope: 'frame',
        frameId: 'shape:z',
        shapeTypes: null,
      }),
    ).toBe(false)
  })
})

describe('results', () => {
  it('ranks with ties sharing a place; top 3 keeps everyone tied at the cut', () => {
    const r = rankVoteResults([
      { shapeId: 'shape:d', count: 1 },
      { shapeId: 'shape:a', count: 4 },
      { shapeId: 'shape:b', count: 2 },
      { shapeId: 'shape:c', count: 2 },
      { shapeId: 'shape:e', count: 2 },
      { shapeId: 'shape:z', count: 0 },
    ])
    expect(r.map((x) => [x.shapeId, x.rank])).toEqual([
      ['shape:a', 1],
      ['shape:b', 2],
      ['shape:c', 2],
      ['shape:e', 2],
      ['shape:d', 5],
    ])
    expect(topResults(r, 3).map((x) => x.shapeId)).toEqual(['shape:a', 'shape:b', 'shape:c', 'shape:e'])
    expect(topResults(r.slice(0, 2), 3)).toHaveLength(2)
  })

  it('labels come from the object text, frame name or type', () => {
    // Lines of a note stay apart in labels and the CSV (round-2 F17): "Book review slots · Owner: producer".
    expect(shapeLabel({ type: 'note', props: { richText: rt('Ship it', 'friday') } })).toBe(
      'Ship it · friday',
    )
    expect(shapeLabel({ type: 'note', props: { richText: rt('One', '', '  ', 'Two') } })).toBe('One · Two')
    const broken = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Book review slots' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Owner: producer' },
          ],
        },
      ],
    }
    expect(plainTextFromRichText(broken)).toBe('Book review slots · Owner: producer')
    const list = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: ['a', 'b'].map((t) => ({
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
          })),
        },
      ],
    }
    expect(plainTextFromRichText(list)).toBe('a · b')
    expect(shapeLabel({ type: 'frame', props: { name: 'Ideas' } })).toBe('Ideas')
    expect(shapeLabel({ type: 'dr-file-card', props: { name: 'deck.pdf' } })).toBe('deck.pdf')
    expect(shapeLabel({ type: 'image', props: {} })).toBe('Untitled image')
    expect(shapeLabel(undefined)).toBe('Deleted object')
    expect(plainTextFromRichText({ content: 'not an array' })).toBe('')
    expect(shapeLabel({ type: 'note', props: { richText: rt('x'.repeat(300)) } })).toHaveLength(140)
  })

  it('CSV export quotes and neutralizes spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell(' +1')).toBe("' +1")
    expect(csvCell('@me')).toBe("'@me")
    expect(csvCell('a,b')).toBe('"a,b"')
    const csv = resultsCsv([{ shapeId: 'shape:a', count: 3, rank: 1 }], () => ({
      type: 'Sticky note',
      label: '-2 ideas',
    }))
    expect(csv).toBe("Rank,Votes,Object type,Text,Object id\r\n1,3,Sticky note,'-2 ideas,shape:a\r\n")
  })
})

describe('what a click while voting does (W5-03)', () => {
  it('the topmost object decides: it gets the vote, or nothing is cast', () => {
    const inVote = (id: string) => id.startsWith('shape:in')
    expect(voteClick('shape:in1', inVote)).toEqual({ kind: 'vote', target: 'shape:in1' })
    expect(voteClick('shape:out', inVote)).toEqual({ kind: 'not-in-vote', target: 'shape:out' })
    expect(voteClick(undefined, inVote)).toEqual({ kind: 'none' })
    expect(voteClick(null, inVote)).toEqual({ kind: 'none' })
  })

  it('says what the vote takes', () => {
    const notes = ['note']
    expect(notInVoteText({ scope: 'frame', shapeTypes: notes }, 'Ideas')).toBe(
      'Not part of this vote: only sticky notes in “Ideas” take votes.',
    )
    expect(notInVoteText({ scope: 'frame', shapeTypes: null }, '  ')).toBe(
      'Not part of this vote: only objects in “the frame” take votes.',
    )
    expect(notInVoteText({ scope: 'board', shapeTypes: notes }, null)).toBe(
      'Not part of this vote: only sticky notes take votes.',
    )
    expect(notInVoteText({ scope: 'board', shapeTypes: ['note', 'geo'] }, null)).toBe(
      'Not part of this vote.',
    )
  })
})

describe('optimistic ballot', () => {
  it('adds pending casts to the server ballot and never goes negative', () => {
    const v = { myVotes: { 'shape:a': 1 }, myRemaining: 2 }
    expect(
      optimisticBallot(v, [
        { shapeId: 'shape:a', delta: 1 },
        { shapeId: 'shape:b', delta: 1 },
      ]),
    ).toEqual({ myVotes: { 'shape:a': 2, 'shape:b': 1 }, myRemaining: 0 })
    expect(optimisticBallot(v, [{ shapeId: 'shape:a', delta: -1 }])).toEqual({ myVotes: {}, myRemaining: 3 })
    expect(optimisticBallot(v, [{ shapeId: 'shape:x', delta: -1 }])).toEqual(v)
  })

  it('refuses locally what the server would refuse', () => {
    expect(localCastCheck({ myVotes: {}, myRemaining: 0 }, 'shape:a', 1, false).ok).toBe(false)
    expect(localCastCheck({ myVotes: { 'shape:a': 1 }, myRemaining: 2 }, 'shape:a', 1, true).ok).toBe(false)
    expect(localCastCheck({ myVotes: { 'shape:a': 1 }, myRemaining: 2 }, 'shape:a', 1, false).ok).toBe(true)
    expect(localCastCheck({ myVotes: {}, myRemaining: 2 }, 'shape:a', -1, false).ok).toBe(false)
  })
})

describe('gather everyone', () => {
  const me = 'usr_me0000000001'
  it('everyone but the summoner follows; "bring one person" only moves that person', () => {
    expect(summonApplies({ userId: 'usr_boss000000001', name: 'B', targetUserId: null }, me)).toBe(true)
    expect(summonApplies({ userId: me, name: 'Me', targetUserId: null }, me)).toBe(false)
    expect(summonApplies({ userId: 'usr_boss000000001', name: 'B', targetUserId: me }, me)).toBe(true)
    expect(
      summonApplies({ userId: 'usr_boss000000001', name: 'B', targetUserId: 'usr_other00000001' }, me),
    ).toBe(false)
  })

  it('finds the summoner among collaborators by tldraw user id (latest tab wins)', () => {
    const collaborators = [
      { userId: 'user:usr_a0000000001', lastActivityTimestamp: 5 },
      { userId: 'user:usr_boss000000001', lastActivityTimestamp: 1 },
      { userId: 'user:usr_boss000000001', lastActivityTimestamp: 9 },
    ]
    expect(followIdFor(collaborators, 'usr_boss000000001')).toBe('user:usr_boss000000001')
    expect(followIdFor(collaborators, 'usr_gone000000001')).toBeNull()
  })

  it('a primary press on the canvas ends following; moves and other buttons do not', () => {
    expect(isCanvasPress({ type: 'pointer', name: 'pointer_down', button: 0 })).toBe(true)
    expect(isCanvasPress({ type: 'pointer', name: 'pointer_move', button: 0 })).toBe(false)
    expect(isCanvasPress({ type: 'pointer', name: 'pointer_down', button: 2 })).toBe(false)
    expect(isCanvasPress({ type: 'keyboard', name: 'key_down' })).toBe(false)
  })
})

describe('readingOrder', () => {
  const box = (id: string, x: number, y: number, w = 200, h = 200) => ({ id, x, y, w, h })
  it('reads rows top to bottom and each row left to right', () => {
    const items = [
      box('c', 520, 10),
      box('a', 0, 0),
      box('d', 0, 400),
      box('b', 260, -30),
      box('e', 300, 420),
    ]
    expect(readingOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
  it('keeps objects of very different heights in separate rows unless their middles line up', () => {
    const items = [
      box('tall', 0, 0, 100, 600),
      box('low', 200, 450, 100, 100),
      box('mid', 400, 250, 100, 100),
    ]
    expect(readingOrder(items).map((i) => i.id)).toEqual(['tall', 'mid', 'low'])
    expect(readingOrder([])).toEqual([])
  })
})

describe('result badges when zoomed out (round-2 F3)', () => {
  const at = (shapeId: string, x: number, y: number, rank: number, n: number) => ({ shapeId, x, y, rank, n })

  it('shrink with the zoom down to 60% of their size, and never grow past it', () => {
    expect(badgeScale(2)).toBe(1)
    expect(badgeScale(1)).toBe(1)
    expect(badgeScale(0.75)).toBe(0.75)
    expect(badgeScale(0.1)).toBe(0.6)
  })

  it('badges that would overlap become one group, best rank first; apart they stay single', () => {
    const apart = [at('a', 0, 0, 1, 3), at('b', 300, 0, 2, 1), at('c', 0, 300, 2, 1)]
    expect(clusterBadges(apart, 1).map((g) => g.members.map((m) => m.shapeId))).toEqual([['a'], ['b'], ['c']])
    // Zoomed out: the notes' corners are 20 px apart, closer than a badge is wide.
    const close = [
      at('c', 40, 10, 2, 1),
      at('a', 0, 0, 1, 3),
      at('b', 20, 0, 2, 1),
      at('far', 400, 400, 3, 1),
    ]
    const groups = clusterBadges(close, 0.6)
    expect(groups.map((g) => g.members.map((m) => m.shapeId))).toEqual([['a', 'b', 'c'], ['far']])
    // A group sits where its best-ranked badge would
    expect(groups[0]).toMatchObject({ x: 0, y: 0, votes: 5, best: 1 })
  })

  it('chains neighbours, so no two groups overlap', () => {
    const row = Array.from({ length: 6 }, (_, i) => at(`s${i}`, i * 30, 0, i + 1, 6 - i))
    const groups = clusterBadges(row, 0.6)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.members).toHaveLength(6)
  })
})

describe('facilitator progress wording (round-2 F17)', () => {
  it('says what is happening instead of "0 of 0 done · 0 votes cast"', () => {
    expect(describeProgress({ participants: 0, participantsDone: 0, totalVotesCast: 0 })).toBe(
      'Waiting for votes',
    )
    expect(describeProgress({ participants: 3, participantsDone: 1, totalVotesCast: 6 })).toBe(
      '1 of 3 done · 6 votes cast',
    )
    expect(describeProgress({ participants: 1, participantsDone: 0, totalVotesCast: 1 })).toBe(
      '0 of 1 done · 1 vote cast',
    )
  })
})
