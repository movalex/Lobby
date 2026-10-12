// Words the AI feature puts on screen and on the board (pure: unit-tested in copy.test.ts).

import type { AiActionItem } from '@draftroom/contracts'

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** `text` cut to `max` characters (code points) with an ellipsis. */
export function cut(text: string, max: number): string {
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

/**
 * An action item as a sticky note: the task, then "Owner: Sam" when the board named someone, and (wave L, L2-4:
 * vote-weighted items) "3 votes" when the run followed a revealed vote.
 */
export function actionItemText(item: AiActionItem): string {
  const lines = [item.text]
  if (item.owner) lines.push(`Owner: ${item.owner}`)
  if (item.votes !== undefined) lines.push(plural(item.votes, 'vote'))
  return lines.join('\n')
}

/** The preview's count line for Group into themes (L2-1b): "Moves 23 notes into 5 themes". */
export function themesPreviewLine(p: { notes: number; themes: number; grows: boolean }): string {
  const line = `Moves ${plural(p.notes, 'note')} into ${plural(p.themes, 'theme')}`
  return p.grows ? `${line}; the frame grows to fit` : line
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

// ---- mind maps (K7) ------------------------------------------------------------------------------------

/** "the topic “Channels”": what an Expand with AI request is about (the topic's words, cut at 30). */
export const topicLabel = (text: string) => `the topic “${cut(text.replace(/\s+/g, ' ').trim(), 30)}”`

export const EXPAND_EMPTY = 'Type some words into the topic first, then expand it.'
export const EXPAND_GONE = 'That topic is gone, so there is nothing to expand.'
export const MINDMAP_FAILED = 'Lobby couldn’t add the mind map to the board. Try again.'

/** The toast after Expand with AI: "Added 5 sub-topics." */
export const expandDone = (n: number) => `Added ${plural(n, 'sub-topic')}.`

/** The toast after Mind map from a prompt: "Drafted a mind map with 6 branches." */
export const mindmapDone = (branches: number) =>
  `Drafted a mind map with ${plural(branches, 'branch', 'branches')}.`

// ---- Capture the room (wave N, WS5) ----------------------------------------------------------------------------

/**
 * N5-5: the notices of Capture the room, in the owner's words: shown on a person's first photo or transcript
 * capture (a Continue, no checkbox) and always in the dialog's footer.
 */
export const CAPTURE_PHOTO_NOTICE =
  'Sends this photo to OpenAI to read the notes or diagram. Lobby doesn’t keep the photo unless you add it to the board.'
export const CAPTURE_TRANSCRIPT_NOTICE =
  'Sends this transcript’s text to OpenAI. Lobby doesn’t keep the transcript; only the notes you apply are saved.'

/** "7 photo captures left today" (the api's answer; nothing before the first one). */
export const photosLeftLine = (n: number) => `${plural(n, 'photo capture')} left today`
export const transcriptsLeftLine = (n: number) => `${plural(n, 'transcript capture')} left today`

/** The length meter: "12,345 / 60,000 characters". */
export const lengthMeter = (n: number, max: number) =>
  `${n.toLocaleString('en-US')} / ${max.toLocaleString('en-US')} characters`

/** Past the limit: "Only the first 60,000 characters will be used." */
export const truncationNotice = (max: number) =>
  `Only the first ${max.toLocaleString('en-US')} characters will be used.`

/** The preview's count line for notes from a photo: "Adds 6 notes in 2 groups" ("…; the groups become frames"). */
export function captureNotesLine(p: { notes: number; groups: number; frames: number }): string {
  const groups = p.groups ? ` in ${plural(p.groups, 'group')}` : ''
  const frames = p.frames
    ? `; ${p.frames === p.groups ? 'each group is a frame' : plural(p.frames, 'frame')}`
    : ''
  return `Adds ${plural(p.notes, 'note')}${groups}${frames}`
}

/** The preview's count line for a meeting: "Adds 3 themes (5 notes), 2 decisions and 3 actions". */
export function captureMeetingLine(p: {
  themes: number
  notes: number
  decisions: number
  actions: number
}): string {
  return `Adds ${plural(p.themes, 'theme')} (${plural(p.notes, 'note')}), ${plural(p.decisions, 'decision')} and ${plural(p.actions, 'action')}`
}

/** An action as its sticky note says it: "Ana: Book the studio" (plain text; the owner is a name, never a user). */
export const captureActionText = (a: { text: string; owner?: string }) =>
  a.owner ? `${a.owner}: ${a.text}` : a.text

/** The meeting frame's name: "Meeting — Launch sync", else "Meeting — 11 Oct 2026". */
export function meetingFrameName(title: string | undefined, at: Date): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  if (t) return `Meeting — ${cut(t, 80)}`
  const date = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return `Meeting — ${date}`
}

/** Said when nothing was found to add. */
export const CAPTURE_NOTHING = {
  notes: 'Lobby found no sticky notes it could read in this photo. Try a sharper photo, closer to the wall.',
  diagram: 'Lobby found no diagram in this photo: it needs two or more boxes with words.',
  transcript: 'Lobby found nothing to add from this transcript.',
} as const
