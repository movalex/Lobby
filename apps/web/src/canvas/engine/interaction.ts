import type { InteractionConfig } from '@excalidraw/excalidraw/types'

/**
 * Lobby's board roles as the canvas sees them. `guest` is a limited guest (read-only); a guest who may
 * edit is an `editor` here.
 */
export type LobbyRole = 'editor' | 'commenter' | 'viewer' | 'guest'

export const LOBBY_ROLES: readonly LobbyRole[] = ['editor', 'commenter', 'viewer', 'guest']

export const isLobbyRole = (v: unknown): v is LobbyRole =>
  typeof v === 'string' && (LOBBY_ROLES as readonly string[]).includes(v)

/**
 * Read-only roles keep panning, zooming, links and Lobby's custom tools (comment, vote, open card); the
 * keyboard, clipboard and drag-and-drop inside Excalidraw are off. `tools` sits INSIDE `enabled`
 * (dist/types/excalidraw/types.d.ts:549-633). Plan §2.3.2.
 */
export const READ_ONLY_INTERACTION: InteractionConfig = Object.freeze({
  enabled: Object.freeze({ navigation: true, links: true, tools: Object.freeze({ custom: true }) }),
})

/** The `interaction` prop for a role: omitted (Excalidraw's default `true`) for editors. */
export function interactionForRole(role: LobbyRole): InteractionConfig | undefined {
  return role === 'editor' ? undefined : READ_ONLY_INTERACTION
}
