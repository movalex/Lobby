// The feedback schemas (wave J5): what the web sends, what the inbox and the internal read answer.
import { describe, expect, it } from 'vitest'
import {
  FEEDBACK_INTERNAL_LIMIT,
  FEEDBACK_LIST_LIMIT,
  FEEDBACK_PER_PERSON,
  FEEDBACK_TEXT_MAX,
  FEEDBACK_WIRE_MAX,
  FeedbackContext,
  FeedbackId,
  FeedbackInput,
  FeedbackInternalItem,
  FeedbackInternalQuery,
  FeedbackItem,
  FeedbackListQuery,
  FeedbackPatch,
  feedbackItemPath,
} from './feedback.ts'

const CONTEXT = {
  path: '/b/b-abc1234567',
  boardId: 'b-abc1234567',
  boardTitle: 'Q4 plan',
  userAgent: 'Mozilla/5.0',
  viewport: { width: 1280, height: 720 },
  build: 'edf27c2',
  at: '2026-10-05T10:00:00.000Z',
}
const ITEM = {
  id: 'fbk_aaaaaaaaaaaaaaaaaaaa',
  createdAt: '2026-10-05T10:00:00.000Z',
  userId: 'usr_aaaaaaaaaaaa',
  name: 'Bob Chen',
  kind: 'account',
  text: 'It broke',
  expected: null,
  context: CONTEXT,
  status: 'open',
  statusAt: null,
}

describe('limits', () => {
  it('four thousand characters a field (twice that on the wire), ten an hour per person', () => {
    expect(FEEDBACK_TEXT_MAX).toBe(4_000)
    expect(FEEDBACK_WIRE_MAX).toBe(8_000)
    expect(FEEDBACK_PER_PERSON).toEqual({ max: 10, windowMs: 3_600_000 })
  })
})

describe('FeedbackInput', () => {
  it('takes text, an optional expectation and any context (the api reads it field by field)', () => {
    expect(FeedbackInput.parse({ text: 'x' })).toEqual({ text: 'x' })
    expect(FeedbackInput.parse({ text: 'x', expected: null, context: { anything: 1 } })).toEqual({
      text: 'x',
      expected: null,
      context: { anything: 1 },
    })
    expect(FeedbackInput.safeParse({}).success).toBe(false)
    expect(FeedbackInput.safeParse({ text: 7 }).success).toBe(false)
    expect(FeedbackInput.safeParse({ text: 'x'.repeat(FEEDBACK_WIRE_MAX + 1) }).success).toBe(false)
    expect(FeedbackInput.safeParse({ text: 'x', expected: 'e'.repeat(FEEDBACK_WIRE_MAX + 1) }).success).toBe(
      false,
    )
  })

  it('does not carry authorship: a user, name or kind in the body is dropped', () => {
    expect(
      Object.keys(FeedbackInput.parse({ text: 'x', userId: 'usr_x', name: 'N', kind: 'guest' })),
    ).toEqual(['text'])
  })
})

describe('FeedbackContext and the items', () => {
  it('a stored context parses; a bad board id or an oversized field does not', () => {
    expect(FeedbackContext.parse(CONTEXT)).toEqual(CONTEXT)
    expect(FeedbackContext.safeParse({ ...CONTEXT, boardId: 'NOT A BOARD' }).success).toBe(false)
    expect(FeedbackContext.safeParse({ ...CONTEXT, path: `/${'a'.repeat(250)}` }).success).toBe(false)
    expect(FeedbackContext.safeParse({ ...CONTEXT, viewport: { width: -1, height: 1 } }).success).toBe(false)
    expect(FeedbackContext.parse({ ...CONTEXT, boardId: null, boardTitle: null }).boardId).toBeNull()
  })

  it('an item, and the internal item without the display name', () => {
    expect(FeedbackItem.parse(ITEM)).toEqual(ITEM)
    const { name: _name, statusAt: _at, ...rest } = ITEM
    const internal = FeedbackInternalItem.parse({ ...rest, name: 'Bob Chen' })
    expect(Object.keys(internal)).not.toContain('name')
    expect(Object.keys(internal).sort()).toEqual(
      ['context', 'createdAt', 'expected', 'id', 'kind', 'status', 'text', 'userId'].sort(),
    )
  })

  it('ids look like fbk_ and 10 to 40 letters or digits', () => {
    expect(FeedbackId.safeParse('fbk_aaaaaaaaaaaaaaaaaaaa').success).toBe(true)
    for (const bad of [
      'fbk_short',
      'usr_aaaaaaaaaaaaaaaaaaaa',
      'fbk_aaaaaaaa-aaaaaaaaaaa',
      '',
      `fbk_${'a'.repeat(41)}`,
    ])
      expect(FeedbackId.safeParse(bad).success, bad).toBe(false)
    expect(feedbackItemPath('fbk_a/b')).toBe('/api/feedback/fbk_a%2Fb')
  })
})

describe('queries and the patch', () => {
  it('the inbox list: open by default, 50 a page, at most 200', () => {
    expect(FeedbackListQuery.parse({})).toEqual({ status: 'open', limit: FEEDBACK_LIST_LIMIT.default })
    expect(FeedbackListQuery.parse({ status: 'all', limit: '20', cursor: 'abc' })).toEqual({
      status: 'all',
      limit: 20,
      cursor: 'abc',
    })
    for (const bad of [
      { status: 'x' },
      { limit: '0' },
      { limit: '201' },
      { limit: 'many' },
      { cursor: 'c'.repeat(201) },
    ])
      expect(FeedbackListQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })

  it('the internal read: open by default, 200 a page, at most 500', () => {
    expect(FeedbackInternalQuery.parse({})).toEqual({
      status: 'open',
      limit: FEEDBACK_INTERNAL_LIMIT.default,
    })
    expect(FeedbackInternalQuery.safeParse({ limit: '500' }).success).toBe(true)
    expect(FeedbackInternalQuery.safeParse({ limit: '501' }).success).toBe(false)
  })

  it('the patch is a status: open or done', () => {
    expect(FeedbackPatch.parse({ status: 'done' })).toEqual({ status: 'done' })
    expect(FeedbackPatch.safeParse({ status: 'all' }).success).toBe(false)
    expect(FeedbackPatch.safeParse({}).success).toBe(false)
  })
})
