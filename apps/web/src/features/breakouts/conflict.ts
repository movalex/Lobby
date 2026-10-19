// Wave V fix wave (review n4). While breakouts run, the api refuses to start a presentation to everyone or a spotlight
// (409 BREAKOUTS: its follow would pull every group out of its frame). This is what the person who pressed it is told:
// "End breakouts first", with an End breakouts button when this page runs the breakouts feature (the api decides
// whether they may end them; a refusal is said in words).
import { BREAKOUT_ERROR_CODES } from '@draftroom/contracts'
import type { NoticeInput } from '../../board/board-context.ts'
import { breakoutStoreOf } from './store.ts'

export const END_BREAKOUTS_FIRST = 'End breakouts first: they are running on this board.'

/** Whether an api refusal is the breakouts conflict. */
export const isBreakoutsConflict = (code: string | undefined): boolean =>
  code === BREAKOUT_ERROR_CODES.breakouts

/**
 * Tells this person to end breakouts first, under the notice `key`, with an End breakouts button (when the breakouts
 * store is on this page). Returns whether `code` was the breakouts conflict (then nothing else needs saying).
 */
export function noticeEndBreakoutsFirst(
  ctx: { canvas: object; notify(n: NoticeInput): void },
  key: string,
  code: string | undefined,
): boolean {
  if (!isBreakoutsConflict(code)) return false
  const store = breakoutStoreOf(ctx.canvas)
  ctx.notify({
    key,
    text: END_BREAKOUTS_FIRST,
    testId: 'breakouts-conflict',
    timeoutMs: 10_000,
    ...(store
      ? {
          action: {
            label: 'End breakouts',
            testId: 'breakouts-conflict-end',
            onClick: () =>
              void store.end().then((out) => {
                if (!out.ok)
                  ctx.notify({
                    key,
                    text: out.message || 'The breakouts could not be ended.',
                    testId: 'breakouts-conflict',
                    timeoutMs: 6_000,
                  })
              }),
          },
        }
      : {}),
  })
  return true
}
