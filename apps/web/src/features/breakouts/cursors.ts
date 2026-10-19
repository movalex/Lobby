// OWNER: WS4 (wave V, breakouts). "Only show my group's cursors": a choice of this screen only (in memory, per board
// page; nothing is sent, presence is unchanged). While it is on and this person is in a group, the board draws the
// cursors of that group's members and of the facilitator who started the breakouts, and no one else's. It is one more
// provider of the board's cursor filter (registries.cursorVisible: a cursor is drawn only when every provider says
// yes), so "Hide everyone's cursors" and present mode keep working beside it.
import type { BreakoutState } from '@draftroom/contracts'
import { type Atom, atom } from '../../lib/signals.ts'

const choices = new WeakMap<object, Atom<boolean>>()

export function onlyMyGroupOf(canvas: object): Atom<boolean> {
  let a = choices.get(canvas)
  if (!a) {
    a = atom('lobby-breakouts-only-my-group', false)
    choices.set(canvas, a)
  }
  return a
}

/**
 * The user ids whose cursors stay drawn, or null when the filter is off (not chosen, or not in a running group).
 * Pure.
 */
export function visibleUsers(state: BreakoutState | null, on: boolean): ReadonlySet<string> | null {
  if (!on || !state?.session || state.session.status !== 'running' || !state.myGroupId) return null
  const ids = new Set(state.members.filter((m) => m.groupId === state.myGroupId).map((m) => m.userId))
  if (state.session.createdBy) ids.add(state.session.createdBy)
  return ids
}

/** The filter over session ids: a cursor whose person is unknown stays drawn (never hide by guessing). */
export const cursorFilter =
  (users: ReadonlySet<string>, uidOf: (sid: string) => string | null) =>
  (sid: string): boolean => {
    const uid = uidOf(sid)
    return uid === null || users.has(uid)
  }
