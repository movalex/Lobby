// OWNER: 3f (workshops; wave N, WS3). Emoji reactions on sticky notes: `customData.lobby['react:<code>:<uid>'] =
// true` (canvas-schema reactions.ts; CONTRACTS_REV 13, REACTIONS_REV). Reacting is offered only in a room whose
// `contracts` frame names REACTIONS_REV or later, so a web deployed before the sync (or after a sync rollback)
// never sends a key the room refuses; stored reactions render read-only at any revision.
//
// This module is the rules (pure, over CanvasElement and a few canvas members, so it runs in Node tests); the row,
// the picker and the other ways in are ./NoteReactions.tsx.
//
//  - The row of a note is its reactions by code in REACTION_CODES order, each with a count and whether it is mine
//    (`reactionChipsOf`). Names are resolved from the roster by uid, never from the key; an unknown uid reads
//    "Someone", and while the facilitation setting "Hide note authors" is on no name is listed at all (the
//    reactions are anonymous then, as the authors are).
//  - A reaction is written like a +1 (W5-26): the writer's own key, one `transact` with `skipUndo`, so the giver's
//    Ctrl+Z undoes their previous edit and never the reaction everyone sees. A locked note takes it (the key spec's
//    `lockExempt: 'own'`). An owner may clear a note's reactions (every key), which the server allows only to an
//    owner (apps/sync custom-data.ts).
//  - A refusal is told once: the engine settles a non-retryable one itself (the server's copy comes back); the
//    kill switch answers UNAVAILABLE, which the engine retries for ever, so a second UNAVAILABLE for the same
//    write is read as "switched off right now": the key goes back to the server's value and the person is told.
//    That watch lives half a minute; a room that says it takes none (its `contracts` frame below REACTIONS_REV)
//    gets every unconfirmed reaction put back whenever it says so, whatever the watch (`mountReactionGuard`: a tab
//    offline longer, a reload with the write in its offline queue).
import { REACTIONS_MAX } from '@draftroom/canvas-schema/limits'
import { type Ack, REACTIONS_REV } from '@draftroom/canvas-schema/protocol'
import {
  parseReactionKey,
  REACTION_KEY_PREFIX,
  reactionKey,
  reactionsOf,
} from '@draftroom/canvas-schema/reactions'
import {
  REACTION_CODE_EMOJI,
  REACTION_CODE_LABELS,
  REACTION_CODES,
  type ReactionCode,
} from '@draftroom/contracts'
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom, react as effect } from '../../../lib/signals.ts'
import { countUsage } from '../../../lib/usage.ts'
import { workshopSettingsOf } from './session-settings.ts'

/** The selection bar item WS3 registers (registries SelectionBarItemSpec id). */
export const REACTIONS_SELECTION_ITEM_ID = 'reactions'
/** The palette command WS3 registers (contracts usage.ts PALETTE_COMMAND_IDS; pending until then). */
export const REACTIONS_COMMAND_ID = 'reactions.react'

/**
 * The hold (docs/PROGRESS.md wave N): false hides the whole feature in a web-only redeploy, stored reactions
 * included (the row, the picker, the selection bar item, the menu entries and the command).
 */
export const REACTIONS_UI = true

let ui: boolean = REACTIONS_UI
/** Whether the feature is on (the hold). Read at call time, so a test can turn it off and on again. */
export const reactionsUi = (): boolean => ui
/** Tests only: the hold, as a web-only redeploy with REACTIONS_UI=false would set it. */
export function setReactionsUiForTests(on: boolean): void {
  ui = on
}

/** Whether this room takes reactions (its contracts revision is REACTIONS_REV or later). Null rev: not known, no. */
export function reactionsRoom(rev: number | null): boolean {
  return rev !== null && rev >= REACTIONS_REV
}

/**
 * Whether this tab may offer reacting: the room takes reactions and the canvas is not read-only (editors, owners
 * and name-only guests who can edit; viewers and commenters see the row read-only). Reactive (both reads are).
 */
