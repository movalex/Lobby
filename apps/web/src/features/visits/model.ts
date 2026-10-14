// OWNER: WS4 (wave N, N4-2). "What changed since your last visit", computed in the page from what the scene already
// holds, once, after the room is ready. Pure (no canvas, no clock, no request): the glue is ./run.ts.
//
//  - added:   `customData.lobbyServer.createdAt` (the server's stamp, never a client clock) is after `seenAt`;
//  - changed: the server-stamped `updated` is after `seenAt`, and it is not added;
//  - removed: a tombstone (it keeps `updated`: canvas-schema TOMBSTONE_KEYS) with `updated` after `seenAt`.
// `seenAt` is this person's PREVIOUS visit time (the api's answer, ./client.ts), so only what happened while they were
// away counts. null (a first visit, a guest, an api without the route) means no result.
//
// What does not count, because the person did it themselves (P-006, `me`): an element the server credits to them
// (`customData.lobbyServer.createdBy`) is not "added", and one whose latest commit was their own edit of its words
// (`lastEditedBy` at that commit's time) is not "changed": a label they typed into, or added, does not change its
// note. The server stamps no author on a move, a resize or a restyle, so those cannot be told apart by who made them:
// they count as changes (the known limit; a per-commit author would need a wire change). A removal by them is left
// out in ./run.ts, from the "Recently deleted" list that names who deleted it.
//
// What does not count, because nobody did it:
//  - a bound label counts for its container, once: a note whose label was typed into is one changed note, a new note
//    with its label is one added note, and a label alone is never an entry of its own. A deleted label is read the same
//    way from the commit time alone (a tombstone keeps no `containerId`): the one that shares its commit with a deleted
//    container, or with a live container that changed, is that container's label (the one known error: a free text
//    deleted in the very same commit as a changed shape is folded away with it);
//  - a server re-snap of an arrow: the server moves a bound arrow (and its label) in the SAME commit that moved its
//    target, so every commit that touched the arrow carries the target's `updated`. An arrow all of whose touches
//    are such commits only followed its shapes: it is "derived", not changed. (With a checkpoint from before the
//    visit, ./refine.ts uses the time-travel diff instead, which compares the arrows themselves.) The same goes for
//    an arrow that lost an end in the commit that deleted its target;
//  - what the scene hides (a collapsed mind-map branch) or does not hold (a private note still in its owner's draft
//    list is not an element, and a private session's frame follows the elements the scene shows): `isHidden` and the
//    scene's own live items decide, so a note is never listed to someone the scene would not show it to.
//
// Cost: one pass over the live elements and one over the tombstones, Maps and Sets only (10,000 elements in a few
// milliseconds: model.test.ts records the number).

/** The fields of an element this reads (a scene element has many more). */
export interface VisitElement {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly updated?: unknown
  readonly containerId?: unknown
  readonly startBinding?: unknown
  readonly endBinding?: unknown
  readonly customData?: unknown
}

