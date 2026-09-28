/**
 * Index pre-pass (plan D5, §2.5.4, §2.5.5 E2/E3): runs on the final element array before every
 * `updateScene`.
 *
 * Why: `updateScene` → `Scene.replaceAllElements` → `syncInvalidIndices` (element `index.js:12724`,
 * `19079-19085`) re-keys, *in place and with a version bump*, every element whose `index` is not strictly
 * between its array neighbours. When two people create at the same end of the order, the colliding
 * element may be someone else's confirmed element: its version changes locally and the engine would
 * push it back (an echo). The pre-pass removes every collision first, by re-keying only this client's
 * own **unacknowledged** elements, strictly between their confirmed neighbours. Confirmed elements are
 * never touched: the server guarantees unique keys and label-after-container order (§2.4.3 step 11).
 *
 * Deleted elements take part: they are in the array `updateScene` gets, so a collision with a
 * tombstone would be re-keyed too.
 *
 * Pure: no Excalidraw state, only `@excalidraw/fractional-indexing` (the generator Excalidraw uses).
 */
import { generateKeyBetween, generateNKeysBetween, validateOrderKey } from '@excalidraw/fractional-indexing'

export interface IndexedElement {
  readonly id: string
  readonly type: string
  readonly index: string | null
  readonly version: number
  readonly isDeleted: boolean
  readonly containerId?: string | null
  readonly boundElements?: readonly { readonly id: string; readonly type: string }[] | null
}

export type ReKeyReason = 'collision' | 'invalid' | 'label-order'

export interface ReKey {
  id: string
  from: string | null
  to: string
  reason: ReKeyReason
  /** the element's push was already sent: the re-key stays local, the server assigns its own `fix` */
  inFlight: boolean
}

export interface PrePassOptions<T extends IndexedElement> {
  /** this client's own elements the server has not acknowledged yet (not sent or in flight) */
  isOwnUnacked: (el: T) => boolean
  /** own unacknowledged elements whose push is already in flight */
  isInFlight?: (el: T) => boolean
  /** makes the re-keyed copy (default: a spread with the new `index`, no version change) */
  withIndex?: (el: T, index: string) => T
}

export interface PrePassResult<T extends IndexedElement> {
  /** the array to install, in (index, id) order, with every index valid and unique */
  elements: T[]
  rekeys: ReKey[]
  /** confirmed elements whose keys are invalid or collide with another confirmed element: a server
   *  invariant is broken; the pre-pass cannot fix it without touching them (the engine resyncs) */
  confirmedConflicts: string[]
}

export const isValidKey = (key: string | null | undefined): key is string => {
  if (!key) return false
  try {
    validateOrderKey(key)
    return true
  } catch {
    return false
  }
}

