// OWNER: WS4 (wave S, the review summary PDF). What the summary prints, as plain text (docs/WAVE-S-CONTRACTS.md §6):
// the contracts' ReviewSummaryModel built from the review answer, each item's status history, the board's comment
// threads and the versions. No DOM, no PDF library: unit-tested in Node. The layout (./layout.ts) and the PDF
// (./build.ts) only read this.
//
// Rules:
//  - the items are the ones the review page lists, in its order (the open round's, else every live item);
//  - who did what is always `reviewActorLabel` (a guest is its typed name + " (guest)", an outside account
//    "Name · External"); a comment's author already carries "(guest)" in its name (users.name) and gets the
//    "External" tag from the server's own flag;
//  - every OPEN thread of an item is printed with all its replies; resolved threads are counted, not printed; a
//    team-only thread never is (a file made for a client must not carry one by accident);
//  - the guest footnote (REVIEW_GUEST_FOOTNOTE) appears whenever a guest does anywhere in it.
import {
  type CommentThread,
  commentPlainText,
  GUEST_NAME_SUFFIX,
  REVIEW_GUEST_FOOTNOTE,
  REVIEW_STATUS_LABELS,
  REVIEW_SUMMARY,
  type ReviewEvent,
  type ReviewItem,
  type ReviewRound,
  type ReviewSummaryModel,
  reviewActorLabel,
  reviewCounts,
  reviewVersionLabel,
} from '@draftroom/contracts'

/** A comment is cut at this many characters in the summary (a thread is a summary line, not the whole discussion). */
export const SUMMARY_COMMENT_CHARS = 1500

const clip = (s: string, max: number) => {
  const chars = Array.from(s)
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : s
}

/** "Oct 14, 2026" from an ISO time (en-US, like the comments appendix). */
export const defaultDate = (iso: string): string => {
  const t = Date.parse(iso)
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : ''
}

/** "Oct 14, 2026, 3:20 PM" from an ISO time. */
export const defaultDateTime = (iso: string): string => {
  const t = Date.parse(iso)
  return Number.isFinite(t)
    ? new Date(t).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''
}

/** One item the summary prints. */
export interface SummaryEntry {
  readonly item: ReviewItem
  /** the label the page shows */
  readonly label: string
  /** the versions of the file's asset, when the list is known: the position of the status version and how many */
  readonly version?: { readonly n: number; readonly of: number } | null
}

export interface SummaryInput {
  readonly boardTitle: string
  /** the open round's, else null (every live item) */
  readonly round: ReviewRound | null
  readonly entries: readonly SummaryEntry[]
  /** each item's events, newest first (GET …/events) */
  readonly events: ReadonlyMap<string, readonly ReviewEvent[]>
  /** the board's threads as this person may see them (the server already filtered them) */
  readonly threads: readonly CommentThread[]
  /** the threads that belong to an item (review-page/model.ts threadsFor; open ones, none team-only) */
  readonly threadsOf: (entry: SummaryEntry) => readonly CommentThread[]
  /** how many resolved threads the item has */
  readonly resolvedOf: (entry: SummaryEntry) => number
  readonly generatedBy: string
  readonly now: Date
  readonly formatDate?: (iso: string) => string
  readonly formatDateTime?: (iso: string) => string
}

/** A comment author as the summary names it: the name as stored (it carries "(guest)"), plus the outside tag. */
function commentAuthor(c: CommentThread['comments'][number]): string {
  const name = c.author.name.trim() || 'Someone'
  return c.author.external ? `${name} · External` : name
}

const isGuestName = (name: string) => name.trimEnd().endsWith(GUEST_NAME_SUFFIX.trim())

/** One history row as text: "Oct 14, 2026, 3:20 PM · Ana (guest) approved". */
export function eventText(e: ReviewEvent, when: (iso: string) => string): string {
  const who = reviewActorLabel(e.actor)
  const at = when(e.createdAt)
  const lead = at ? `${at} · ` : ''
  switch (e.kind) {
    case 'status': {
      const status = e.status ? REVIEW_STATUS_LABELS[e.status] : 'Status changed'
      if (e.reason === 'new_version')
        return `${lead}Back to awaiting review: a new version was uploaded by ${who}`
      if (e.reason === 'new_round') return `${lead}Back to awaiting review: a new round started by ${who}`
      return `${lead}${who}: ${status}`
    }
    case 'added':
      return `${lead}Added to review by ${who}`
    case 'removed':
      return `${lead}Removed from review by ${who}`
    case 'round_opened':
      return `${lead}Round opened by ${who}`
    case 'round_closed':
      return `${lead}Round closed by ${who}`
  }
}

/** The summary's text model for the entries (REVIEW_SUMMARY.historyRows history rows each). */
export function buildSummaryModel(input: SummaryInput): ReviewSummaryModel {
  const date = input.formatDate ?? defaultDate
  const dateTime = input.formatDateTime ?? defaultDateTime
  let guest = false
  const noteGuest = (kind: 'account' | 'guest' | undefined, name?: string) => {
    if (kind === 'guest' || (name !== undefined && isGuestName(name))) guest = true
  }

  const items: ReviewSummaryModel['items'][number][] = input.entries.map((entry) => {
    const { item } = entry
    if (item.statusBy) noteGuest(item.statusBy.kind)
    const history = (input.events.get(item.id) ?? []).slice(0, REVIEW_SUMMARY.historyRows).map((e) => {
      noteGuest(e.actor.kind)
      return eventText(e, dateTime)
    })
    const threads = input.threadsOf(entry).map((t) => {
      const comments = t.comments.map((c) => {
        noteGuest(undefined, c.author.name)
        const when = date(c.createdAt)
        const text = clip(commentPlainText(c.body).trim(), SUMMARY_COMMENT_CHARS)
        return `${commentAuthor(c)}${when ? `, ${when}` : ''}: ${text}`
      })
      const first = t.comments[0]
      return { author: first ? commentAuthor(first) : 'Someone', lines: comments }
    })
    return {
      label: entry.label,
      status: item.status,
      by: item.statusBy ? reviewActorLabel(item.statusBy) : null,
      at: item.statusAt,
      version:
        item.kind === 'file' && entry.version ? reviewVersionLabel(entry.version.n, entry.version.of) : null,
      history,
      threads,
      resolvedThreads: input.resolvedOf(entry),
    }
  })

  return {
    cover: {
      boardTitle: input.boardTitle,
      roundTitle: input.round?.title ?? null,
      openedAt: input.round?.openedAt ?? null,
      closedAt: input.round?.closedAt ?? null,
      counts: reviewCounts(input.entries.map((e) => e.item)),
      generatedBy: input.generatedBy,
      generatedAt: input.now.toISOString(),
    },
    items,
    footnote: guest ? REVIEW_GUEST_FOOTNOTE : null,
  }
}
