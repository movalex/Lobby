/**
 * Whom this tab follows, for presence `f` (CONTRACTS_REV 10, CR-3C-1), keyed by the board's engine core.
 *
 * 3c's follow part (canvas/api/parts/follow.ts) sets it through the canvas's `engine` when a follow starts
 * and ends; the presence hub (./hub.ts) of the same core reads it into every message it sends to a rev-10
 * room and re-sends when it changes. Keyed by the core object, so the board session needs no new wiring,
 * and in its own module so the canvas API (node-safe) does not import the hub (which imports the engine).
 *
 * Pure: no engine, no DOM.
 */

const targets = new WeakMap<object, string | null>()
const listeners = new WeakMap<object, Set<() => void>>()

/** Sets whom the tab of `core` follows (a session id, or null); listeners hear only a change. */
export function setPresenceFollow(core: object | null | undefined, sid: string | null): void {
  if (!core) return
  if ((targets.get(core) ?? null) === sid) return
  targets.set(core, sid)
  for (const l of [...(listeners.get(core) ?? [])]) l()
}

/** Whom the tab of `core` follows, or null. */
export function presenceFollowOf(core: object): string | null {
  return targets.get(core) ?? null
}

/** Calls `listener` whenever the follow target of `core` changes; returns the unsubscribe. */
export function onPresenceFollow(core: object, listener: () => void): () => void {
  let set = listeners.get(core)
  if (!set) {
    set = new Set()
    listeners.set(core, set)
  }
  set.add(listener)
  return () => set.delete(listener)
}
