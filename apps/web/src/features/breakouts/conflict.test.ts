// Wave V fix wave (review n4): a presentation or spotlight refused with 409 BREAKOUTS says "End breakouts first",
// with an End breakouts button that ends them through this page's breakouts store (the api decides).
import { describe, expect, it } from 'vitest'
import type { NoticeInput } from '../../board/board-context.ts'
import { END_BREAKOUTS_FIRST, isBreakoutsConflict, noticeEndBreakoutsFirst } from './conflict.ts'
import { type BreakoutStore, setBreakoutStore } from './store.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

function page(end?: () => Promise<{ ok: boolean; message?: string }>) {
  const canvas = {}
  const notices: NoticeInput[] = []
  let ended = 0
  if (end)
    setBreakoutStore(canvas, {
      end: () => {
        ended++
        return end()
      },
    } as unknown as BreakoutStore)
  return { ctx: { canvas, notify: (n: NoticeInput) => notices.push(n) }, notices, ended: () => ended }
}

describe('End breakouts first', () => {
  it('only the BREAKOUTS refusal is this notice; anything else is left to the caller', () => {
    expect(isBreakoutsConflict('BREAKOUTS')).toBe(true)
    for (const code of ['BREAKOUTS_RUNNING', 'PRESENTING', 'FORBIDDEN', undefined])
      expect(isBreakoutsConflict(code)).toBe(false)
    const p = page(async () => ({ ok: true }))
    expect(noticeEndBreakoutsFirst(p.ctx, 'present-live', 'ALREADY_PRESENTING')).toBe(false)
    expect(p.notices).toEqual([])
  })

  it('says it with an End breakouts button that ends them; a refused end is said in words', async () => {
    const p = page(async () => ({ ok: true }))
    expect(noticeEndBreakoutsFirst(p.ctx, 'present-live', 'BREAKOUTS')).toBe(true)
    expect(p.notices[0]).toMatchObject({
      key: 'present-live',
      text: END_BREAKOUTS_FIRST,
      testId: 'breakouts-conflict',
      action: { label: 'End breakouts', testId: 'breakouts-conflict-end' },
    })
    p.notices[0]?.action?.onClick()
    await tick()
    expect(p.ended()).toBe(1)
    expect(p.notices).toHaveLength(1)
    const refused = page(async () => ({
      ok: false,
      message: 'Only the person who started these breakouts can.',
    }))
    noticeEndBreakoutsFirst(refused.ctx, 'spotlight', 'BREAKOUTS')
    refused.notices[0]?.action?.onClick()
    await tick()
    expect(refused.notices.at(-1)).toMatchObject({
      key: 'spotlight',
      text: 'Only the person who started these breakouts can.',
    })
  })

  it('without the breakouts feature on this page: the words, no button', () => {
    const p = page()
    expect(noticeEndBreakoutsFirst(p.ctx, 'spotlight', 'BREAKOUTS')).toBe(true)
    expect(p.notices[0]?.text).toBe(END_BREAKOUTS_FIRST)
    expect(p.notices[0]?.action).toBeUndefined()
  })
})
