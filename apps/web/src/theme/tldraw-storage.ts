// The canvas must open in the chosen theme on its very first frame. tldraw reads its user preferences
// once, from localStorage, when the board chunk first asks for them; the live sync (tldraw-sync.ts)
// can only be imported after the board chunk has loaded, and on a fast connection the canvas can mount
// before it has run (the theme e2e spec caught one light frame). So this module, which is in the
// startup bundle and has no tldraw import, also keeps tldraw's STORED colour scheme equal to the app's
// choice: tldraw then starts right, and the live sync takes over once it is loaded.
//
// This writes tldraw 5.4.2's own storage format (node_modules/@tldraw/editor/src/lib/config/
// TLUserPreferences.ts: key "TLDRAW_USER_DATA_v3", `{ version, user: TLUserPreferences }`, current
// version 13, `user.colorScheme` 'light' | 'dark' | 'system'). tldraw-storage.test.ts reads that file
// and fails if an upgrade changes any of it. Only `colorScheme` is changed; everything else tldraw
// stored is kept, and a value that does not parse is left alone.

import type { ThemeController, ThemePreference } from './theme.ts'

export const TLDRAW_PREFS_KEY = 'TLDRAW_USER_DATA_v3'
export const TLDRAW_PREFS_VERSION = 13

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

type Stored = { version: number; user: Record<string, unknown> & { id: string } }

function parse(raw: string | null): Stored | null | 'invalid' {
  if (raw === null) return null
  try {
    const data = JSON.parse(raw) as unknown
    if (typeof data !== 'object' || data === null) return 'invalid'
    const { version, user } = data as { version?: unknown; user?: unknown }
    if (typeof version !== 'number' || typeof user !== 'object' || user === null) return 'invalid'
    if (typeof (user as { id?: unknown }).id !== 'string') return 'invalid'
    return data as Stored
  } catch {
    return 'invalid'
  }
}

/** The colour scheme tldraw has stored, if any. */
export function storedTldrawScheme(raw: string | null): ThemePreference | undefined {
  const data = parse(raw)
  if (data === null || data === 'invalid') return undefined
  const scheme = data.user.colorScheme
  return scheme === 'light' || scheme === 'dark' || scheme === 'system' ? scheme : undefined
}

/** The stored value with `colorScheme` set, or null to leave the stored value alone. */
export function withTldrawScheme(
  raw: string | null,
  scheme: ThemePreference,
  newId: () => string,
): string | null {
  const data = parse(raw)
  if (data === 'invalid') return null
  if (data === null)
    return JSON.stringify({ version: TLDRAW_PREFS_VERSION, user: { id: newId(), colorScheme: scheme } })
  if (data.user.colorScheme === scheme) return null
  return JSON.stringify({ ...data, user: { ...data.user, colorScheme: scheme } })
}

/**
 * Run once at startup. A browser where nobody picked a theme in the app but tldraw holds an explicit
 * Light or Dark (tldraw's Ctrl/Cmd+/ was the only dark mode before) takes that as its choice;
 * otherwise tldraw's stored scheme is set to ours. From then on every change is written through.
 * Returns the unsubscribe.
 */
export function keepTldrawStorageInStep(
  theme: ThemeController,
  storage: KeyValueStorage | null,
  newId: () => string,
): () => void {
  if (!storage) return () => {}
  const write = () => {
    try {
      const next = withTldrawScheme(storage.getItem(TLDRAW_PREFS_KEY), theme.getPreference(), newId)
      if (next !== null) storage.setItem(TLDRAW_PREFS_KEY, next)
    } catch {
      // storage blocked or full: the live sync still applies the theme once the board has loaded
    }
  }
  let legacy: ThemePreference | undefined
  try {
    legacy = storedTldrawScheme(storage.getItem(TLDRAW_PREFS_KEY))
  } catch {
    legacy = undefined
  }
  if (!theme.hasStoredChoice() && (legacy === 'light' || legacy === 'dark')) theme.setPreference(legacy)
  else write()
  return theme.subscribe(write)
}