export function reactionsOffered(canvas: Pick<LobbyCanvas, 'room' | 'readOnly'>): boolean {
  if (!reactionsRoom(canvas.room.contractsRev())) return false
  return !canvas.readOnly()
}

/** Whether the feature is on at all (the hold) and this tab may react. */
export const reactionsOn = (canvas: Pick<LobbyCanvas, 'room' | 'readOnly'>, hold: boolean = reactionsUi()) =>
  hold && reactionsOffered(canvas)

// ---- reading a note's reactions ----------------------------------------------------------------------------------

/** Only sticky notes take reactions (the server refuses the key on any other element). */
export const isReactionTarget = (el: CanvasElement | null | undefined): el is CanvasElement =>
  !!el && el.type === 'stickynote' && !(el as { isDeleted?: boolean }).isDeleted

/** One emoji of a note's row. */
export interface ReactionChip {
  readonly code: ReactionCode
  readonly emoji: string
  /** the words for the emoji ("Thumbs up") */
  readonly label: string
  readonly count: number
  /** this person reacted with it */
  readonly mine: boolean
  /** who reacted (sorted by uid; the order is not stored) */
  readonly uids: readonly string[]
}

/** The row of a note: the codes somebody used, in REACTION_CODES order (at most one chip per code, so at most 6). */
export function reactionChipsOf(el: CanvasElement | null | undefined, me: string): ReactionChip[] {
  if (!el) return []
  return reactionsOf(el.customData?.lobby).map(({ code, uids }) => ({
    code,
    emoji: REACTION_CODE_EMOJI[code],
    label: REACTION_CODE_LABELS[code],
    count: uids.length,
    mine: uids.includes(me),
    uids,
  }))
}

/** How many reaction keys a note carries (the cap counts keys, REACTIONS_MAX). */
export function reactionCountOf(el: CanvasElement | null | undefined): number {
  return reactionsOf(el?.customData?.lobby).reduce((n, r) => n + r.uids.length, 0)
}

/** The stored `react:*` keys of a note (any uid), for an owner's clear. */
export function reactionKeysOf(el: CanvasElement | null | undefined): string[] {
  const lobby = el?.customData?.lobby
  if (!lobby) return []
  return Object.entries(lobby)
    .filter(([k, v]) => k.startsWith(REACTION_KEY_PREFIX) && v === true)
    .map(([k]) => k)
}

/** "3 people reacted 👍, including you": what a screen reader hears on an emoji of the row. */
export function reactionLabel(chip: Pick<ReactionChip, 'count' | 'emoji' | 'mine'>): string {
  const people = chip.count === 1 ? 'person' : 'people'
  return `${chip.count} ${people} reacted ${chip.emoji}${chip.mine ? ', including you' : ''}`
}

/** The live notes among `ids` (a bound label, a shape or a gone element is left out), in order, once each. */
export function reactionTargets(canvas: Pick<LobbyCanvas, 'get'>, ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (isReactionTarget(canvas.get(id))) out.push(id)
  }
  return out
}

// ---- names -----------------------------------------------------------------------------------------------------

/** What an unknown uid reads as (somebody who reacted and is not in the room now, and was not seen by this tab). */
export const SOMEONE = 'Someone'

export type NameOf = (uid: string) => string

/** Names this tab has seen on the roster, so a person who reacted and left is still named while this tab is open. */
const seenNames = new WeakMap<object, Map<string, string>>()
const SEEN_NAMES_MAX = 500

/**
 * uid → name for the people on the board's roster (reactive: `canvas.collaborators()`), this person from their
 * own session, and anyone this tab saw there earlier. A uid it has never seen reads "Someone".
 */
