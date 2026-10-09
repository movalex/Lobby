// OWNER: W3 (wave L, L3-2). The command palette's ranking: a small in-house scorer (no dependency) over a
// label and its keywords. Pure.
//
// What scores, best first (each on accent- and case-folded words):
//   the whole label                         'lock'      → Lock
//   the label starts with the query         'dist'      → Distribute horizontally
//   every query word starts a label word, in order       'dist h'   → Distribute horizontally
//   the query is the label's initials (or their start)   'dh'       → Distribute horizontally
//   every query word starts some label word              'h dist'   → Distribute horizontally
//   the label contains the query            'lock'      → Unlock all
//   the query's letters in order, each word start a bonus (a fuzzy match)
// A keyword match counts a little less than the same match on the label. Nothing else matches (0).

/** Accent- and case-folded, punctuation as spaces, one space between words. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#%+]+/gu, ' ')
    .trim()
}

const wordsOf = (folded: string): string[] => (folded ? folded.split(' ') : [])

/** Every word of `query` starts a word of `words`, in that order (each a later word than the one before). */
function wordStartsInOrder(query: readonly string[], words: readonly string[]): boolean {
  let at = 0
  for (const q of query) {
    let found = false
    while (at < words.length) {
      if ((words[at++] as string).startsWith(q)) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

/** The query's characters appear in order in `text`; a hit on a word start scores more. 0 when they do not. */
function subsequence(query: string, text: string): number {
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of query) {
    if (ch === ' ') continue
    let found = -1
    while (ti < text.length) {
      if (text[ti] === ch) {
        found = ti
        ti++
        break
      }
      ti++
      streak = 0
    }
    if (found < 0) return 0
    const wordStart = found === 0 || text[found - 1] === ' '
    streak++
    score += (wordStart ? 6 : 1) + Math.min(streak, 4)
  }
  return score
}

/** One text's score for an already folded query (0: no match). */
export function scoreText(query: string, text: string): number {
  const q = query
  const t = fold(text)
  if (!q) return 1
  if (!t) return 0
  if (t === q) return 1000
  if (t.startsWith(q)) return 900 - Math.min(80, t.length - q.length)
  const qw = wordsOf(q)
  const tw = wordsOf(t)
  if (qw.length > 1 && wordStartsInOrder(qw, tw)) return 820 - Math.min(60, tw.length * 4)
  const initials = tw.map((w) => w[0]).join('')
  const compact = q.replace(/ /g, '')
  if (compact.length >= 2 && initials.startsWith(compact)) return 780 - Math.min(60, initials.length * 4)
  if (qw.length === 1 && tw.some((w) => w.startsWith(q))) return 760 - Math.min(60, tw.length * 4)
  if (qw.length > 1 && qw.every((w) => tw.some((x) => x.startsWith(w)))) return 700
  if (compact.length >= 2 && initials.includes(compact)) return 650
  if (t.includes(q)) return 600 - Math.min(80, t.indexOf(q))
  const fuzzy = subsequence(compact, t)
  // a fuzzy match must carry its weight: at least a couple of word starts or a run of letters
  return fuzzy >= compact.length * 3 ? Math.min(500, 100 + fuzzy * 4) : 0
}

/** A label's score with its keywords (a keyword counts a little less than the label). */
export function scoreEntry(query: string, label: string, keywords: readonly string[] = []): number {
  const q = fold(query)
  let best = scoreText(q, label)
  for (const k of keywords) best = Math.max(best, Math.round(scoreText(q, k) * 0.9))
  return best
}

/** How much a recent use lifts an entry: the latest the most, fading over the list. */
export function recentBoost(rank: number): number {
  return rank < 0 ? 0 : Math.max(0, 160 - rank * 12)
}

export interface Rankable {
  readonly label: string
  readonly keywords?: readonly string[]
  /** the key a recent use is kept under (no key: never boosted) */
  readonly recentKey?: string
  /** a fixed score that wins over matching (the parsed "Do" line) */
  readonly pinned?: number
}

/**
 * The matches of `query`, best first: the score plus the recents boost (`recents`: keys, most recent first).
 * With an empty query: the recent entries first (most recent first), then the rest in their given order.
 */
export function rank<T extends Rankable>(
  entries: readonly T[],
  query: string,
  recents: readonly string[] = [],
): T[] {
  const rec = new Map(recents.map((k, i) => [k, i]))
  const q = fold(query)
  const scored: { e: T; s: number; i: number }[] = []
  entries.forEach((e, i) => {
    const r = e.recentKey ? (rec.get(e.recentKey) ?? -1) : -1
    if (!q) {
      scored.push({ e, s: e.pinned ?? (r >= 0 ? 10_000 - r : 0), i })
      return
    }
    if (e.pinned !== undefined) {
      scored.push({ e, s: e.pinned, i })
      return
    }
    const s = scoreEntry(q, e.label, e.keywords)
    if (s > 0) scored.push({ e, s: s + recentBoost(r), i })
  })
  scored.sort((a, b) => b.s - a.s || (q ? a.e.label.length - b.e.label.length : 0) || a.i - b.i)
  return scored.map((x) => x.e)
}
