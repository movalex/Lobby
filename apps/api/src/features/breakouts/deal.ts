// OWNER: WS4 (wave V, breakouts). Who goes to which group (pure; docs/WAVE-V-CONTRACTS.md §4.1):
//   - `auto` and Shuffle: everyone to deal, shuffled, then round robin over the groups in order, so the groups differ
//     by at most one person;
//   - a late joiner (auto mode) and anyone else placed one at a time: the smallest group, the first in order on a tie.

/** A Fisher-Yates shuffle (a copy); `rand` returns [0, 1) and is injected in tests. */
export function shuffled<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

/** Deals `userIds` (each once, in a shuffled order) round robin over `groupIds`: user → group. */
export function deal(
  userIds: readonly string[],
  groupIds: readonly string[],
  rand: () => number = Math.random,
): Map<string, string> {
  const out = new Map<string, string>()
  if (groupIds.length === 0) return out
  const people = shuffled([...new Set(userIds)], rand)
  people.forEach((u, i) => {
    out.set(u, groupIds[i % groupIds.length] as string)
  })
  return out
}

/** The group with the fewest members (`counts`: group → members; a missing group has none); the first on a tie. */
export function smallestGroup(
  groupIds: readonly string[],
  counts: ReadonlyMap<string, number>,
): string | null {
  let best: string | null = null
  let fewest = Number.POSITIVE_INFINITY
  for (const g of groupIds) {
    const n = counts.get(g) ?? 0
    if (n < fewest) {
      best = g
      fewest = n
    }
  }
  return best
}