export function nameResolver(
  canvas: Pick<LobbyCanvas, 'collaborators'>,
  me: { readonly id: string; readonly name: string },
): NameOf {
  let seen = seenNames.get(canvas)
  if (!seen) {
    seen = new Map()
    seenNames.set(canvas, seen)
  }
  for (const p of canvas.collaborators()) {
    const name = p.name.trim()
    if (!name) continue
    if (seen.size >= SEEN_NAMES_MAX && !seen.has(p.uid)) seen.delete(seen.keys().next().value as string)
    seen.set(p.uid, name)
  }
  const mine = me.name.trim()
  const known = seen
  return (uid) => (uid === me.id && mine ? mine : (known.get(uid) ?? SOMEONE))
}

/**
 * Who reacted with `chip`, for the list that shows on hover or focus: "You, Bob and Someone" (you first, the others
 * by name, the unknown last). Names hidden (the session's "Hide note authors"): only how many, "3 people".
 */
export function whoReacted(
  chip: Pick<ReactionChip, 'uids' | 'mine' | 'count'>,
  me: string,
  nameOf: NameOf,
  hideNames: boolean,
): string {
  if (hideNames) {
    const others = chip.count - (chip.mine ? 1 : 0)
    if (chip.mine && others === 0) return 'You'
    return chip.mine
      ? `You and ${others} ${others === 1 ? 'other' : 'others'}`
      : `${chip.count} ${chip.count === 1 ? 'person' : 'people'}`
  }
  const others = chip.uids
    .filter((u) => u !== me)
    .map(nameOf)
    .sort((a, b) => (a === SOMEONE ? 1 : 0) - (b === SOMEONE ? 1 : 0) || a.localeCompare(b))
  const names = chip.mine ? ['You', ...others] : others
  const SHOWN = 8
  const shown = names.slice(0, SHOWN)
  if (names.length > SHOWN) shown.push(`${names.length - SHOWN} more`)
  if (shown.length <= 1) return shown[0] ?? ''
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

/** Whether names are withheld right now (the facilitation setting "Hide note authors"). Reactive. */
export const reactorNamesHidden = (canvas: LobbyCanvas): boolean => workshopSettingsOf(canvas).hideNoteAuthors

// ---- writing ---------------------------------------------------------------------------------------------------

export const REACTIONS_OFF_TEXT = 'Reactions are switched off right now'
export const REACTIONS_FULL_TEXT = 'This note has the most reactions it can hold'
export const REACTIONS_NOT_YET_TEXT = 'Reactions are not available on this board yet'
export const REACTIONS_LOCKED_TEXT = 'Unlock a note to clear its reactions'

export interface ReactionWriteResult {
  readonly ok: boolean
  /** Set when !ok: what to tell the person. */
  readonly message?: string
  /** Whether the person now has the reaction (set when ok). */
  readonly added?: boolean
  /** How many notes the write changed. */
  readonly changed?: number
  /** A clear only: how many notes with reactions it left alone because they are locked (see `clearableNotes`). */
  readonly locked?: number
}

type LobbyPatch = Record<string, true | null>

/** The patch that sets `uid`'s `code` on a note to `want`, null when nothing changes, 'full' at the cap. */
export function reactionPatch(
  el: CanvasElement,
  code: ReactionCode,
  uid: string,
  want: boolean,
): LobbyPatch | null | 'full' {
  const key = reactionKey(code, uid)
  const has = el.customData?.lobby?.[key] === true
  if (want === has) return null
  if (want && reactionCountOf(el) >= REACTIONS_MAX) return 'full'
  return { [key]: want ? true : null }
}

const NOT_OFFERED: ReactionWriteResult = { ok: false, message: REACTIONS_NOT_YET_TEXT }

/**
 * Sets (`want`) or toggles `uid`'s `code` on every live note of `ids` in ONE `transact`, never an undo step
 * (`skipUndo`): without `want`, the reaction goes on every note that lacks it, or off every note when all have it.
 * A tab that may not react (a room below REACTIONS_REV, a read-only canvas) writes nothing: the key would be refused.
 */
export function toggleReactions(
  canvas: LobbyCanvas,
  ids: readonly string[],
  code: ReactionCode,
  uid: string,
  want?: boolean,
): ReactionWriteResult {
  if (!reactionsOffered(canvas)) return NOT_OFFERED
  const notes = reactionTargets(canvas, ids)
  if (notes.length === 0) return { ok: false, message: 'That note is gone.' }
  const key = reactionKey(code, uid)
  const have = (id: string) => canvas.get(id)?.customData?.lobby?.[key] === true
  const next = want ?? !notes.every(have)
  const patches: [string, LobbyPatch][] = []
  let full = false
  for (const id of notes) {
    const el = canvas.get(id)
    if (!el) continue
    const p = reactionPatch(el, code, uid, next)
    if (p === 'full') full = true
    else if (p) patches.push([id, p])
  }
  if (patches.length === 0)
    return full ? { ok: false, message: REACTIONS_FULL_TEXT } : { ok: true, added: next, changed: 0 }
  try {
    canvas.transact(
      'reaction',
      (tx) => {
        for (const [id, patch] of patches) tx.update(id, { customData: { lobby: patch } })
      },
      { skipUndo: true },
    )
  } catch {
    return { ok: false, message: 'That did not work.' }
  }
  if (next) countUsage(`reactions.add:${code}`)
  return { ok: true, added: next, changed: patches.length }
}

/** One note's reaction, toggled or set (see toggleReactions). */
export const toggleReaction = (
  canvas: LobbyCanvas,
  id: string,
  code: ReactionCode,
  uid: string,
  want?: boolean,
): ReactionWriteResult => toggleReactions(canvas, [id], code, uid, want)

/**
 * Whether this person may clear reactions: an owner of the board (the server lets only an owner remove another
 * person's key), in a room that takes reactions. UI hint only: the server decides.
 */
export const canClearReactions = (ctx: Pick<CanvasFeatureContext, 'role' | 'canvas'>): boolean =>
  ctx.role === 'owner' && reactionsOffered(ctx.canvas)

/**
 * The notes among `ids` that carry reactions, and whether a clear reaches them. A LOCKED note keeps another person's
 * `react:*` key (the key spec's `lockExempt: 'own'`: only the writer's own key passes a lock, an owner's clear
 * included), so a clear would be refused (LOCKED) and the page would sit on "not saved". It is not offered for a
 * locked note: `clearable` are the unlocked ones, `locked` the ones left out. Reactive (`get` and `isLocked` are).
 */
export function clearableNotes(
  canvas: Pick<LobbyCanvas, 'get' | 'isLocked'>,
  ids: readonly string[],
): { readonly clearable: string[]; readonly locked: string[] } {
  const clearable: string[] = []
  const locked: string[] = []
  for (const id of reactionTargets(canvas, ids)) {
    if (reactionKeysOf(canvas.get(id)).length === 0) continue
    ;(canvas.isLocked(id) ? locked : clearable).push(id)
  }
  return { clearable, locked }
}

/**
 * "Clear reactions" (an owner): removes every `react:*` key of the unlocked notes among `ids`, anyone's, in one
 * `transact` with `skipUndo`. Nothing to clear is not a write. A locked note is left alone (see `clearableNotes`):
 * when that leaves nothing to clear, the answer is a refusal that says to unlock it, and a clear that did reach some
 * notes says how many it left (`locked`).
 */
export function clearReactions(canvas: LobbyCanvas, ids: readonly string[]): ReactionWriteResult {
  if (!reactionsOffered(canvas)) return NOT_OFFERED
  const { clearable, locked } = clearableNotes(canvas, ids)
  if (clearable.length === 0 && locked.length > 0) return { ok: false, message: REACTIONS_LOCKED_TEXT }
  const patches: [string, LobbyPatch][] = []
  for (const id of clearable) {
    const keys = reactionKeysOf(canvas.get(id))
    if (keys.length) patches.push([id, Object.fromEntries(keys.map((k) => [k, null]))])
  }
  if (patches.length === 0) return { ok: true, changed: 0 }
  try {
    canvas.transact(
      'clear reactions',
      (tx) => {
        for (const [id, patch] of patches) tx.update(id, { customData: { lobby: patch } })
      },
      { skipUndo: true },
    )
  } catch {
    return { ok: false, message: 'That did not work.' }
  }
  countUsage('reactions.clear')
  return { ok: true, changed: patches.length, ...(locked.length ? { locked: locked.length } : {}) }
}

// ---- refusals ----------------------------------------------------------------------------------------------------

/** The engine members a watch uses (a fake in the unit tests). */
export interface AckSource {
  onAck(listener: (ack: Ack) => void): () => void
  pushLog?(): readonly { readonly seq: number; readonly ops: readonly unknown[] }[]
  confirmed?(
    id: string,
  ): { readonly customData?: { readonly lobby?: Readonly<Record<string, unknown>> } } | undefined
}

/** The same write refused UNAVAILABLE this many times in a row reads as the kill switch (a commit failure is rarely repeated). */
export const UNAVAILABLE_TWICE = 2
/** A watch ends after this long (the guard, below, covers a write the room answers later). */
export const WATCH_MS = 30_000

interface OpLike {
  readonly k?: string
  readonly id?: string
  readonly c?: Readonly<Record<string, unknown>>
  readonly el?: {
    readonly id?: string
    readonly customData?: { readonly lobby?: Readonly<Record<string, unknown>> }
  }
}

/** The record of push `seq`, newest first (the log is every push of the session, and the one answered is recent). */
function pushOf(engine: AckSource, seq: number) {
  const log = engine.pushLog?.()
  if (!log) return undefined
  for (let i = log.length - 1; i >= 0; i--) if (log[i]?.seq === seq) return log[i]
  return undefined
}

/** The note a push op is about when it carries a `react:*` key (a patch's `c`, or a create's whole element). */
function reactionOpId(op: OpLike): string | null {
  const id = op.k === 'c' ? op.el?.id : op.id
  if (!id) return null
  const given = op.k === 'c' ? op.el?.customData?.lobby : op.c
  return given && Object.keys(given).some((k) => k.startsWith(REACTION_KEY_PREFIX)) ? id : null
}

/** One skipUndo `transact` that writes each note's patch (the only write a revert makes); false when it did not go. */
function writePatches(
  canvas: LobbyCanvas,
  patches: readonly (readonly [id: string, patch: LobbyPatch])[],
): boolean {
  if (patches.length === 0) return false
  try {
    canvas.transact(
      'reaction',
      (tx) => {
        for (const [id, patch] of patches) tx.update(id, { customData: { lobby: patch } })
      },
      { skipUndo: true },
    )
    return true
  } catch {
    return false // read-only meanwhile: nothing to put back
  }
}

interface Watched {
  readonly keys: readonly string[]
  unavailable: number
}
interface Watch {
  /** a later write of this note took over: it is no longer this watch's */
  drop(id: string): void
}

const watches = new WeakMap<object, Map<string, Watch>>()

/**
 * Watches the push that carries a reaction write (`writes`: each note with the keys written on it) until the room
 * answers it, with ONE ack listener however many notes it covers. The ack of an accepted write ends that note's
 * watch. A TOO_LARGE refusal tells the person the note is full (the engine puts the server's copy back by itself).
 * UNAVAILABLE is retryable, so the engine retries for ever under the kill switch: at the second one the keys go back
 * to the server's values (`confirmed`, one `transact` with `skipUndo` for all the notes, the only write this makes)
 * and the person is told reactions are switched off. Every other refusal is the board's own "Change not saved"
 * notice. The watch lasts WATCH_MS; a write the room answers later (a tab that was offline, a reload) is the guard's
 * (`mountReactionGuard`). Returns the stop. A later watch of the same note takes it over.
 */
export function watchReactionWrites(
  canvas: LobbyCanvas,
  notify: CanvasFeatureContext['notify'],
  writes: Iterable<readonly [id: string, keys: readonly string[]]>,
  opts: { setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {},
): () => void {
  const engine = canvas.engine as AckSource | null
  if (!engine) return () => {}
  const live = new Map<string, Watched>()
  for (const [id, keys] of writes) if (keys.length > 0) live.set(id, { keys, unavailable: 0 })
  if (live.size === 0) return () => {}
  const set = opts.setTimer ?? setTimeout
  const clear = opts.clearTimer ?? clearTimeout
  let perCanvas = watches.get(canvas)
  if (!perCanvas) {
    perCanvas = new Map()
    watches.set(canvas, perCanvas)
  }
  const owners = perCanvas
  let done = false
  let off: () => void = () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    if (done) return
    done = true
    off()
    if (timer !== null) clear(timer)
    for (const id of live.keys()) if (owners.get(id) === self) owners.delete(id)
    live.clear()
  }
  const self: Watch = {
    drop(id) {
      live.delete(id)
      if (live.size === 0) stop()
    },
  }
  for (const id of [...live.keys()]) {
    owners.get(id)?.drop(id)
    owners.set(id, self)
  }
  off = engine.onAck((ack) => {
    if (done) return
    const push = pushOf(engine, ack.seq)
    if (!push) return
    const back: [string, LobbyPatch][] = []
    let full = false
    const seen = new Set<string>()
    ;(push.ops as readonly OpLike[]).forEach((op, n) => {
      if (op.k !== 'p' || !op.id || !op.c) return
      const w = live.get(op.id)
      if (!w || seen.has(op.id)) return
      const c = op.c
      if (!w.keys.some((k) => k in c)) return
      seen.add(op.id)
      const r = ack.r[n]
      if (!r) return
      const code = r.ok ? (r.denied?.code ?? null) : r.code
      if (code === null) {
        live.delete(op.id) // accepted
        return
      }
      if (code === 'RATE') return // retried by the engine
      if (code === 'UNAVAILABLE') {
        w.unavailable++
        if (w.unavailable < UNAVAILABLE_TWICE) return
        if (canvas.get(op.id)) {
          const stored = engine.confirmed?.(op.id)?.customData?.lobby
          back.push([op.id, Object.fromEntries(w.keys.map((k) => [k, stored?.[k] === true ? true : null]))])
        }
      } else if (code === 'TOO_LARGE') full = true
      live.delete(op.id)
    })
    if (back.length > 0) {
      writePatches(canvas, back)
      notify({ key: 'reaction', text: REACTIONS_OFF_TEXT, tone: 'error', testId: 'reaction-toast' })
    }
    if (full) notify({ key: 'reaction', text: REACTIONS_FULL_TEXT, tone: 'error', testId: 'reaction-toast' })
    if (live.size === 0) stop()
  })
  timer = set(stop, WATCH_MS)
  return stop
}

/** One note's write watched (see `watchReactionWrites`). */
export const watchReactionWrite = (
  canvas: LobbyCanvas,
  notify: CanvasFeatureContext['notify'],
  id: string,
  keys: readonly string[],
  opts: { setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {},
): (() => void) => watchReactionWrites(canvas, notify, [[id, keys]], opts)

/**
 * Reacts (or takes the reaction back) on `ids` and keeps watch for the room's answer: the one call every way in
 * (the row, the picker, the selection bar, the menu, the command) makes. Tells the person what went wrong.
 */
export function react(
  ctx: Pick<CanvasFeatureContext, 'canvas' | 'me' | 'notify'>,
  ids: readonly string[],
  code: ReactionCode,
  want?: boolean,
): ReactionWriteResult {
  const { canvas } = ctx
  const r = toggleReactions(canvas, ids, code, ctx.me.user.id, want)
  if (!r.ok) {
    ctx.notify({ key: 'reaction', text: r.message ?? 'That did not work.', testId: 'reaction-toast' })
    return r
  }
  if (r.changed) {
    const key = reactionKey(code, ctx.me.user.id)
    watchReactionWrites(
      canvas,
      ctx.notify,
      reactionTargets(canvas, ids).map((id) => [id, [key]] as const),
    )
  }
  return r
}

/** "Clear reactions" with its watch (see `react`). Locked notes are left alone, and the person is told so. */
export function clear(
  ctx: Pick<CanvasFeatureContext, 'canvas' | 'notify'>,
  ids: readonly string[],
): ReactionWriteResult {
  const { canvas } = ctx
  const before = new Map<string, string[]>()
  for (const id of clearableNotes(canvas, ids).clearable) before.set(id, reactionKeysOf(canvas.get(id)))
  const r = clearReactions(canvas, ids)
  if (!r.ok) {
    ctx.notify({ key: 'reaction', text: r.message ?? 'That did not work.', testId: 'reaction-toast' })
    return r
  }
  if (r.changed) watchReactionWrites(canvas, ctx.notify, before)
  if (r.locked) ctx.notify({ key: 'reaction', text: REACTIONS_LOCKED_TEXT, testId: 'reaction-toast' })
  return r
}

// ---- a room that takes no reactions (the guard) --------------------------------------------------------------------

/** The room announced a revision below REACTIONS_REV: it takes no reaction key at all (null: not known yet, no). */
export const reactionsClosed = (rev: number | null): boolean => rev !== null && rev < REACTIONS_REV

/**
 * The patch that puts a note's `react:*` keys back to the room's copy: a key held here and not there goes (null), a
 * key there and not held here comes back (true). Null when they agree. Without a copy (`hasCopy` false: a note made
 * here, not saved yet) only `me`'s own keys go, since what else the room holds is not known.
 */
export function reactionRevertPatch(
  local: Readonly<Record<string, unknown>> | undefined,
  stored: Readonly<Record<string, unknown>> | undefined,
  hasCopy: boolean,
  me: string,
): LobbyPatch | null {
  const patch: LobbyPatch = {}
  for (const [k, v] of Object.entries(local ?? {})) {
    if (!k.startsWith(REACTION_KEY_PREFIX) || v !== true || stored?.[k] === true) continue
    if (hasCopy || parseReactionKey(k)?.uid === me) patch[k] = null
  }
  if (hasCopy)
    for (const [k, v] of Object.entries(stored ?? {}))
      if (k.startsWith(REACTION_KEY_PREFIX) && v === true && local?.[k] !== true) patch[k] = true
  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * Puts every `react:*` key of the notes among `ids` that the room has not confirmed back to the room's copy
 * (`engine.confirmed`), in ONE `transact` with `skipUndo`. Returns how many notes changed. The room's copy is the
 * reference, so a removal not yet acknowledged (your own, or an owner's clear) comes back too.
 */
export function revertUnconfirmedReactions(canvas: LobbyCanvas, ids: Iterable<string>, me: string): number {
  const engine = canvas.engine as AckSource | null
  if (!engine?.confirmed || canvas.readOnly()) return 0
  const patches: [string, LobbyPatch][] = []
  for (const id of new Set(ids)) {
    const el = canvas.get(id)
    if (!isReactionTarget(el)) continue
    const copy = engine.confirmed(id)
    const patch = reactionRevertPatch(el.customData?.lobby, copy?.customData?.lobby, !!copy, me)
    if (patch) patches.push([id, patch])
  }
  return writePatches(canvas, patches) ? patches.length : 0
}

/**
 * The guard behind "reactions are switched off": a reaction this tab holds that the room has not confirmed goes back
 * to the room's copy as soon as the room says it takes none, however the write got there. The kill switch
 * (DRAFTROOM_REACTIONS=off) answers a reaction write UNAVAILABLE, which the engine retries for ever. The watch
 * (`watchReactionWrites`) covers the half minute after the person reacted; this covers all the rest: a tab that was
 * offline longer and reconnects to a room restarted with the switch off, a page reloaded with the write in its
 * offline queue, a write that reached the room any other way. Two triggers, neither a walk of the scene per change:
 * the room's `contracts` frame naming a revision below REACTIONS_REV (one look at the notes that hold a reaction
 * key), and a refusal of a push that carried a reaction key while the room says so (that note only). It writes
 * nothing when the tab and the room agree, and nothing in a room that takes reactions (a refusal there is the
 * watch's). The person is told once per revert. It runs whatever the hold (REACTIONS_UI) says.
 */
export function mountReactionGuard(ctx: Pick<CanvasFeatureContext, 'canvas' | 'me' | 'notify'>): () => void {
  const { canvas } = ctx
  const engine = canvas.engine as AckSource | null
  if (!engine) return () => {}
  const me = ctx.me.user.id
  let disposed = false
  const closed = () => reactionsClosed(canvas.room.contractsRev())
  const putBack = (ids: Iterable<string>) => {
    if (disposed || !closed()) return
    if (revertUnconfirmedReactions(canvas, ids, me) > 0)
      ctx.notify({ key: 'reaction', text: REACTIONS_OFF_TEXT, tone: 'error', testId: 'reaction-toast' })
  }
  // the room's frame; the notes are looked at after the message is handled, not inside it
  const offRoom = effect('dr-wk-react-guard', () => {
    if (!closed()) return
    queueMicrotask(() => putBack(canvas.index.withLobbyKeyPrefix(REACTION_KEY_PREFIX).map((e) => e.id)))
  })
  // an answer that is not an acceptance, to a push that carried a reaction key
  const offAck = engine.onAck((ack) => {
    if (disposed || !closed()) return
    const push = pushOf(engine, ack.seq)
    if (!push) return
    const ids: string[] = []
    ;(push.ops as readonly OpLike[]).forEach((op, n) => {
      const r = ack.r[n]
      if (!r || (r.ok && !r.denied)) return
      const id = reactionOpId(op)
      if (id) ids.push(id)
    })
    if (ids.length > 0) putBack(ids)
  })
  return () => {
    disposed = true
    offRoom()
    offAck()
  }
}

// ---- the picker (state shared by the ways in) --------------------------------------------------------------------

/** Where a picker opens: an element's rectangle in overlay px, or a scene point (a context menu's), or neither. */
export interface PickerAnchor {
  readonly x: number
  readonly top: number
  readonly bottom: number
}

/** How a picker was opened: a hover or the keyboard focus on a row (it follows them), or on purpose (it stays). */
export type PickerVia = 'hover' | 'focus' | 'click'

export interface PickerState {
  /** the notes a pick applies to (a selection of several, or the one note of a row) */
  readonly ids: readonly string[]
  readonly anchor: PickerAnchor | null
  readonly via: PickerVia
  /** the key that opened it (it gets the keyboard back when the picker closes) */
  readonly seq: number
}

const pickers = new WeakMap<object, Atom<PickerState | null>>()
let pickerSeq = 0

/** The open picker of a canvas (reactive), null when none. */
export function pickerOf(canvas: object): Atom<PickerState | null> {
  let a = pickers.get(canvas)
  if (!a) {
    a = atom<PickerState | null>('dr-wk-react-picker', null)
    pickers.set(canvas, a)
  }
  return a
}

/** Opens the picker for `ids` (the live notes among them); nothing when there is none. */
export function openReactionPicker(
  canvas: LobbyCanvas,
  ids: readonly string[],
  opts: { anchor?: PickerAnchor | null; via?: PickerVia } = {},
): boolean {
  const notes = reactionTargets(canvas, ids)
  if (notes.length === 0) return false
  pickerOf(canvas).set({
    ids: notes,
    anchor: opts.anchor ?? null,
    via: opts.via ?? 'click',
    seq: ++pickerSeq,
  })
  return true
}

export function closeReactionPicker(canvas: object): void {
  const a = pickers.get(canvas)
  if (a?.get()) a.set(null)
}

/** The `{code}` a command is run with (anything else: none). */
export function reactionArgs(args: unknown): { code: ReactionCode } | null {
  const code = (args as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && (REACTION_CODES as readonly string[]).includes(code)
    ? { code: code as ReactionCode }
    : null
}