export interface RemovedItem {
  readonly id: string
  readonly type: string
  /** a short name ("Note “Ship it”"), when something says it: the checkpoint's diff, or "Recently deleted" for editors */
  readonly name?: string
  /** where it was (a checkpoint's place), when known: tombstones keep no geometry */
  readonly bounds?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

export interface VisitChanges {
  /** the visit these changes are measured from (ms since the epoch) */
  readonly seenAt: number
  /** ids of the added elements (a bound label is never one), in scene order */
  readonly added: readonly string[]
  /** ids of the changed elements, in scene order */
  readonly changed: readonly string[]
  /** the removed elements, as far as a tombstone says what they were */
  readonly removed: readonly RemovedItem[]
  readonly counts: { readonly added: number; readonly changed: number; readonly removed: number }
  readonly total: number
  /** arrows (and labels) left out because they only followed a shape that moved */
  readonly derived: number
  /**
   * A checkpoint from before the visit would make this exact: something was removed (it may have been made and deleted
   * while away) or an arrow changed (it may only have followed). ./refine.ts narrows the lists with one.
   */
  readonly refinable: boolean
}

export interface WhatChangedInput {
  /** the previous visit; null means no result */
  readonly seenAt: number | null
  /** the scene's live elements, in paint order (CanvasPort.items) */
  readonly live: readonly VisitElement[]
  /** every deleted element the scene still holds (the engine's elements that are deleted) */
  readonly tombstones: Iterable<VisitElement>
  /** the scene's hidden set (LobbyCanvas.isHidden): collapsed branches are not compared */
  readonly isHidden?: (id: string) => boolean
  /** the viewing person's user id: what they made or last edited themselves is not counted; null or absent: all */
  readonly me?: string | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The server's creation stamp of an element (`customData.lobbyServer.createdAt`), or null. */
export function createdAtOf(el: VisitElement): number | null {
  const cd = el.customData
  if (typeof cd !== 'object' || cd === null) return null
  const ls = (cd as { lobbyServer?: unknown }).lobbyServer
  if (typeof ls !== 'object' || ls === null) return null
  return num((ls as { createdAt?: unknown }).createdAt)
}

const serverStampsOf = (el: VisitElement): Record<string, unknown> | null => {
  const cd = el.customData
  if (typeof cd !== 'object' || cd === null) return null
  const ls = (cd as { lobbyServer?: unknown }).lobbyServer
  return typeof ls === 'object' && ls !== null ? (ls as Record<string, unknown>) : null
}

const uidOf = (attribution: unknown): string | null => {
  if (typeof attribution !== 'object' || attribution === null) return null
  const uid = (attribution as { uid?: unknown }).uid
  return typeof uid === 'string' ? uid : null
}

/** Whether the server credits `me` with making the element. */
const madeBy = (el: VisitElement, me: string): boolean => uidOf(serverStampsOf(el)?.createdBy) === me

/**
 * Whether the element's latest commit (`updated`) was `me` editing its words: the server stamps `lastEditedBy` and
 * `lastEditedAt` in the same commit as `updated`. A later commit of anyone's (a move, a restyle) leaves `updated`
 * past `lastEditedAt`, and is not theirs to claim.
 */
const lastEditedBy = (el: VisitElement, me: string): boolean => {
  const ls = serverStampsOf(el)
  const at = num(ls?.lastEditedAt)
  const updated = num(el.updated)
  return uidOf(ls?.lastEditedBy) === me && at !== null && updated !== null && at >= updated
}

const containerOf = (el: VisitElement): string | null =>
  el.type === 'text' && typeof el.containerId === 'string' && el.containerId.length > 0
    ? el.containerId
    : null

const boundIds = (el: VisitElement): string[] => {
  const out: string[] = []
  for (const b of [el.startBinding, el.endBinding]) {
    const id = typeof b === 'object' && b !== null ? (b as { elementId?: unknown }).elementId : null
    if (typeof id === 'string') out.push(id)
  }
  return out
}

/** Whether an end of this arrow is free (no binding). */
const hasFreeEnd = (el: VisitElement): boolean => !el.startBinding || !el.endBinding

/** What a tombstone can be a bound label of: it is deleted in the same commit as its container. */
const CONTAINER_TYPES = new Set(['stickynote', 'rectangle', 'ellipse', 'diamond', 'arrow', 'frame'])

export function whatChanged(input: WhatChangedInput): VisitChanges | null {
  const { seenAt } = input
  if (seenAt === null || !Number.isFinite(seenAt) || seenAt <= 0) return null
  const hidden = input.isHidden ?? (() => false)
  const me = input.me ?? null

  const liveById = new Map<string, VisitElement>()
  for (const e of input.live) if (!e.isDeleted) liveById.set(e.id, e)

  // ---- pass 1: the live elements; labels are folded into their containers ----
  const addedSet = new Set<string>()
  const changedSet = new Set<string>()
  /** container id → the commits (`updated`) of its label's touches since the visit; a new label is `null` (not derivable) */
  const labelTouches = new Map<string, Set<number | null>>()
  /** container id → the commits of the viewer's own label touches (a new label, or words typed into one) */
  const myLabelCommits = new Map<string, Set<number>>()
  for (const e of liveById.values()) {
    const container = containerOf(e)
    const target = container ?? e.id
    if (hidden(e.id) || hidden(target)) continue
    if (container !== null && !liveById.has(container)) continue // a label whose container is gone
    const created = createdAtOf(e)
    const updated = num(e.updated)
    const isNew = created !== null && created > seenAt
    const touched = isNew || (updated !== null && updated > seenAt)
    // P-006: what the viewer made, or last edited the words of, is theirs, not "since you were here"
    if (me !== null && touched && (isNew ? madeBy(e, me) : lastEditedBy(e, me))) {
      if (container !== null && updated !== null) {
        const mine = myLabelCommits.get(container) ?? new Set<number>()
        mine.add(updated)
        myLabelCommits.set(container, mine)
      }
      continue
    }
    if (container !== null) {
      if (!touched) continue
      const set = labelTouches.get(container) ?? new Set<number | null>()
      set.add(isNew ? null : updated)
      labelTouches.set(container, set)
      continue
    }
    if (isNew) addedSet.add(e.id)
    else if (touched) changedSet.add(e.id)
  }
  // a label typed into (or added to) an existing element changes that element
  for (const container of labelTouches.keys()) if (!addedSet.has(container)) changedSet.add(container)
  // ... unless the viewer was the one who typed: the commit that put their label there also touched the element (its
  // `boundElements`, its fit), and that touch is theirs too, when no one else's label touch is left
  for (const [container, commits] of myLabelCommits) {
    if (labelTouches.has(container) || addedSet.has(container)) continue
    const own = liveById.get(container)
    const updated = own ? num(own.updated) : null
    if (updated !== null && commits.has(updated)) changedSet.delete(container)
  }

  // ---- tombstones: removed items, and the commit times of what was deleted ----
  const removedAll: { id: string; type: string; updated: number }[] = []
  for (const t of input.tombstones) {
    if (!t.isDeleted || liveById.has(t.id)) continue
    const updated = num(t.updated)
    if (updated === null || updated <= seenAt) continue
    if (hidden(t.id)) continue
    removedAll.push({ id: t.id, type: t.type, updated })
  }
  // A deleted container takes its label with it in one commit, and a label cleared while its container stays is
  // deleted in the commit that changed the container. A tombstone has no `containerId` (it is redacted to id, type,
  // version, index and `updated`), so a deleted text is read as that label when its commit is the commit of a deleted
  // container-capable element or of a live added/changed one: it counts for the container, not as a removal of its own.
  // This is a guess from the commit time, kept to those two cases: a free text deleted in the very same commit as a
  // changed shape (one multi-element edit) is folded away with it, which undercounts by one and is the rarer mistake.
  const containerCommits = new Set<number>()
  for (const r of removedAll) if (CONTAINER_TYPES.has(r.type)) containerCommits.add(r.updated)
  for (const id of [...addedSet, ...changedSet]) {
    const e = liveById.get(id)
    const u = e ? num(e.updated) : null
    if (e && u !== null && CONTAINER_TYPES.has(e.type)) containerCommits.add(u)
  }
  // the commits of the removals that stand: a folded label does not free an arrow's end, its container's own commit does
  const removed: RemovedItem[] = []
  const deleteCommits = new Set<number>()
  for (const r of removedAll) {
    if (r.type === 'text' && containerCommits.has(r.updated)) continue
    removed.push({ id: r.id, type: r.type })
    deleteCommits.add(r.updated)
  }

  // ---- arrows that only followed their shapes ----
  let derived = 0
  const touchedByTargetCommit = (arrow: VisitElement): boolean => {
    const commits = new Set<number | null>()
    const own = num(arrow.updated)
    if (own !== null && own > seenAt) commits.add(own)
    for (const c of labelTouches.get(arrow.id) ?? []) commits.add(c)
    if (!commits.size || commits.has(null)) return false // nothing since, or a label was added by hand
    const targets = new Set<number>()
    for (const id of boundIds(arrow)) {
      const t = liveById.get(id)
      const tu = t ? num(t.updated) : null
      if (t && tu !== null && tu > seenAt && (addedSet.has(id) || changedSet.has(id))) targets.add(tu)
    }
    // the commit that deleted a target also freed the arrow's end
    if (hasFreeEnd(arrow)) for (const c of deleteCommits) targets.add(c)
    for (const c of commits) if (c === null || !targets.has(c)) return false
    return true
  }
  for (const id of [...changedSet]) {
    const el = liveById.get(id)
    if (el?.type === 'arrow' && touchedByTargetCommit(el)) {
      changedSet.delete(id)
      derived++
    }
  }

  const added: string[] = []
  const changed: string[] = []
  for (const id of liveById.keys()) {
    if (addedSet.has(id)) added.push(id)
    else if (changedSet.has(id)) changed.push(id)
  }
  const refinable = removed.length > 0 || changed.some((id) => liveById.get(id)?.type === 'arrow')
  return finish(seenAt, added, changed, removed, derived, refinable)
}

/** The result for these lists (shared with ./refine.ts, which narrows them). */
export function finish(
  seenAt: number,
  added: readonly string[],
  changed: readonly string[],
  removed: readonly RemovedItem[],
  derived: number,
  refinable: boolean,
): VisitChanges {
  const counts = { added: added.length, changed: changed.length, removed: removed.length }
  return {
    seenAt,
    added,
    changed,
    removed,
    counts,
    total: counts.added + counts.changed + counts.removed,
    derived,
    refinable,
  }
}

// ---- words ---------------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

/** "Tue 3:40 pm" within the last six days of `now`, else "Oct 4, 3:40 pm" ("Oct 4 2025, 3:40 pm" from another year). */
export function sinceWhen(at: number, now: number): string {
  const d = new Date(at)
  const hm = d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(/\s?([AP])M$/, (_m, c: string) => ` ${c.toLowerCase()}m`)
  if (now - at < 6 * DAY_MS && now >= at) {
    const day = d.toLocaleDateString('en-US', { weekday: 'short' })
    return `${day} ${hm}`
  }
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const date = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${date}, ${hm}`
}

const plural = (n: number, word: string) => `${n} ${word}`

/** "5 added · 3 changed · 1 removed": the parts that are not zero, in that order. */
export function countsText(counts: VisitChanges['counts']): string {
  const parts: string[] = []
  if (counts.added) parts.push(plural(counts.added, 'added'))
  if (counts.changed) parts.push(plural(counts.changed, 'changed'))
  if (counts.removed) parts.push(plural(counts.removed, 'removed'))
  return parts.join(' · ')
}

/** The chip's words: "Since you were here (Tue 3:40 pm): 5 added · 3 changed · 1 removed". */
export function chipText(changes: VisitChanges, now: number): string {
  return `Since you were here (${sinceWhen(changes.seenAt, now)}): ${countsText(changes.counts)}`
}
