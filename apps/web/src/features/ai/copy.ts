// Words the AI feature puts on screen and on the board (pure: unit-tested in copy.test.ts).

import type { AiActionItem } from '@draftroom/contracts'

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function cut(text: string, max: number): string {
  const points = Array.from(text)
  return points.length > max
    ? `${points
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : text
}

/** The workspace owner's budget line, in the contract's words (docs/WAVE4-CONTRACTS.md §4). */
export const budgetLine = (usedPercent: number) => `AI budget used today: ${usedPercent}%`

/** "Ideas: names for the launch party" (the person's own prompt, cut at 60 characters). */
export function ideasHeading(prompt: string | undefined): string {
  const p = (prompt ?? '').replace(/\s+/g, ' ').trim()
  return p ? `Ideas: ${cut(p, 60)}` : 'Ideas'
}

/** An action item as a sticky note: the task, then "Owner: Sam" when the board named someone. */
export function actionItemText(item: AiActionItem): string {
  return item.owner ? `${item.text}\nOwner: ${item.owner}` : item.text
}

/** "Grouped 8 notes into 3 themes." plus what else happened. */
export function themesDone(out: { moved: number; themes: number; grew: boolean; skipped: number }): string {
  const extra = [
    out.grew ? 'The frame grew to fit.' : '',
    out.skipped ? `${plural(out.skipped, 'note')} stayed where they were.` : '',
  ].filter(Boolean)
  return [`Grouped ${plural(out.moved, 'note')} into ${plural(out.themes, 'theme')}.`, ...extra].join(' ')
}
