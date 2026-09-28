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

/** The "Group into themes" line in the AI menu: how many notes move, and which stay (R9). */
export function themesHint(notes: number, prompts: number): string {
  if (notes < 2) return 'Needs two or more sticky notes'
  return prompts
    ? `Sorts ${notes} notes; ${plural(prompts, 'prompt note')} stay put`
    : `Sorts ${notes} notes into labelled groups`
}

/** Asked before regrouping notes that already sit in groups (DANA-10): "Gameplay, Story and Community". */
export function groupNames(groups: readonly string[]): string {
  const shown = groups.slice(0, 3).map((g) => `“${cut(g, 24)}”`)
  const more = groups.length - shown.length
  if (more > 0) return `${shown.join(', ')} and ${more} more`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : (shown[0] ?? '')
}

/** "Grouped 8 notes into 3 themes." plus what else happened. */
export function themesDone(out: {
  moved: number
  themes: number
  grew: boolean
  skipped: number
  prompts?: number
}): string {
  const extra = [
    out.grew ? 'The frame grew to fit.' : '',
    out.skipped ? `${plural(out.skipped, 'note')} stayed where they were.` : '',
    out.prompts ? `The ${plural(out.prompts, 'prompt note')} stayed where they were.` : '',
  ].filter(Boolean)
  return [`Grouped ${plural(out.moved, 'note')} into ${plural(out.themes, 'theme')}.`, ...extra].join(' ')
}
