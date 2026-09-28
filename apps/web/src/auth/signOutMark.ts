// The explicit sign-out mark (SCA-1, docs/SECURITY-REVIEW-2026-09-27.md). "Sign out", "Switch user"
// and "Sign out everywhere" set it in this tab's sessionStorage before anything else happens. While it
// is set, the sign-in page never trades a still-live Clerk session for a Draftroom session on its own:
// it asks "Continue as <name>" first (ClerkSignIn.tsx). Only a completed sign-in clears it.
//
// sessionStorage, not localStorage: the mark belongs to the tab the person signed out in, and survives a
// reload of it. Where storage is missing or throws (private windows, blocked site data), the mark is
// kept in memory for the page instead, so it still holds until the page is closed.

export const SIGNED_OUT_KEY = 'draftroom:signed-out'

/** What happened to the browser's Clerk session during the sign-out. */
export type ClerkSignOutState = 'pending' | 'ended' | 'failed' | 'none'

export interface SignedOutMark {
  /** When the sign-out started (ms since the epoch). */
  readonly at: number
  /** `none`: the server does not use Clerk. `failed`: the sign-in page warns that it may still be live. */
  readonly clerk: ClerkSignOutState
}

export interface MarkStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SignedOutMarks {
  read(): SignedOutMark | null
  set(mark: SignedOutMark): void
  clear(): void
}

const STATES: readonly ClerkSignOutState[] = ['pending', 'ended', 'failed', 'none']

/** null when absent. Present but unreadable (another version, edited by hand) still counts as set. */
export function parseSignedOutMark(raw: string | null): SignedOutMark | null {
  if (raw === null) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (v && typeof v === 'object') {
      const { at, clerk } = v as { at?: unknown; clerk?: unknown }
      if (typeof at === 'number' && Number.isFinite(at) && STATES.includes(clerk as ClerkSignOutState))
        return { at, clerk: clerk as ClerkSignOutState }
    }
  } catch {
    // fall through: err on the side of asking for a click
  }
  return { at: 0, clerk: 'pending' }
}

export function createSignedOutMarks(storage: () => MarkStorage | null | undefined): SignedOutMarks {
  // Mirrors the stored value, and stands in for storage that is missing or throws.
  let memory: string | null = null
  const tryStorage = <T>(fn: (s: MarkStorage) => T): T | null => {
    try {
      const s = storage()
      return s ? fn(s) : null
    } catch {
      return null // storage unavailable: `memory` holds the mark for this page
    }
  }
  return {
    read() {
      return parseSignedOutMark(tryStorage((s) => s.getItem(SIGNED_OUT_KEY)) ?? memory)
    },
    set(mark) {
      memory = JSON.stringify({ at: mark.at, clerk: mark.clerk })
      const value = memory
      tryStorage((s) => s.setItem(SIGNED_OUT_KEY, value))
    },
    clear() {
      memory = null
      tryStorage((s) => s.removeItem(SIGNED_OUT_KEY))
    },
  }
}

/** This tab's marks (there is no sessionStorage in unit tests: they build their own). */
export const signedOutMarks: SignedOutMarks = createSignedOutMarks(() =>
  typeof sessionStorage === 'undefined' ? null : sessionStorage,
)
