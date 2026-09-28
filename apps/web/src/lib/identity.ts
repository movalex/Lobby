/**
 * The local-development guard: the Vite dev server, or a build made with VITE_DRAFTROOM_DEV_AUTH=1
 * (e2e). Since milestone 1 identity always comes from the API session; this guard only decides
 * whether debugging hooks such as `window.editor` are exposed.
 */
export const DEV_AUTH_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DRAFTROOM_DEV_AUTH === '1'

export const DEV_QUICK_PICKS = ['alice', 'bob', 'carol'] as const
export const DEV_HANDLE_RE = /^[a-z0-9-]{1,32}$/

// Readable on white and distinct from each other. Only a fallback: the API assigns each user a color.
const USER_COLORS = ['#c2410c', '#1d4ed8', '#047857', '#7c3aed', '#be123c', '#0e7490', '#a16207', '#4d7c0f']

export function colorForUser(userId: string): string {
  let h = 2166136261
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return USER_COLORS[(h >>> 0) % USER_COLORS.length] ?? '#1d4ed8'
}

/** A CSS color from the API, or the fallback when it is not a plain hex color (never injected raw). */
export function safeColor(color: string | null | undefined, userId: string): string {
  return typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : colorForUser(userId)
}

/** The words of a name, without punctuation: "O'Brien" is one word, "mary-jane" two. */
const nameWords = (s: string) =>
  s
    .split(/[\s._-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)

export function initialsFor(name: string): string {
  // Parenthesised parts are not the name: the guest marker ("Sam (guest)", wave 3) or a company
  // clients add ("Mara (Halden)", DANA2-04), also when a shortened name cut it ("Mara (Ha… (guest)").
  // Only when nothing else is left do they count.
  const parts = nameWords(name.replace(/\([^()]*\)/g, ' ').replace(/\([^()]*$/, ' '))
  const words = parts.length ? parts : nameWords(name)
  const [first = '', second = ''] = words
  const letters = second ? `${[...first][0]}${[...second][0]}` : [...first].slice(0, 2).join('')
  return letters.toUpperCase() || '?'
}
