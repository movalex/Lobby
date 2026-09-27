import { BOARD_ID_RE } from '../assets/contract.ts'

/**
 * Development identities (?user=, ?role=viewer) exist only behind this explicit guard: the Vite dev
 * server, or a build made with VITE_DRAFTROOM_DEV_AUTH=1 (used by e2e). Milestone 1 replaces them
 * with real sign-in and signed sync tickets.
 */
export const DEV_AUTH_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DRAFTROOM_DEV_AUTH === '1'

export const DEV_USER_RE = /^[a-z0-9-]{1,32}$/
export const DEV_USER_PRESETS = ['alice', 'bob', 'carol'] as const

export type Role = 'editor' | 'viewer'
export interface DevIdentity {
  userId: string
  role: Role
}

export function isBoardId(value: unknown): value is string {
  return typeof value === 'string' && BOARD_ID_RE.test(value)
}

/** `b-` + 10 lowercase base36 characters (contract §3). Lowercase keeps rooms from splitting on NTFS/APFS. */
export function newBoardId(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let body = ''
  while (body.length < 10) {
    for (const byte of randomBytes(16)) {
      if (byte >= 252) continue // 252 = 7 * 36: rejection sampling keeps the distribution uniform
      body += alphabet[byte % 36]
      if (body.length === 10) break
    }
  }
  return `b-${body}`
}

/** Reads the dev identity from a query string. Invalid ids are treated as absent (never echoed back). */
export function parseDevIdentity(search: string): DevIdentity | null {
  const params = new URLSearchParams(search)
  const userId = params.get('user')
  if (!userId || !DEV_USER_RE.test(userId)) return null
  return { userId, role: params.get('role') === 'viewer' ? 'viewer' : 'editor' }
}

/** Normalizes a user-typed board reference: a bare id or a pasted board link. */
export function boardIdFromInput(input: string): string | null {
  const trimmed = input.trim()
  const fromPath = /(?:^|\/)b\/([^/?#]+)/.exec(trimmed)?.[1]
  const candidate = (fromPath ?? trimmed).toLowerCase()
  return isBoardId(candidate) ? candidate : null
}

// Readable on white and distinct from each other; presence colors come from here so every tab
// derives the same color for the same user id without any shared state.
const USER_COLORS = ['#c2410c', '#1d4ed8', '#047857', '#7c3aed', '#be123c', '#0e7490', '#a16207', '#4d7c0f']

export function colorForUser(userId: string): string {
  let h = 2166136261
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return USER_COLORS[(h >>> 0) % USER_COLORS.length] ?? '#1d4ed8'
}

export function initialsFor(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  const letters = parts.length >= 2 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : name.slice(0, 2)
  return letters.toUpperCase() || '?'
}