/** Excalidraw's comparator (`orderByFractionalIndex`, element `index.js:12686-12697`). */
export const compareIndexThenId = (a: IndexedElement, b: IndexedElement) => {
  const ai = a.index ?? ''
  const bi = b.index ?? ''
  if (ai !== bi) return ai < bi ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const TOP = '￿'

export const indexPrePass = <T extends IndexedElement>(
  input: readonly T[],
  opts: PrePassOptions<T>,
): PrePassResult<T> => {
  const withIndex = opts.withIndex ?? ((el: T, index: string) => ({ ...el, index }) as T)
  const own = new Set<string>()
  for (const el of input) if (opts.isOwnUnacked(el)) own.add(el.id)

  // 1. merged order: by effective key; a confirmed element sorts before an own one with the same key,
  //    and an own element without a valid key goes to the top (it was being added there)
  const eff = (el: T) => (isValidKey(el.index) ? el.index : own.has(el.id) ? TOP : '')
  const merged = [...input].sort((a, b) => {
    const ka = eff(a)
    const kb = eff(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    const oa = own.has(a.id) ? 1 : 0
    const ob = own.has(b.id) ? 1 : 0
    if (oa !== ob) return oa - ob
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const confirmedConflicts: string[] = []
  const keys = new Map<string, string>() // id -> final key
  const reasons = new Map<string, ReKeyReason>()
  let prev: string | null = null
  let i = 0
  while (i < merged.length) {
    const el = merged[i] as T
    if (!own.has(el.id)) {
      const k = el.index
      if (!isValidKey(k) || (prev !== null && k <= prev)) confirmedConflicts.push(el.id)
      else prev = k
      if (isValidKey(k)) keys.set(el.id, k)
      i++
      continue
    }
    // a run of own elements up to the next confirmed one
    let j = i
    while (j < merged.length && own.has((merged[j] as T).id)) j++
    const hiEl = merged[j] as T | undefined
    const hi = hiEl && isValidKey(hiEl.index) ? hiEl.index : null
    const run = merged.slice(i, j)
    // keep an own key when it is valid and strictly increasing inside (prev, hi)
    const keep: boolean[] = []
    let p = prev
    for (const e of run) {
      const k = e.index
      const ok = isValidKey(k) && (p === null || k > p) && (hi === null || k < hi)
      keep.push(ok)
      if (ok) p = k
      else reasons.set(e.id, isValidKey(k) ? 'collision' : 'invalid')
    }
    // assign the dropped ones between their kept neighbours
    let lo = prev
    let r = 0
    while (r < run.length) {
      if (keep[r]) {
        lo = (run[r] as T).index
        keys.set((run[r] as T).id, lo as string)
        r++
        continue
      }
      let s = r
      while (s < run.length && !keep[s]) s++
      const upper = s < run.length ? (run[s] as T).index : hi
      const fresh = generateNKeysBetween(lo, upper, s - r)
      for (let q = r; q < s; q++) keys.set((run[q] as T).id, fresh[q - r] as string)
      lo = fresh[fresh.length - 1] ?? lo
      r = s
    }
    prev = lo
    i = j
  }

  // 2. label order (E3): an own live label must sort after its live container
  const byId = new Map(input.map((el) => [el.id, el]))
  let order = [...input].sort((a, b) => {
    const ka = keys.get(a.id) ?? ''
    const kb = keys.get(b.id) ?? ''
    if (ka !== kb) return ka < kb ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  for (const label of input) {
    if (!own.has(label.id) || label.type !== 'text' || !label.containerId || label.isDeleted) continue
    const container = byId.get(label.containerId)
    if (!container || container.isDeleted) continue
    const lk = keys.get(label.id)
    const ck = keys.get(container.id)
    if (!lk || !ck || lk > ck) continue
    order = order.filter((e) => e.id !== label.id)
    const at = order.findIndex((e) => e.id === container.id)
    const next = order[at + 1]
    const nk = next ? (keys.get(next.id) ?? null) : null
    keys.set(label.id, generateKeyBetween(ck, nk))
    reasons.set(label.id, 'label-order')
    order.splice(at + 1, 0, label)
  }

  const rekeys: ReKey[] = []
  const elements = order.map((el) => {
    const k = keys.get(el.id)
    if (!own.has(el.id) || k === undefined || k === el.index) return el
    rekeys.push({
      id: el.id,
      from: el.index,
      to: k,
      reason: reasons.get(el.id) ?? 'collision',
      inFlight: opts.isInFlight?.(el) ?? false,
    })
    return withIndex(el, k)
  })
  return { elements, rekeys, confirmedConflicts }
}

export interface VersionStamp {
  version: number
  versionNonce?: number
}

/** Versions of the confirmed elements handed to `updateScene`, for the dev assertion. */
export const confirmedVersions = <T extends IndexedElement & { versionNonce?: number }>(
  elements: readonly T[],
  isConfirmed: (el: T) => boolean,
): Map<string, VersionStamp> => {
  const out = new Map<string, VersionStamp>()
  for (const el of elements)
    if (isConfirmed(el)) out.set(el.id, { version: el.version, versionNonce: el.versionNonce })
  return out
}

export interface VersionChange {
  id: string
  from: number
  to: number
}

/** Confirmed elements whose version changed between the array given to `updateScene` and the scene after. */
export const confirmedVersionChanges = (
  before: ReadonlyMap<string, VersionStamp>,
  after: readonly (IndexedElement & { versionNonce?: number })[],
): VersionChange[] => {
  const changes: VersionChange[] = []
  for (const el of after) {
    const b = before.get(el.id)
    if (
      b &&
      (b.version !== el.version || (b.versionNonce !== undefined && b.versionNonce !== el.versionNonce))
    )
      changes.push({ id: el.id, from: b.version, to: el.version })
  }
  return changes
}

export class EchoSuspectError extends Error {
  readonly code = 'echo_suspect'
  readonly changes: VersionChange[]
  constructor(changes: VersionChange[]) {
    super(`echo_suspect: confirmed element version changed on apply: ${changes.map((c) => c.id).join(', ')}`)
    this.changes = changes
  }
}

/**
 * The dev/test assertion of §2.5.5 ("Global guard"): a confirmed element must never change version on
 * apply. Throws in dev and test; production passes `onViolation` to count a metric instead.
 */
export const assertConfirmedUntouched = (
  before: ReadonlyMap<string, VersionStamp>,
  after: readonly (IndexedElement & { versionNonce?: number })[],
  onViolation?: (changes: VersionChange[]) => void,
): void => {
  const changes = confirmedVersionChanges(before, after)
  if (changes.length === 0) return
  if (onViolation) onViolation(changes)
  else throw new EchoSuspectError(changes)
}
