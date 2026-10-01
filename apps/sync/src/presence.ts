// Who a session is shown as: always the ticket's user, never what the client sends. The Excalidraw room
// (room/presence.ts) binds every presence frame to the session the server admitted; this is the one
// shared rule for the colour (and the `user:<uid>` id the tldraw era used, kept for the api's records).

/** Longest cursor-chat message kept. */
export const MAX_CHAT_MESSAGE_LENGTH = 500

export interface PresenceIdentity {
  /** `user:<ticket uid>` */
  userId: string
  userName: string
  color: string
}

// Same palette, hash and hex check as the web client's colorForUser/safeColor
// (apps/web/src/lib/identity.ts), so a ticket color the web would not show is replaced the same way.
const USER_COLORS = ['#c2410c', '#1d4ed8', '#047857', '#7c3aed', '#be123c', '#0e7490', '#a16207', '#4d7c0f']
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

function colorForUser(userId: string): string {
  let h = 2166136261
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return USER_COLORS[(h >>> 0) % USER_COLORS.length] ?? '#1d4ed8'
}

export function presenceIdentity(ticket: { uid: string; name: string; color: string }): PresenceIdentity {
  return {
    userId: `user:${ticket.uid}`,
    userName: ticket.name,
    color: HEX_COLOR_RE.test(ticket.color) ? ticket.color : colorForUser(ticket.uid),
  }
}
