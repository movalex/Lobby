/**
 * OWNER: WS1 (wave N, N1-6; landed by the wave N foundation as a naive, correct implementation). The scene index
 * (`canvas.index`, lobby-canvas.ts SceneIndex): the live notes, the elements carrying a `customData.lobby` key
 * prefix (`react:`, `plusOne:`), the elements of a frame and the elements of a `customData.lobby.kind`, so a
 * feature overlay finds what it draws without walking the whole scene on every change (a 10k-element board).
 *
 * This first version walks the scene on each read (through the canvas's tracked `items()`, so a reactive read
 * re-runs when the scene changes): the frozen interface, with answers a later incremental index must equal. WS1
 * replaces the body with an index kept up to date from the port's changed and removed ids (session.ts
 * `afterSceneChange` names both) and a dev-only full-walk counter; scene-index.test.ts holds every answer to a
 * full rebuild. Reads only: nothing here writes the scene.
 */
import type { CanvasElement } from '../../port.ts'
import type { SceneIndex } from '../lobby-canvas.ts'
import type { PartDeps } from './types.ts'

const lobbyOf = (el: CanvasElement): Readonly<Record<string, unknown>> | undefined =>
  (el.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby

/** Whether `el` has a `customData.lobby` key starting with `prefix` (with something after it). */
export function hasLobbyKeyPrefix(el: CanvasElement, prefix: string): boolean {
  const lobby = lobbyOf(el)
  if (!lobby) return false
  for (const k of Object.keys(lobby)) if (k.length > prefix.length && k.startsWith(prefix)) return true
  return false
}

/** `el`'s `customData.lobby.kind`, or null. */
export function lobbyKindOf(el: CanvasElement): string | null {
  const kind = lobbyOf(el)?.kind
  return typeof kind === 'string' ? kind : null
}

/** The index's answers over a list of live elements (a full rebuild: the reference every implementation equals). */
export function sceneIndexOf(items: () => readonly CanvasElement[]): Omit<SceneIndex, 'onChanged'> {
  return {
    notes: () => items().filter((e) => e.type === 'stickynote'),
    withLobbyKeyPrefix: (prefix) => (prefix ? items().filter((e) => hasLobbyKeyPrefix(e, prefix)) : []),
    byFrame: (frameId) => items().filter((e) => e.frameId === frameId),
    byKind: (kind) => items().filter((e) => lobbyKindOf(e) === kind),
  }
}

export function createSceneIndexPart(deps: PartDeps): SceneIndex {
  return {
    ...sceneIndexOf(() => deps.self().items()),
    onChanged: (listener) => deps.port.on('changed', listener),
  }
}
