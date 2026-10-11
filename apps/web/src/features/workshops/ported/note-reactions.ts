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
import { REACTIONS_MAX } from '@draftroom/canvas-schema/limits'
import { type Ack, REACTIONS_REV } from '@draftroom/canvas-schema/protocol'
import { REACTION_KEY_PREFIX, reactionKey, reactionsOf } from '@draftroom/canvas-schema/reactions'
import {
  REACTION_CODE_EMOJI,
  REACTION_CODE_LABELS,
  REACTION_CODES,
  type ReactionCode,
} from '@draftroom/contracts'
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
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
export const reactionsOn = (canvas: Pick<LobbyCanvas, 'room' | 'readOnly'>, ui: boolean = REACTIONS_UI) =>
  ui && reactionsOffered(canvas)

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

export interface ReactionWriteResult {
  readonly ok: boolean
  /** Set when !ok: what to tell the person. */
  readonly message?: string
  /** Whether the person now has the reaction (set when ok). */
  readonly added?: boolean
  /** How many notes the write changed. */
  readonly changed?: number
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
 * "Clear reactions" (an owner): removes every `react:*` key of the notes among `ids`, anyone's, in one `transact`
 * with `skipUndo`. Nothing to clear is not a write.
 */
export function clearReactions(canvas: LobbyCanvas, ids: readonly string[]): ReactionWriteResult {
  if (!reactionsOffered(canvas)) return NOT_OFFERED
  const patches: [string, LobbyPatch][] = []
  for (const id of reactionTargets(canvas, ids)) {
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
  return { ok: true, changed: patches.length }
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
/** A watch ends after this long (the engine's own "can't save" notice covers a longer outage). */
export const WATCH_MS = 30_000

interface OpLike {
  readonly k?: string
  readonly id?: string
  readonly c?: Readonly<Record<string, unknown>>
}

const watches = new WeakMap<object, Map<string, () => void>>()

/** The record of push `seq`, newest first (the log is every push of the session, and the one answered is recent). */
function pushOf(engine: AckSource, seq: number) {
  const log = engine.pushLog?.()
  if (!log) return undefined
  for (let i = log.length - 1; i >= 0; i--) if (log[i]?.seq === seq) return log[i]
  return undefined
}

/**
 * Watches the push that carries a reaction write of `keys` on note `id` until the room answers it. The ack of an
 * accepted write ends the watch. A TOO_LARGE refusal tells the person the note is full (the engine puts the server's
 * copy back by itself). UNAVAILABLE is retryable, so the engine retries for ever under the kill switch: at the second
 * one the keys go back to the server's values (`confirmed`, one `transact` with `skipUndo`, the only write this makes)
 * and the person is told reactions are switched off. Every other refusal is the board's own "Change not saved" notice.
 * Returns the stop. A later watch of the same note replaces the earlier one.
 */
export function watchReactionWrite(
  canvas: LobbyCanvas,
  notify: CanvasFeatureContext['notify'],
  id: string,
  keys: readonly string[],
  opts: { setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {},
): () => void {
  const engine = canvas.engine as AckSource | null
  if (!engine || keys.length === 0) return () => {}
  const set = opts.setTimer ?? setTimeout
  const clear = opts.clearTimer ?? clearTimeout
  let perCanvas = watches.get(canvas)
  if (!perCanvas) {
    perCanvas = new Map()
    watches.set(canvas, perCanvas)
  }
  perCanvas.get(id)?.()
  let unavailable = 0
  let done = false
  let off: () => void = () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    if (done) return
    done = true
    off()
    if (timer !== null) clear(timer)
    if (perCanvas.get(id) === stop) perCanvas.delete(id)
  }
  const revert = () => {
    if (!canvas.get(id)) return
    const stored = engine.confirmed?.(id)?.customData?.lobby
    const patch = Object.fromEntries(keys.map((k) => [k, stored?.[k] === true ? true : null]))
    try {
      canvas.transact('reaction', (tx) => tx.update(id, { customData: { lobby: patch } }), { skipUndo: true })
    } catch {
      // read-only meanwhile: nothing to put back
    }
  }
  off = engine.onAck((ack) => {
    if (done) return
    const push = pushOf(engine, ack.seq)
    const at = push
      ? (push.ops as readonly OpLike[]).findIndex(
          (op) => op.k === 'p' && op.id === id && !!op.c && keys.some((k) => k in (op.c as object)),
        )
      : -1
    const r = at >= 0 ? ack.r[at] : undefined
    if (!r) return
    const code = r.ok ? (r.denied?.code ?? null) : r.code
    if (code === null) return stop() // accepted
    if (code === 'UNAVAILABLE') {
      unavailable++
      if (unavailable < UNAVAILABLE_TWICE) return
      revert()
      notify({ key: 'reaction', text: REACTIONS_OFF_TEXT, tone: 'error', testId: 'reaction-toast' })
    } else if (code === 'TOO_LARGE') {
      notify({ key: 'reaction', text: REACTIONS_FULL_TEXT, tone: 'error', testId: 'reaction-toast' })
    } else if (code === 'RATE') {
      return // retried by the engine
    }
    stop()
  })
  timer = set(stop, WATCH_MS)
  perCanvas.set(id, stop)
  return stop
}

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
    for (const id of reactionTargets(canvas, ids)) watchReactionWrite(canvas, ctx.notify, id, [key])
  }
  return r
}

/** "Clear reactions" with its watch (see `react`). */
export function clear(
  ctx: Pick<CanvasFeatureContext, 'canvas' | 'notify'>,
  ids: readonly string[],
): ReactionWriteResult {
  const { canvas } = ctx
  const before = new Map<string, string[]>()
  for (const id of reactionTargets(canvas, ids)) before.set(id, reactionKeysOf(canvas.get(id)))
  const r = clearReactions(canvas, ids)
  if (!r.ok) {
    ctx.notify({ key: 'reaction', text: r.message ?? 'That did not work.', testId: 'reaction-toast' })
    return r
  }
  if (r.changed) for (const [id, keys] of before) watchReactionWrite(canvas, ctx.notify, id, keys)
  return r
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
